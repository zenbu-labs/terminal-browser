use std::io::{BufRead as _, BufReader, Write as _};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use crate::terminal::Waker;

#[cfg(target_os = "linux")]
mod wayland;
#[cfg(target_os = "linux")]
mod x11;

pub const PHASE_BEGAN: u32 = 1;

/// The compositor's scale for the sharpest connected screen, readable before any
/// window or engine exists, for callers that must pick a scale at process start.
pub fn display_scale() -> Option<f32> {
    #[cfg(target_os = "linux")]
    return wayland::scale_at(None);
    #[cfg(not(target_os = "linux"))]
    None
}

const KEEPALIVE: Duration = Duration::from_secs(2);

pub type Point = (f32, f32);
pub type Rect = (f32, f32, f32, f32);

#[derive(Clone, Copy)]
pub enum NativeEvent {
    Scroll {
        delta_x: f32,
        delta_y: f32,
        precise: bool,
        phase: u32,
        momentum: u32,
        point: Option<Point>,
    },
    Zoom {
        magnification: f32,
        point: Option<Point>,
    },
    Cursor {
        point: Point,
    },
    Window {
        rect: Option<Rect>,
    },
}

#[derive(Clone, Copy)]
enum Msg {
    Scale(f32),
    Event(NativeEvent),
}

impl Msg {
    fn wakes(&self) -> bool {
        !matches!(
            self,
            Msg::Event(NativeEvent::Cursor { .. } | NativeEvent::Window { .. })
        )
    }
}

/** Where the events come from: a helper process on macOS, the X server on Linux. */
enum Source {
    Helper {
        child: Child,
        stdin: Option<ChildStdin>,
    },
    #[cfg(target_os = "linux")]
    X11(x11::Handle),
}

impl Source {
    fn start() -> Option<(Self, f32)> {
        if let Some(path) = helper_path()
            && let Some(source) = spawn_helper(&path)
        {
            return Some((source, 2.0));
        }
        #[cfg(target_os = "linux")]
        return x11::start().map(|handle| {
            let scale = wayland::scale_at(handle.cursor_point()).unwrap_or(1.0);
            (Self::X11(handle), scale)
        });
        #[cfg(not(target_os = "linux"))]
        None
    }

    fn set_positions(&mut self, want: bool) {
        match self {
            Self::Helper { stdin, .. } => {
                let Some(pipe) = stdin.as_mut() else {
                    return;
                };
                let line: &[u8] = if want { b"positions 1\n" } else { b"positions 0\n" };
                if pipe.write_all(line).and_then(|()| pipe.flush()).is_err() {
                    *stdin = None;
                }
            }
            #[cfg(target_os = "linux")]
            Self::X11(handle) => handle.set_positions(want),
        }
    }

    fn stop(&mut self) {
        match self {
            Self::Helper { child, .. } => {
                let _ = child.kill();
            }
            #[cfg(target_os = "linux")]
            Self::X11(handle) => handle.stop(),
        }
    }
}

fn helper_path() -> Option<String> {
    std::env::var("NATIVE_SCROLL_HELPER")
        .ok()
        .or_else(|| option_env!("NATIVE_SCROLL_HELPER").map(String::from))
}

fn spawn_helper(path: &str) -> Option<Source> {
    let mut child = Command::new(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let stdin = child.stdin.take();
    std::thread::spawn(move || {
        read_lines(stdout);
        source_died();
    });
    Some(Source::Helper { child, stdin })
}

struct Shared {
    source: Source,
    subscribers: Vec<(Sender<Msg>, Option<Waker>)>,
    scale: f32,
    dead: bool,
    wanting: usize,
    armed_at: Option<Instant>,
}

impl Shared {
    fn sync_arming(&mut self) {
        let want = self.wanting > 0;
        let due = match (want, self.armed_at) {
            (true, Some(at)) => at.elapsed() > KEEPALIVE,
            (true, None) => true,
            (false, Some(_)) => true,
            (false, None) => false,
        };
        if !due {
            return;
        }
        self.armed_at = want.then(Instant::now);
        self.source.set_positions(want);
    }
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);

fn subscribe(waker: Option<Waker>) -> Option<(Receiver<Msg>, f32)> {
    let mut shared = SHARED.lock().unwrap();
    if shared.is_none() {
        let (source, scale) = Source::start()?;
        *shared = Some(Shared {
            source,
            subscribers: Vec::new(),
            scale,
            dead: false,
            wanting: 0,
            armed_at: None,
        });
    }
    let helper = shared.as_mut().unwrap();
    if helper.dead {
        return None;
    }
    let (tx, rx) = channel();
    helper.subscribers.push((tx, waker));
    Some((rx, helper.scale))
}

fn publish(msg: Msg) {
    let wakes = msg.wakes();
    let mut shared = SHARED.lock().unwrap();
    let Some(shared) = shared.as_mut() else {
        return;
    };
    if let Msg::Scale(scale) = msg {
        shared.scale = scale;
    }
    shared.subscribers.retain(|(tx, waker)| {
        let delivered = tx.send(msg).is_ok();
        if delivered && wakes && let Some(waker) = waker {
            waker.wake();
        }
        delivered
    });
}

fn source_died() {
    let mut shared = SHARED.lock().unwrap();
    if let Some(shared) = shared.as_mut() {
        shared.dead = true;
        shared.subscribers.clear();
    }
}

fn read_lines(stdout: std::process::ChildStdout) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else {
            return;
        };
        let fields: Vec<&str> = line.split_whitespace().collect();
        let msg = match fields.first().copied() {
            Some("scale") => field(&fields, 1).map(Msg::Scale),
            Some("s") => parse_scroll(&fields),
            Some("z") => field(&fields, 1).map(|magnification| {
                Msg::Event(NativeEvent::Zoom {
                    magnification,
                    point: parse_point(&fields, 2),
                })
            }),
            Some("m") => parse_point(&fields, 1).map(|point| Msg::Event(NativeEvent::Cursor { point })),
            Some("w") => Some(Msg::Event(NativeEvent::Window {
                rect: parse_rect(&fields),
            })),
            _ => None,
        };
        let Some(msg) = msg else {
            continue;
        };
        publish(msg);
    }
}

fn field<T: std::str::FromStr>(fields: &[&str], index: usize) -> Option<T> {
    fields.get(index)?.parse().ok()
}

fn parse_point(fields: &[&str], index: usize) -> Option<Point> {
    Some((field(fields, index)?, field(fields, index + 1)?))
}

fn parse_rect(fields: &[&str]) -> Option<Rect> {
    let (x, y) = parse_point(fields, 1)?;
    let (w, h) = parse_point(fields, 3)?;
    Some((x, y, w, h))
}

fn parse_scroll(fields: &[&str]) -> Option<Msg> {
    Some(Msg::Event(NativeEvent::Scroll {
        delta_y: field(fields, 1)?,
        phase: field(fields, 2).unwrap_or(0),
        momentum: field(fields, 3).unwrap_or(0),
        precise: fields.get(4).copied() == Some("1"),
        delta_x: field(fields, 5).unwrap_or(0.0),
        point: parse_point(fields, 6),
    }))
}

pub struct NativeScroll {
    rx: Receiver<Msg>,
    pub scale: f32,
    dead: bool,
    wants_positions: bool,
    synced_at: Option<Instant>,
}

impl NativeScroll {
    pub fn spawn(waker: Option<Waker>) -> Option<Self> {
        let (rx, scale) = subscribe(waker)?;
        Some(Self {
            rx,
            scale,
            dead: false,
            wants_positions: false,
            synced_at: None,
        })
    }

    pub fn drain(&mut self) -> Vec<NativeEvent> {
        let mut events = Vec::new();
        loop {
            match self.rx.try_recv() {
                Ok(Msg::Scale(scale)) => self.scale = scale,
                Ok(Msg::Event(event)) => events.push(event),
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    self.dead = true;
                    break;
                }
            }
        }
        events
    }

    pub fn request_positions(&mut self, want: bool) {
        if want == self.wants_positions
            && self.synced_at.is_some_and(|at| at.elapsed() < KEEPALIVE)
        {
            return;
        }
        self.synced_at = Some(Instant::now());
        let mut shared = SHARED.lock().unwrap();
        let Some(helper) = shared.as_mut() else {
            return;
        };
        if want != self.wants_positions {
            self.wants_positions = want;
            if want {
                helper.wanting += 1;
            } else {
                helper.wanting = helper.wanting.saturating_sub(1);
            }
        }
        helper.sync_arming();
    }

    /** The helper process exited (crash, EOF) — its events will never come. */
    pub fn dead(&self) -> bool {
        self.dead
    }
}

impl Drop for NativeScroll {
    fn drop(&mut self) {
        let mut shared = SHARED.lock().unwrap();
        let Some(helper) = shared.as_mut() else {
            return;
        };
        if self.wants_positions {
            helper.wanting = helper.wanting.saturating_sub(1);
            helper.sync_arming();
        }
        // subscribers are pruned lazily on send; stop the source only when the
        // last engine in the process is gone
        let scale = helper.scale;
        helper.subscribers.retain(|(tx, _)| tx.send(Msg::Scale(scale)).is_ok());
        if helper.subscribers.len() <= 1 {
            helper.source.stop();
            *shared = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scroll(line: &str) -> NativeEvent {
        let fields: Vec<&str> = line.split_whitespace().collect();
        match parse_scroll(&fields) {
            Some(Msg::Event(event)) => event,
            _ => panic!("did not parse: {line}"),
        }
    }

    #[test]
    fn a_scroll_line_carries_the_cursor_when_the_helper_sends_it() {
        let NativeEvent::Scroll {
            delta_y,
            delta_x,
            phase,
            precise,
            point,
            ..
        } = scroll("s 3.5 1 0 1 -2.0 400.5 350.25")
        else {
            panic!("expected a scroll")
        };
        assert_eq!((delta_y, delta_x), (3.5, -2.0));
        assert_eq!((phase, precise), (1, true));
        assert_eq!(point, Some((400.5, 350.25)));
    }

    #[test]
    fn a_scroll_line_without_a_cursor_still_parses() {
        let NativeEvent::Scroll { delta_y, delta_x, point, .. } = scroll("s 3.5 1 0 1") else {
            panic!("expected a scroll")
        };
        assert_eq!((delta_y, delta_x, point), (3.5, 0.0, None));

        let NativeEvent::Scroll { delta_x, point, .. } = scroll("s 3.5 1 0 1 -2.0") else {
            panic!("expected a scroll")
        };
        assert_eq!((delta_x, point), (-2.0, None));
    }

    #[test]
    fn imprecise_is_anything_but_one() {
        let NativeEvent::Scroll { precise, .. } = scroll("s 5 0 0 0") else {
            panic!("expected a scroll")
        };
        assert!(!precise);
    }

    #[test]
    fn a_window_line_parses_its_rect_or_its_absence() {
        let fields: Vec<&str> = "w 10 20 300 400".split_whitespace().collect();
        assert_eq!(parse_rect(&fields), Some((10.0, 20.0, 300.0, 400.0)));

        let fields: Vec<&str> = "w none".split_whitespace().collect();
        assert_eq!(parse_rect(&fields), None);
    }

    #[test]
    fn cursor_and_window_updates_do_not_wake_a_sleeping_engine() {
        assert!(!Msg::Event(NativeEvent::Cursor { point: (1.0, 2.0) }).wakes());
        assert!(!Msg::Event(NativeEvent::Window { rect: None }).wakes());
        assert!(Msg::Scale(2.0).wakes());
        assert!(Msg::Event(scroll("s 1 0 0 1")).wakes());
    }
}

use std::io::{BufRead as _, BufReader, Write as _};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use crate::tty::Waker;

pub const PHASE_BEGAN: u32 = 1;

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

struct SharedHelper {
    child: Child,
    stdin: Option<ChildStdin>,
    subscribers: Vec<(Sender<Msg>, Option<Waker>)>,
    scale: f32,
    dead: bool,
    wanting: usize,
    armed_at: Option<Instant>,
}

impl SharedHelper {
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
        let Some(stdin) = self.stdin.as_mut() else {
            return;
        };
        let line: &[u8] = if want { b"positions 1\n" } else { b"positions 0\n" };
        if stdin.write_all(line).and_then(|()| stdin.flush()).is_err() {
            self.stdin = None;
        }
    }
}

static SHARED: Mutex<Option<SharedHelper>> = Mutex::new(None);

fn helper_path() -> Option<String> {
    std::env::var("NATIVE_SCROLL_HELPER")
        .ok()
        .or_else(|| option_env!("NATIVE_SCROLL_HELPER").map(String::from))
}

fn spawn_helper() -> Option<SharedHelper> {
    let path = helper_path()?;
    let mut child = match Command::new(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            crate::logging::warn(
                "engine",
                format!("native scroll helper failed to start ({path}): {error}"),
            );
            return None;
        }
    };
    let stdout = child.stdout.take()?;
    let stdin = child.stdin.take();
    std::thread::spawn(move || {
        read_lines(stdout);
        let mut shared = SHARED.lock().unwrap();
        if let Some(helper) = shared.as_mut() {
            helper.dead = true;
            helper.subscribers.clear();
        }
    });
    Some(SharedHelper {
        child,
        stdin,
        subscribers: Vec::new(),
        scale: 2.0,
        dead: false,
        wanting: 0,
        armed_at: None,
    })
}

fn subscribe(waker: Option<Waker>) -> Option<Receiver<Msg>> {
    let mut shared = SHARED.lock().unwrap();
    if shared.is_none() {
        *shared = Some(spawn_helper()?);
    }
    let helper = shared.as_mut().unwrap();
    if helper.dead {
        return None;
    }
    let (tx, rx) = channel();
    let _ = tx.send(Msg::Scale(helper.scale));
    helper.subscribers.push((tx, waker));
    Some(rx)
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
        let wakes = msg.wakes();
        let mut shared = SHARED.lock().unwrap();
        let Some(helper) = shared.as_mut() else {
            return;
        };
        if let Msg::Scale(scale) = msg {
            helper.scale = scale;
        }
        helper.subscribers.retain(|(tx, waker)| {
            let delivered = tx
                .send(match msg {
                    Msg::Scale(scale) => Msg::Scale(scale),
                    Msg::Event(event) => Msg::Event(event),
                })
                .is_ok();
            if delivered && wakes && let Some(waker) = waker {
                waker.wake();
            }
            delivered
        });
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
        let rx = subscribe(waker)?;
        Some(Self {
            rx,
            scale: 2.0,
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
        // subscribers are pruned lazily on send; kill the child only when the
        // last engine in the process is gone
        let scale = helper.scale;
        helper.subscribers.retain(|(tx, _)| tx.send(Msg::Scale(scale)).is_ok());
        if helper.subscribers.len() <= 1 {
            let _ = helper.child.kill();
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

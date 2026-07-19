use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};

use crate::terminal::Waker;

/// NSEvent.phase "began" bit as the helper reports it; a new finger-down
/// gesture always starts with it, which is when pairing state resets.
pub const PHASE_BEGAN: u32 = 1;

#[derive(Clone, Copy)]
pub enum NativeDelta {
    Scroll {
        delta_x: f32,
        delta_y: f32,
        precise: bool,
        /// NSEvent.phase — began/changed/ended of the finger-down gesture
        phase: u32,
        /// NSEvent.momentumPhase — the coast after the fingers lift
        momentum: u32,
    },
    // Trackpad pinch: NSEvent.magnification, the fractional scale change for
    // this event (a full gesture sums to roughly ±1..3).
    Zoom {
        magnification: f32,
    },
}

enum Msg {
    Scale(f32),
    Delta(NativeDelta),
}

/// One helper process per engine would register one global event monitor per
/// pane; the daemon multiplies that. The process shares a single helper and
/// fans its events out to every subscribed engine.
struct SharedHelper {
    child: Child,
    subscribers: Vec<(Sender<Msg>, Option<Waker>)>,
    scale: f32,
    dead: bool,
}

static SHARED: Mutex<Option<SharedHelper>> = Mutex::new(None);

fn subscribe(waker: Option<Waker>) -> Option<Receiver<Msg>> {
    let mut shared = SHARED.lock().unwrap();
    if shared.is_none() {
        let path = std::env::var("NATIVE_SCROLL_HELPER")
            .ok()
            .or_else(|| option_env!("NATIVE_SCROLL_HELPER").map(String::from))?;
        let mut child = Command::new(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdout = child.stdout.take()?;
        std::thread::spawn(move || {
            read_lines(stdout);
            let mut shared = SHARED.lock().unwrap();
            if let Some(helper) = shared.as_mut() {
                helper.dead = true;
                helper.subscribers.clear();
            }
        });
        *shared = Some(SharedHelper {
            child,
            subscribers: Vec::new(),
            scale: 2.0,
            dead: false,
        });
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
        let msg = match fields[..] {
            ["scale", scale] => scale.parse().ok().map(Msg::Scale),
            ["s", delta, phase, momentum, precise] => parse_scroll(delta, "0", phase, momentum, precise),
            ["s", delta, phase, momentum, precise, delta_x] => {
                parse_scroll(delta, delta_x, phase, momentum, precise)
            }
            ["z", magnification] => magnification
                .parse()
                .ok()
                .map(|magnification| Msg::Delta(NativeDelta::Zoom { magnification })),
            _ => None,
        };
        let Some(msg) = msg else {
            continue;
        };
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
                    Msg::Delta(delta) => Msg::Delta(delta),
                })
                .is_ok();
            if delivered && let Some(waker) = waker {
                waker.wake();
            }
            delivered
        });
    }
}

fn parse_scroll(delta: &str, delta_x: &str, phase: &str, momentum: &str, precise: &str) -> Option<Msg> {
    let delta_y: f32 = delta.parse().ok()?;
    Some(Msg::Delta(NativeDelta::Scroll {
        delta_x: delta_x.parse().unwrap_or(0.0),
        delta_y,
        precise: precise == "1",
        phase: phase.parse().unwrap_or(0),
        momentum: momentum.parse().unwrap_or(0),
    }))
}

pub struct NativeScroll {
    rx: Receiver<Msg>,
    pub scale: f32,
    dead: bool,
}

impl NativeScroll {
    pub fn spawn(waker: Option<Waker>) -> Option<Self> {
        let rx = subscribe(waker)?;
        Some(Self {
            rx,
            scale: 2.0,
            dead: false,
        })
    }

    pub fn drain(&mut self) -> Vec<NativeDelta> {
        let mut deltas = Vec::new();
        loop {
            match self.rx.try_recv() {
                Ok(Msg::Scale(scale)) => self.scale = scale,
                Ok(Msg::Delta(delta)) => deltas.push(delta),
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    self.dead = true;
                    break;
                }
            }
        }
        deltas
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

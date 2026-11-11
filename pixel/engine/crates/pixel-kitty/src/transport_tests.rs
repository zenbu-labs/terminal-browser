use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::time::{Duration, Instant};

use super::*;

#[derive(Default)]
struct Env(HashMap<String, String>);

impl Vars for Env {
    fn var(&self, key: &str) -> Option<String> {
        self.0.get(key).cloned()
    }
}

struct PtyTty {
    file: std::fs::File,
    wrapper: Wrapper,
    pending: Vec<u8>,
}

impl Tty for PtyTty {
    fn output(&self) -> io::Result<Output> {
        Ok(Output::new(Box::new(self.file.try_clone()?), Some(self.file.try_clone()?)))
    }

    fn read_reply(
        &mut self,
        timeout_ms: u64,
        keep_input: bool,
        find: &mut dyn FnMut(&[u8]) -> Option<std::ops::Range<usize>>,
    ) -> io::Result<bool> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let start = self.pending.len();
        loop {
            if let Some(range) = find(&self.pending[start..]) {
                if keep_input {
                    self.pending.drain(start + range.start..start + range.end);
                } else {
                    self.pending.truncate(start);
                }
                return Ok(true);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                if !keep_input {
                    self.pending.truncate(start);
                }
                return Ok(false);
            }
            let mut fds = [rustix::event::PollFd::new(&self.file, rustix::event::PollFlags::IN)];
            let timeout = rustix::event::Timespec::try_from(left).unwrap();
            if rustix::event::poll(&mut fds, Some(&timeout))? == 0 {
                continue;
            }
            let mut chunk = [0u8; 256];
            let n = self.file.read(&mut chunk)?;
            self.pending.extend_from_slice(&chunk[..n]);
        }
    }

    fn host_send(&mut self, _message: serde_json::Value) -> io::Result<()> {
        Ok(())
    }

    fn host(&self) -> Option<Host> {
        None
    }

    fn wrapper(&self) -> Wrapper {
        self.wrapper
    }

    fn cell(&self) -> Option<(u32, u32)> {
        None
    }

    fn screen(&self) -> Option<Screen> {
        None
    }
}

fn open_pty() -> (std::fs::File, std::fs::File) {
    let mut master: libc::c_int = 0;
    let mut slave: libc::c_int = 0;
    #[allow(unsafe_code)]
    let ok = unsafe {
        libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut())
    };
    assert_eq!(ok, 0, "openpty failed");
    #[allow(unsafe_code)]
    unsafe {
        use std::os::unix::io::FromRawFd as _;
        (std::fs::File::from_raw_fd(master), std::fs::File::from_raw_fd(slave))
    }
}

fn graphics_error(seen: &[u8]) -> Option<Vec<u8>> {
    let start = seen.windows(3).rposition(|w| w == b"\x1b_G")? + 3;
    let control = seen[start..].split(|&b| b == b';').next()?;
    let mut action = None;
    let mut id = None;
    for pair in std::str::from_utf8(control).ok()?.split(',') {
        match pair.split_once('=') {
            Some(("a", value)) => action = Some(value),
            Some(("i", value)) => id = value.parse::<u32>().ok(),
            _ => {}
        }
    }
    let error = match action? {
        "q" => "ENOENT:no such medium",
        "f" => "EINVAL:no such action",
        _ => return None,
    };
    Some(format!("\x1b_Gi={};{error}\x1b\\", id?).into_bytes())
}

#[test]
fn two_renderers_in_one_process_name_their_frames_apart() {
    let output = || Output::new(Box::new(io::sink()), None);
    let a = Kitty::blank(output(), Wrapper::None, None);
    let b = Kitty::blank(output(), Wrapper::None, None);
    assert_ne!(a.terminal_id, b.terminal_id);
    assert_ne!(a.shm_name(0), b.shm_name(0));
}

struct FakeTmuxClient {
    attached: std::sync::Arc<std::sync::atomic::AtomicBool>,
    probes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

fn transport_terminal(
    wrapper: Wrapper,
    attached: bool,
    shared: bool,
    file: bool,
) -> (Kitty, PtyTty, FakeTmuxClient) {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    let (master, slave) = open_pty();
    let mut raw = rustix::termios::tcgetattr(&slave).unwrap();
    raw.make_raw();
    rustix::termios::tcsetattr(&slave, rustix::termios::OptionalActions::Now, &raw).unwrap();
    let tty = PtyTty { file: slave, wrapper, pending: Vec::new() };
    let term = Kitty::blank(tty.output().unwrap(), wrapper, None);
    let client = FakeTmuxClient {
        attached: Arc::new(AtomicBool::new(attached)),
        probes: Arc::new(AtomicUsize::new(0)),
    };
    let attached = client.attached.clone();
    let probes = client.probes.clone();
    let mut reader = master;
    std::thread::spawn(move || {
        let mut seen = Vec::new();
        let mut byte = [0u8; 1];
        while reader.read_exact(&mut byte).is_ok() {
            seen.push(byte[0]);
            if !seen.ends_with(b"\x1b\\") {
                continue;
            }
            if let Some(error) = graphics_error(&seen) {
                probes.fetch_add(1, Ordering::SeqCst);
                if attached.load(Ordering::SeqCst) {
                    let (id, supported) = if parse_probe_reply(&error, b"Gi=299;").is_some() {
                        (299, shared)
                    } else {
                        (300, file)
                    };
                    let answer = if supported { "OK" } else { "ENOENT:not found" };
                    if reader
                        .write_all(format!("x\x1b_Gi={id};{answer}\x1b\\").as_bytes())
                        .is_err()
                    {
                        break;
                    }
                }
            }
            seen.clear();
        }
    });
    (term, tty, client)
}

#[test]
fn unanswered_tmux_transport_is_retried_on_focus() {
    for (shared, expected) in [(true, FrameTransport::Shared), (false, FrameTransport::File)] {
        let (mut term, mut tty, client) = transport_terminal(Wrapper::Tmux, false, shared, true);
        term.transport = term
            .probe_transport(&mut tty, &Env::default())
            .unwrap();
        assert!(term.frames_are_inline());
        assert_eq!(term.transport_retry, TransportRetry::Ready);
        client.attached.store(true, std::sync::atomic::Ordering::SeqCst);
        term.retry_frame_transport(&mut tty, true).unwrap();
        assert_eq!(term.transport, expected);
        assert_eq!(term.transport_retry, TransportRetry::Settled);
        assert!(
            tty.pending.starts_with(b"x") && tty.pending.iter().all(|&b| b == b'x'),
            "keys typed beside the replies stay in the input: {:?}",
            tty.pending
        );
    }
}

#[test]
fn settled_transports_are_not_retried() {
    for (wrapper, attached, setting, expected) in [
        (Wrapper::Tmux, true, None, FrameTransport::Inline),
        (Wrapper::None, false, None, FrameTransport::Inline),
        (Wrapper::Tmux, false, Some(("SSH_CONNECTION", "remote")), FrameTransport::Inline),
        (Wrapper::Tmux, false, Some(("TERMINAL_BROWSER_FRAMES", "inline")), FrameTransport::Inline),
        (Wrapper::Tmux, false, Some(("TERMINAL_BROWSER_FRAMES", "shm")), FrameTransport::Shared),
        (Wrapper::Tmux, false, Some(("TERMINAL_BROWSER_FRAMES", "file")), FrameTransport::File),
    ] {
        let (mut term, mut tty, client) = transport_terminal(wrapper, attached, false, false);
        let env = Env(setting.into_iter().map(|(key, value)| (key.into(), value.into())).collect());
        term.transport = term.probe_transport(&mut tty, &env).unwrap();
        assert_eq!(term.transport, expected, "{wrapper:?} {setting:?}");
        assert_eq!(term.transport_retry, TransportRetry::Settled, "{wrapper:?} {setting:?}");
        let probes = client.probes.load(std::sync::atomic::Ordering::SeqCst);
        term.retry_frame_transport(&mut tty, true).unwrap();
        term.retry_frame_transport(&mut tty, false).unwrap();
        assert_eq!(client.probes.load(std::sync::atomic::Ordering::SeqCst), probes);
        assert_eq!(term.transport, expected);
    }
}

#[test]
fn unanswered_retries_are_bounded() {
    use std::sync::atomic::Ordering;
    let (mut term, mut tty, client) = transport_terminal(Wrapper::Tmux, false, false, false);
    term.transport = term
        .probe_transport(&mut tty, &Env::default())
        .unwrap();
    assert_eq!(client.probes.load(Ordering::SeqCst), 2);

    term.retry_frame_transport(&mut tty, false).unwrap();
    assert_eq!(client.probes.load(Ordering::SeqCst), 4, "the first resize asks again");
    term.retry_frame_transport(&mut tty, false).unwrap();
    assert_eq!(client.probes.load(Ordering::SeqCst), 4, "a resize within a second does not");

    term.retry_frame_transport(&mut tty, true).unwrap();
    assert_eq!(client.probes.load(Ordering::SeqCst), 6, "a focus-in asks right away");
    assert_eq!(term.transport_retry, TransportRetry::Settled);
    term.retry_frame_transport(&mut tty, true).unwrap();
    term.retry_frame_transport(&mut tty, false).unwrap();
    assert_eq!(client.probes.load(Ordering::SeqCst), 6, "a silent focus-in ends the retries");
    assert!(term.frames_are_inline());
}

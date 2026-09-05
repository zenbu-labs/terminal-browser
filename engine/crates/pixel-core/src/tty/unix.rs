use std::io;
use std::time::Duration;

use rustix::fd::{AsFd as _, AsRawFd as _, BorrowedFd, OwnedFd};
use rustix::termios::{self, OptionalActions, Termios};

use crate::terminal::WindowSize;

fn retry_intr<T>(mut call: impl FnMut() -> rustix::io::Result<T>) -> rustix::io::Result<T> {
    loop {
        match call() {
            Err(rustix::io::Errno::INTR) => continue,
            other => return other,
        }
    }
}

const RESIZE_WAKE_SLOTS: usize = 64;
static RESIZE_WAKE_FDS: [std::sync::atomic::AtomicI32; RESIZE_WAKE_SLOTS] =
    [const { std::sync::atomic::AtomicI32::new(-1) }; RESIZE_WAKE_SLOTS];

fn claim_resize_slot(fd: i32) -> Option<usize> {
    for (i, slot) in RESIZE_WAKE_FDS.iter().enumerate() {
        if slot
            .compare_exchange(
                -1,
                fd,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
        {
            return Some(i);
        }
    }
    None
}

#[allow(unsafe_code)]
extern "C" fn sigwinch_handler(_: libc::c_int) {
    for slot in &RESIZE_WAKE_FDS {
        let fd = slot.load(std::sync::atomic::Ordering::Relaxed);
        if fd >= 0 {
            unsafe {
                libc::write(fd, [1u8].as_ptr().cast(), 1);
            }
        }
    }
}

#[derive(Clone)]
pub struct Waker {
    fd: std::sync::Arc<OwnedFd>,
}

impl Waker {
    pub fn wake(&self) {
        let _ = rustix::io::write(&*self.fd, &[1]);
    }
}

enum Handle {
    Stdio {
        stdin: io::Stdin,
        stdout: io::Stdout,
    },
    File(std::fs::File),
}

pub(crate) struct Tty {
    handle: Handle,
    saved: Termios,
    wake_rx: Option<OwnedFd>,
    waker: Option<Waker>,
    resize_slot: Option<usize>,
}

impl Tty {
    pub(crate) fn stdio() -> io::Result<Self> {
        Self::raw(Handle::Stdio {
            stdin: io::stdin(),
            stdout: io::stdout(),
        })
    }

    pub(crate) fn open(path: &str) -> io::Result<Self> {
        let file = std::fs::File::options().read(true).write(true).open(path)?;
        Self::raw(Handle::File(file))
    }

    fn raw(handle: Handle) -> io::Result<Self> {
        let saved = retry_intr(|| termios::tcgetattr(&fd_of(&handle)))?;
        let mut raw = saved.clone();
        raw.make_raw();
        retry_intr(|| termios::tcsetattr(&fd_of(&handle), OptionalActions::Drain, &raw))?;
        Ok(Self {
            handle,
            saved,
            wake_rx: None,
            waker: None,
            resize_slot: None,
        })
    }

    pub(crate) fn out(&mut self) -> &mut dyn io::Write {
        match &mut self.handle {
            Handle::Stdio { stdout, .. } => stdout,
            Handle::File(file) => file,
        }
    }

    pub(crate) fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        rustix::io::read(fd_of(&self.handle), buf).map_err(io::Error::from)
    }

    pub(crate) fn window_size(&self) -> io::Result<WindowSize> {
        let ws = retry_intr(|| termios::tcgetwinsize(&fd_of(&self.handle)))?;
        Ok(WindowSize {
            cols: u32::from(ws.ws_col),
            rows: u32::from(ws.ws_row),
            width_px: u32::from(ws.ws_xpixel),
            height_px: u32::from(ws.ws_ypixel),
        })
    }

    pub(crate) fn waker(&mut self) -> io::Result<Waker> {
        if let Some(waker) = &self.waker {
            return Ok(waker.clone());
        }
        let (rx, tx) = rustix::pipe::pipe()?;
        rustix::fs::fcntl_setfl(&rx, rustix::fs::OFlags::NONBLOCK)?;
        rustix::fs::fcntl_setfl(&tx, rustix::fs::OFlags::NONBLOCK)?;
        self.wake_rx = Some(rx);
        let waker = Waker {
            fd: std::sync::Arc::new(tx),
        };
        self.waker = Some(waker.clone());
        Ok(waker)
    }

    #[allow(unsafe_code)]
    pub(crate) fn watch_resize(&mut self) -> io::Result<()> {
        let waker = self.waker()?;
        self.resize_slot = claim_resize_slot(waker.fd.as_raw_fd());
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = sigwinch_handler as *const () as usize;
            action.sa_flags = libc::SA_RESTART;
            if libc::sigaction(libc::SIGWINCH, &action, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn resize_slot(&self) -> Option<usize> {
        self.resize_slot
    }

    #[cfg(test)]
    pub(crate) fn resize_slot_is_free(slot: usize) -> bool {
        RESIZE_WAKE_FDS[slot].load(std::sync::atomic::Ordering::Relaxed) < 0
    }

    pub(crate) fn wait_for_input(&self, wait: Option<Duration>) -> io::Result<bool> {
        let timeout = match wait {
            Some(w) => Some(
                rustix::event::Timespec::try_from(w)
                    .map_err(|_| io::Error::other("timeout out of range"))?,
            ),
            None => None,
        };
        let poll = |fds: &mut [rustix::event::PollFd<'_>]| match rustix::event::poll(
            fds,
            timeout.as_ref(),
        ) {
            Ok(n) => Ok(n),
            Err(rustix::io::Errno::INTR) => Ok(0),
            Err(e) => Err(io::Error::from(e)),
        };
        let stdin_borrow = fd_of(&self.handle);
        let stdin_fd = rustix::event::PollFd::new(&stdin_borrow, rustix::event::PollFlags::IN);
        match &self.wake_rx {
            None => {
                let mut fds = [stdin_fd];
                Ok(poll(&mut fds)? > 0)
            }
            Some(wake) => {
                let mut fds = [
                    stdin_fd,
                    rustix::event::PollFd::new(wake, rustix::event::PollFlags::IN),
                ];
                poll(&mut fds)?;
                if fds[1].revents().contains(rustix::event::PollFlags::IN) {
                    let mut sink = [0u8; 64];
                    while matches!(rustix::io::read(wake, &mut sink), Ok(n) if n > 0) {}
                }
                Ok(fds[0].revents().contains(rustix::event::PollFlags::IN))
            }
        }
    }
}

fn fd_of(handle: &Handle) -> BorrowedFd<'_> {
    match handle {
        Handle::Stdio { stdin, .. } => stdin.as_fd(),
        Handle::File(file) => file.as_fd(),
    }
}

impl Drop for Tty {
    fn drop(&mut self) {
        if let Some(slot) = self.resize_slot.take() {
            RESIZE_WAKE_FDS[slot].store(-1, std::sync::atomic::Ordering::Release);
        }
        let _ = retry_intr(|| {
            termios::tcsetattr(&fd_of(&self.handle), OptionalActions::Flush, &self.saved)
        });
    }
}

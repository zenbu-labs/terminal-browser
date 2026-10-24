use std::io;
use std::time::Duration;

use rustix::fd::AsFd as _;
use rustix::termios::{self, OptionalActions, Termios};

use super::super::{TtyHandle, WindowSize};

pub(crate) type HostStream = std::os::unix::net::UnixStream;

fn retry_intr<T>(mut call: impl FnMut() -> rustix::io::Result<T>) -> rustix::io::Result<T> {
    loop {
        match call() {
            Err(rustix::io::Errno::INTR) => continue,
            other => return other,
        }
    }
}

pub(in crate::terminal) struct RawMode(Termios);

impl TtyHandle {
    fn read_fd(&self) -> rustix::fd::BorrowedFd<'_> {
        match self {
            TtyHandle::Stdio { stdin, .. } => stdin.as_fd(),
            TtyHandle::File(file) => file.as_fd(),
            TtyHandle::Hosted { stream, .. } => stream.as_fd(),
            TtyHandle::Embedded { stream, .. } => stream.as_fd(),
        }
    }

    pub(in crate::terminal) fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        rustix::io::read(self.read_fd(), buf).map_err(io::Error::from)
    }

    pub(in crate::terminal) fn enter_raw_mode(&self) -> io::Result<RawMode> {
        let step =
            |name: &str, error: io::Error| io::Error::new(error.kind(), format!("{name}: {error}"));
        let saved = retry_intr(|| termios::tcgetattr(self.read_fd()))
            .map_err(|e| step("tcgetattr", e.into()))?;
        let mut raw = saved.clone();
        raw.make_raw();
        retry_intr(|| termios::tcsetattr(self.read_fd(), OptionalActions::Drain, &raw))
            .map_err(|e| step("tcsetattr", e.into()))?;
        Ok(RawMode(saved))
    }

    pub(in crate::terminal) fn leave_raw_mode(&self, saved: &RawMode) {
        let _ = retry_intr(|| termios::tcsetattr(self.read_fd(), OptionalActions::Flush, &saved.0));
    }

    pub(in crate::terminal) fn window_size(&self) -> io::Result<WindowSize> {
        let ws = retry_intr(|| termios::tcgetwinsize(self.read_fd()))?;
        Ok(window_size_of(&ws))
    }

    #[allow(unsafe_code)]
    pub(in crate::terminal) fn unread_output(&self) -> Option<usize> {
        use rustix::fd::AsRawFd as _;
        let fd = match self {
            TtyHandle::File(file) => file.as_raw_fd(),
            TtyHandle::Embedded { tty, .. } => tty.as_raw_fd(),
            _ => return None,
        };
        let mut count: libc::c_int = 0;
        // SAFETY: TIOCOUTQ stores one c_int through the pointer; the fd is open and ours.
        let rc = unsafe { libc::ioctl(fd, libc::TIOCOUTQ, &mut count) };
        (rc == 0).then(|| count.max(0) as usize)
    }

    pub(in crate::terminal) fn wait_readable(
        &self,
        wake: Option<&WakeRx>,
        wait: Option<Duration>,
    ) -> io::Result<bool> {
        let timeout = timespec(wait)?;
        let poll = |fds: &mut [rustix::event::PollFd<'_>]| match rustix::event::poll(
            fds,
            timeout.as_ref(),
        ) {
            Ok(n) => Ok(n),
            Err(rustix::io::Errno::INTR) => Ok(0),
            Err(e) => Err(io::Error::from(e)),
        };
        let input = self.read_fd();
        let input = rustix::event::PollFd::new(&input, rustix::event::PollFlags::IN);
        match wake {
            None => {
                let mut fds = [input];
                Ok(poll(&mut fds)? > 0)
            }
            Some(wake) => {
                let mut fds = [
                    input,
                    rustix::event::PollFd::new(&wake.0, rustix::event::PollFlags::IN),
                ];
                poll(&mut fds)?;
                if fds[1].revents().contains(rustix::event::PollFlags::IN) {
                    wake.drain();
                }
                Ok(fds[0].revents().contains(rustix::event::PollFlags::IN))
            }
        }
    }
}

fn window_size_of(ws: &termios::Winsize) -> WindowSize {
    WindowSize {
        cols: u32::from(ws.ws_col),
        rows: u32::from(ws.ws_row),
        width_px: u32::from(ws.ws_xpixel),
        height_px: u32::from(ws.ws_ypixel),
    }
}

fn timespec(wait: Option<Duration>) -> io::Result<Option<rustix::event::Timespec>> {
    wait.map(|w| {
        rustix::event::Timespec::try_from(w).map_err(|_| io::Error::other("timeout out of range"))
    })
    .transpose()
}

pub(in crate::terminal) fn open_tty(path: &str) -> io::Result<std::fs::File> {
    std::fs::File::options().read(true).write(true).open(path)
}

pub(in crate::terminal) fn open_embedded_tty(path: &str) -> io::Result<std::fs::File> {
    let tty = open_tty(path)?;
    rustix::fs::fcntl_setfl(
        &tty,
        rustix::fs::fcntl_getfl(&tty)? | rustix::fs::OFlags::NONBLOCK,
    )?;
    Ok(tty)
}

pub(in crate::terminal) fn cell_size_of_tty(tty: &std::fs::File) -> Option<(u32, u32)> {
    window_size_of(&termios::tcgetwinsize(tty).ok()?).cell_size()
}

pub(in crate::terminal) struct WakeRx(rustix::fd::OwnedFd);

impl WakeRx {
    fn drain(&self) {
        let mut sink = [0u8; 64];
        while matches!(rustix::io::read(&self.0, &mut sink), Ok(n) if n > 0) {}
    }

    pub(in crate::terminal) fn wait(&self, wait: Option<Duration>) -> io::Result<()> {
        let timeout = timespec(wait)?;
        let mut fds = [rustix::event::PollFd::new(
            &self.0,
            rustix::event::PollFlags::IN,
        )];
        match rustix::event::poll(&mut fds, timeout.as_ref()) {
            Ok(_) | Err(rustix::io::Errno::INTR) => {}
            Err(e) => return Err(e.into()),
        }
        if fds[0].revents().contains(rustix::event::PollFlags::IN) {
            self.drain();
        }
        Ok(())
    }
}

pub(crate) struct WakeTx(rustix::fd::OwnedFd);

impl WakeTx {
    pub(crate) fn wake(&self) {
        let _ = rustix::io::write(&self.0, &[1]);
    }
}

pub(in crate::terminal) fn wake_pair() -> io::Result<(WakeRx, WakeTx)> {
    let (rx, tx) = rustix::pipe::pipe()?;
    rustix::fs::fcntl_setfl(&rx, rustix::fs::OFlags::NONBLOCK)?;
    rustix::fs::fcntl_setfl(&tx, rustix::fs::OFlags::NONBLOCK)?;
    Ok((WakeRx(rx), WakeTx(tx)))
}

const RESIZE_WAKE_SLOTS: usize = 64;
static RESIZE_WAKE_FDS: [std::sync::atomic::AtomicI32; RESIZE_WAKE_SLOTS] =
    [const { std::sync::atomic::AtomicI32::new(-1) }; RESIZE_WAKE_SLOTS];

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

pub(in crate::terminal) struct ResizeWatch(Option<usize>);

impl Drop for ResizeWatch {
    fn drop(&mut self) {
        if let Some(slot) = self.0 {
            RESIZE_WAKE_FDS[slot].store(-1, std::sync::atomic::Ordering::Release);
        }
    }
}

#[allow(unsafe_code)]
pub(in crate::terminal) fn watch_resize(tx: &WakeTx) -> io::Result<ResizeWatch> {
    use rustix::fd::AsRawFd as _;
    let fd = tx.0.as_raw_fd();
    let slot = RESIZE_WAKE_FDS.iter().position(|slot| {
        slot.compare_exchange(
            -1,
            fd,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Relaxed,
        )
        .is_ok()
    });
    let watch = ResizeWatch(slot);
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = sigwinch_handler as *const () as usize;
        action.sa_flags = libc::SA_RESTART;
        if libc::sigaction(libc::SIGWINCH, &action, std::ptr::null_mut()) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(watch)
}

#[allow(unsafe_code)]
pub(crate) struct FrameFile {
    pub(crate) path: std::path::PathBuf,
    map: std::ptr::NonNull<u8>,
    pub(crate) len: usize,
}

#[allow(unsafe_code, clippy::undocumented_unsafe_blocks)]
impl FrameFile {
    pub(crate) fn create(path: std::path::PathBuf, len: usize) -> io::Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::remove_file(&path);
        let file = std::fs::File::options()
            .mode(0o600)
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        rustix::fs::ftruncate(&file, len as u64)?;
        let map = unsafe {
            rustix::mm::mmap(
                std::ptr::null_mut(),
                len,
                rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE,
                rustix::mm::MapFlags::SHARED,
                &file,
                0,
            )?
        };
        let map = std::ptr::NonNull::new(map.cast::<u8>())
            .ok_or_else(|| io::Error::other("frame file mapped to nothing"))?;
        unsafe { std::ptr::write_bytes(map.as_ptr(), 0, len) };
        Ok(Self { path, map, len })
    }

    pub(crate) fn write(&mut self, data: &[u8]) {
        unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), self.map.as_ptr(), self.len) };
    }

    pub(crate) fn write_bgra(&mut self, data: &[u8]) {
        let len = self.len.min(data.len());
        let target = unsafe { std::slice::from_raw_parts_mut(self.map.as_ptr(), len) };
        super::swap_bgra_into(target, &data[..len]);
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[allow(unsafe_code, clippy::undocumented_unsafe_blocks)]
impl Drop for FrameFile {
    fn drop(&mut self) {
        unsafe {
            let _ = rustix::mm::munmap(self.map.as_ptr().cast(), self.len);
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) fn write_shm(name: &str, data: &[u8]) -> io::Result<()> {
    let fd = open_shm(name, data.len())?;
    fill_shm(&fd, data.len(), |out| out.copy_from_slice(data))
}

pub(crate) fn unlink_shm(name: &str) {
    let _ = rustix::shm::unlink(name);
}

pub(in crate::terminal) struct Shm(rustix::fd::OwnedFd);

pub(in crate::terminal) fn open_shm(name: &str, len: usize) -> io::Result<Shm> {
    let fd = rustix::shm::open(
        name,
        rustix::shm::OFlags::CREATE | rustix::shm::OFlags::EXCL | rustix::shm::OFlags::RDWR,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )?;
    rustix::fs::ftruncate(&fd, len as u64)?;
    Ok(Shm(fd))
}

#[allow(unsafe_code)]
pub(in crate::terminal) fn fill_shm(
    shm: &Shm,
    len: usize,
    fill: impl FnOnce(&mut [u8]),
) -> io::Result<()> {
    unsafe {
        let ptr = rustix::mm::mmap(
            std::ptr::null_mut(),
            len,
            rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE,
            rustix::mm::MapFlags::SHARED,
            &shm.0,
            0,
        )?;
        fill(std::slice::from_raw_parts_mut(ptr.cast::<u8>(), len));
        rustix::mm::munmap(ptr, len)?;
    }
    Ok(())
}

impl ResizeWatch {
    #[cfg(test)]
    pub(in crate::terminal) fn slot(&self) -> Option<usize> {
        self.0
    }
}

#[cfg(test)]
pub(in crate::terminal) fn resize_slot_is_free(slot: usize) -> bool {
    RESIZE_WAKE_FDS[slot].load(std::sync::atomic::Ordering::Relaxed) == -1
}

#[cfg(test)]
pub(crate) type HostListener = std::os::unix::net::UnixListener;

pub(in crate::terminal) fn attach_console() -> io::Result<()> {
    Ok(())
}

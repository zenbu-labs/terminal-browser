#[cfg(unix)]
#[path = "tty/unix.rs"]
mod imp;

#[cfg(windows)]
#[path = "tty/windows.rs"]
mod imp;

pub(crate) use imp::Tty;
#[cfg(windows)]
pub(crate) use imp::Probe;
#[cfg(unix)]
pub(crate) use imp::Tty as Probe;
pub use imp::Waker;

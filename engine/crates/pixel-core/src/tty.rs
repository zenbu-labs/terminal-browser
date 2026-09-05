#[cfg(unix)]
#[path = "tty/unix.rs"]
mod imp;

#[cfg(windows)]
#[path = "tty/windows.rs"]
mod imp;

pub(crate) use imp::Tty;
pub use imp::Waker;

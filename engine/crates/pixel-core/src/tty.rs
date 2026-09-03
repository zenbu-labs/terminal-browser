#[path = "tty/unix.rs"]
mod imp;

pub(crate) use imp::Tty;
pub use imp::Waker;

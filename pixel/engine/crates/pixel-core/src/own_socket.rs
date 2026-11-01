#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;

// Connects to a Unix socket and keeps the connection only if the kernel says
// the process serving it runs as our user, so a socket another user put in
// its place never sees what we would send.
pub(crate) fn connect_own(path: &str) -> io::Result<UnixStream> {
    connect_as(path, unsafe { libc::geteuid() })
}

fn connect_as(path: &str, uid: libc::uid_t) -> io::Result<UnixStream> {
    let stream = UnixStream::connect(path)?;
    if peer_uid(&stream)? != uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{path} is served by another user"),
        ));
    }
    Ok(stream)
}

#[cfg(target_os = "macos")]
fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    let mut credentials = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(io::Error::last_os_error());
    }
    Ok(credentials.uid)
}

#[cfg(test)]
mod tests {
    use super::{connect_as, connect_own};
    use std::os::unix::net::UnixListener;

    #[test]
    fn connects_to_a_socket_of_our_own_user() {
        let dir = std::env::temp_dir().join(format!("pixel-own-socket-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.sock");
        let _ = std::fs::remove_file(&path);
        let _listener = UnixListener::bind(&path).unwrap();
        assert!(connect_own(path.to_str().unwrap()).is_ok());
        let other = unsafe { libc::geteuid() } + 1;
        let refused = connect_as(path.to_str().unwrap(), other).unwrap_err();
        assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

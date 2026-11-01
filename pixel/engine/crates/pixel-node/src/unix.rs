#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::ffi::CStr;
use std::os::fd::{AsFd, BorrowedFd, IntoRawFd, OwnedFd};

use napi::{Error, Result};
use napi_derive::napi;
use rustix::fs::{AtFlags, CWD, FileType, Mode, OFlags};

use crate::acl;

#[napi]
pub fn socket_peer_uid(fd: i32) -> Result<u32> {
    peer_uid(fd).map_err(|error| Error::from_reason(format!("peer credentials: {error}")))
}

#[cfg(target_os = "macos")]
fn peer_uid(fd: i32) -> std::io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(uid)
}

#[cfg(target_os = "linux")]
fn peer_uid(fd: i32) -> std::io::Result<u32> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(credentials.uid)
}

fn components(relative: &str) -> std::io::Result<Vec<&str>> {
    let parts: Vec<&str> = relative.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    Ok(parts)
}

// Opens each directory below `root` without following symlinks, so the handle
// is a real directory inside `root` even if a name on the way is swapped for a
// symlink at the same moment.
fn open_directories_beneath(root: impl AsFd, directories: &[&str]) -> std::io::Result<OwnedFd> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut current = rustix::fs::openat(root, ".", flags, Mode::empty())?;
    for name in directories {
        current = rustix::fs::openat(&current, *name, flags, Mode::empty())?;
    }
    Ok(current)
}

fn rename_regular_file_beneath(root: &str, from: &str, to: &str) -> std::io::Result<()> {
    let root = rustix::fs::openat(
        CWD,
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let from = components(from)?;
    let to = components(to)?;
    let (from_name, from_dirs) = from.split_last().expect("split yields at least one part");
    let (to_name, to_dirs) = to.split_last().expect("split yields at least one part");
    let source = open_directories_beneath(&root, from_dirs)?;
    let target = open_directories_beneath(&root, to_dirs)?;
    let leaf = rustix::fs::statat(&source, *from_name, AtFlags::SYMLINK_NOFOLLOW)?;
    if FileType::from_raw_mode(leaf.st_mode) != FileType::RegularFile {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    rustix::fs::renameat(&source, *from_name, &target, *to_name)?;
    Ok(())
}

#[napi]
pub fn rename_beneath(root: String, from: String, to: String) -> Result<()> {
    rename_regular_file_beneath(&root, &from, &to)
        .map_err(|error| Error::from_reason(error.to_string()))
}

// Anyone who can add names to a folder can hard-link into it a file they can't
// read, so a file with several names counts as placed by its owner only when
// nobody else can write to the folder it sits in.
fn only_owner_could_link(folder: &OwnedFd, file: &rustix::fs::Stat) -> std::io::Result<bool> {
    if file.st_nlink <= 1 {
        return Ok(true);
    }
    let owner = file.st_uid;
    let stat = rustix::fs::fstat(folder)?;
    let mode = stat.st_mode as u32;
    if stat.st_uid != owner && stat.st_uid != 0 {
        return Ok(false);
    }
    let group_writes = mode & 0o020 != 0 && !private_group(stat.st_gid, owner).unwrap_or(false);
    if mode & 0o002 != 0 || group_writes {
        return Ok(false);
    }
    Ok(acl::others_access(folder.as_fd(), owner)? != acl::Access::Write)
}

// Non-blocking so that a FIFO put in place of the file can't hang the open.
fn open_regular_file_beneath(
    root: BorrowedFd<'_>,
    relative: &str,
    owner_linked: bool,
) -> std::io::Result<OwnedFd> {
    let parts = components(relative)?;
    let (name, directories) = parts.split_last().expect("split yields at least one part");
    let parent = open_directories_beneath(root, directories)?;
    let file = rustix::fs::openat(
        &parent,
        *name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let stat = rustix::fs::fstat(&file)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    if owner_linked && !only_owner_could_link(&parent, &stat)? {
        return Err(std::io::Error::from_raw_os_error(libc::EPERM));
    }
    Ok(file)
}

fn borrow_fd(fd: i32) -> Result<BorrowedFd<'static>> {
    if fd < 0 {
        return Err(io_error(std::io::Error::from(std::io::ErrorKind::InvalidInput)));
    }
    Ok(unsafe { BorrowedFd::borrow_raw(fd) })
}

fn io_error(error: std::io::Error) -> Error {
    let code = match error.raw_os_error() {
        Some(libc::ELOOP) => "ELOOP",
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EPERM) => "EPERM",
        _ if error.kind() == std::io::ErrorKind::InvalidInput => "EINVAL",
        _ => "EIO",
    };
    Error::from_reason(format!("{code}: {error}"))
}

#[napi]
pub fn open_beneath(dir_fd: i32, relative: String, owner_linked: Option<bool>) -> Result<i32> {
    open_regular_file_beneath(borrow_fd(dir_fd)?, &relative, owner_linked.unwrap_or(false))
        .map(IntoRawFd::into_raw_fd)
        .map_err(io_error)
}

#[napi]
pub fn acl_grants_others(fd: i32, uid: u32) -> Result<Option<String>> {
    let access = acl::others_access(borrow_fd(fd)?, uid).map_err(io_error)?;
    Ok(match access {
        acl::Access::None => None,
        acl::Access::Read => Some("read".to_owned()),
        acl::Access::Write => Some("write".to_owned()),
    })
}

#[napi]
pub fn clear_acl(fd: i32) -> Result<()> {
    acl::clear(borrow_fd(fd)?).map_err(io_error)
}

#[napi]
pub fn open_directory_at(dir_fd: i32, name: String, create: bool) -> Result<i32> {
    let parent = borrow_fd(dir_fd)?;
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(io_error(std::io::Error::from(std::io::ErrorKind::InvalidInput)));
    }
    if create {
        match rustix::fs::mkdirat(parent, name.as_str(), Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(io_error(error.into())),
        }
    }
    rustix::fs::openat(
        parent,
        name.as_str(),
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(IntoRawFd::into_raw_fd)
    .map_err(|error| io_error(error.into()))
}

#[napi(object)]
pub struct SymbolicLink {
    pub target: String,
    pub owner: u32,
}

#[napi]
pub fn read_link_at(dir_fd: i32, name: String) -> Result<Option<SymbolicLink>> {
    let parent = borrow_fd(dir_fd)?;
    let leaf = rustix::fs::statat(parent, name.as_str(), AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| io_error(error.into()))?;
    if FileType::from_raw_mode(leaf.st_mode) != FileType::Symlink {
        return Ok(None);
    }
    let target = rustix::fs::readlinkat(parent, name.as_str(), Vec::new())
        .map_err(|error| io_error(error.into()))?;
    Ok(Some(SymbolicLink {
        target: target.to_string_lossy().into_owned(),
        owner: leaf.st_uid,
    }))
}

// Whether only `uid` can use the group's write access, as with the group of
// the same name many Linux systems make for each user: it is the user's
// primary group, has the user's name, and lists nobody else.
#[napi]
pub fn group_is_private_to(gid: u32, uid: u32) -> bool {
    private_group(gid, uid).unwrap_or(false)
}

fn private_group(gid: u32, uid: u32) -> Option<bool> {
    let mut group_buffer = vec![0 as libc::c_char; 1 << 16];
    let mut group: libc::group = unsafe { std::mem::zeroed() };
    let mut found_group: *mut libc::group = std::ptr::null_mut();
    let status = unsafe {
        libc::getgrgid_r(
            gid as libc::gid_t,
            &mut group,
            group_buffer.as_mut_ptr(),
            group_buffer.len(),
            &mut found_group,
        )
    };
    if status != 0 || found_group.is_null() {
        return None;
    }
    let mut user_buffer = vec![0 as libc::c_char; 1 << 16];
    let mut user: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found_user: *mut libc::passwd = std::ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(
            uid as libc::uid_t,
            &mut user,
            user_buffer.as_mut_ptr(),
            user_buffer.len(),
            &mut found_user,
        )
    };
    if status != 0 || found_user.is_null() {
        return None;
    }
    // Only the user-private-group convention counts: the group is the user's
    // primary group, has the user's name, and lists nobody else. Enumerating
    // everyone whose primary group it is can't be trusted with LDAP or sssd.
    let name = unsafe { CStr::from_ptr(user.pw_name) };
    if user.pw_gid != gid as libc::gid_t || unsafe { CStr::from_ptr(group.gr_name) } != name {
        return Some(false);
    }
    let mut listed = group.gr_mem;
    while !listed.is_null() && !unsafe { *listed }.is_null() {
        if unsafe { CStr::from_ptr(*listed) } != name {
            return Some(false);
        }
        listed = unsafe { listed.add(1) };
    }
    Some(true)
}

#[napi]
pub fn set_close_on_exec(fd: i32) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        let error = std::io::Error::last_os_error();
        return Err(Error::from_reason(format!("close-on-exec: {error}")));
    }
    Ok(())
}

// Two connected Unix stream sockets, both close-on-exec.
#[napi]
pub fn socket_pair() -> Result<Vec<i32>> {
    let mut fds = [0 as libc::c_int; 2];
    if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) } != 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    for fd in fds {
        if let Err(error) = set_close_on_exec(fd) {
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
            return Err(error);
        }
    }
    Ok(vec![fds[0], fds[1]])
}

#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::os::fd::BorrowedFd;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Access {
    None,
    Read,
    Write,
}

impl Access {
    fn of(granted: bool, write: bool) -> Self {
        match (granted, write) {
            (false, _) => Self::None,
            (true, false) => Self::Read,
            (true, true) => Self::Write,
        }
    }
}

// What an access control list on `fd` lets users other than `uid` and root do,
// on top of what its mode bits allow. Write covers anything that adds, removes
// or renames entries, changes contents, or changes who has access.
pub(crate) fn others_access(fd: BorrowedFd<'_>, uid: u32) -> std::io::Result<Access> {
    platform::others_access(fd, uid)
}

// Removes every access control list entry from `fd`, including ones inherited
// from its folder and ones its own new entries would inherit.
pub(crate) fn clear(fd: BorrowedFd<'_>) -> std::io::Result<()> {
    platform::clear(fd)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_int, c_void};
    use std::os::fd::{AsRawFd, BorrowedFd};

    use super::Access;

    const ACL_TYPE_EXTENDED: c_int = 0x100;
    const ACL_FIRST_ENTRY: c_int = 0;
    const ACL_NEXT_ENTRY: c_int = -1;
    const ACL_EXTENDED_ALLOW: c_int = 1;
    const ID_TYPE_UID: c_int = 0;
    const ACL_WRITE_DATA: u64 = 1 << 2;
    const ACL_DELETE: u64 = 1 << 4;
    const ACL_APPEND_DATA: u64 = 1 << 5;
    const ACL_DELETE_CHILD: u64 = 1 << 6;
    const ACL_WRITE_ATTRIBUTES: u64 = 1 << 8;
    const ACL_WRITE_EXTATTRIBUTES: u64 = 1 << 10;
    const ACL_WRITE_SECURITY: u64 = 1 << 12;
    const ACL_CHANGE_OWNER: u64 = 1 << 13;
    const WRITE: u64 = ACL_WRITE_DATA
        | ACL_DELETE
        | ACL_APPEND_DATA
        | ACL_DELETE_CHILD
        | ACL_WRITE_ATTRIBUTES
        | ACL_WRITE_EXTATTRIBUTES
        | ACL_WRITE_SECURITY
        | ACL_CHANGE_OWNER;

    unsafe extern "C" {
        fn acl_get_fd_np(fd: c_int, kind: c_int) -> *mut c_void;
        fn acl_set_fd_np(fd: c_int, acl: *mut c_void, kind: c_int) -> c_int;
        fn acl_init(count: c_int) -> *mut c_void;
        fn acl_free(object: *mut c_void) -> c_int;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_get_tag_type(entry: *mut c_void, tag: *mut c_int) -> c_int;
        fn acl_get_qualifier(entry: *mut c_void) -> *mut c_void;
        fn acl_get_permset_mask_np(entry: *mut c_void, mask: *mut u64) -> c_int;
        fn mbr_uuid_to_id(uuid: *const c_void, id: *mut libc::id_t, kind: *mut c_int) -> c_int;
    }

    struct Acl(*mut c_void);

    impl Drop for Acl {
        fn drop(&mut self) {
            unsafe { acl_free(self.0) };
        }
    }

    fn read(fd: BorrowedFd<'_>) -> std::io::Result<Option<Acl>> {
        let acl = unsafe { acl_get_fd_np(fd.as_raw_fd(), ACL_TYPE_EXTENDED) };
        if !acl.is_null() {
            return Ok(Some(Acl(acl)));
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ENOENT | libc::ENOTSUP | libc::EOPNOTSUPP) => Ok(None),
            _ => Err(error),
        }
    }

    fn is_user_or_root(entry: *mut c_void, uid: u32) -> bool {
        let qualifier = unsafe { acl_get_qualifier(entry) };
        if qualifier.is_null() {
            return false;
        }
        let mut id: libc::id_t = 0;
        let mut kind: c_int = -1;
        let found = unsafe { mbr_uuid_to_id(qualifier, &mut id, &mut kind) } == 0;
        unsafe { acl_free(qualifier) };
        found && kind == ID_TYPE_UID && (id == uid || id == 0)
    }

    pub(super) fn others_access(fd: BorrowedFd<'_>, uid: u32) -> std::io::Result<Access> {
        let Some(acl) = read(fd)? else {
            return Ok(Access::None);
        };
        let mut access = Access::None;
        let mut entry: *mut c_void = std::ptr::null_mut();
        let mut which = ACL_FIRST_ENTRY;
        while unsafe { acl_get_entry(acl.0, which, &mut entry) } == 0 {
            which = ACL_NEXT_ENTRY;
            let mut tag: c_int = 0;
            let mut perms: u64 = 0;
            if unsafe { acl_get_tag_type(entry, &mut tag) } != 0
                || unsafe { acl_get_permset_mask_np(entry, &mut perms) } != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if tag != ACL_EXTENDED_ALLOW || is_user_or_root(entry, uid) {
                continue;
            }
            access = access.max(Access::of(perms != 0, perms & WRITE != 0));
        }
        Ok(access)
    }

    pub(super) fn clear(fd: BorrowedFd<'_>) -> std::io::Result<()> {
        if read(fd)?.is_none() {
            return Ok(());
        }
        let empty = unsafe { acl_init(0) };
        if empty.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let empty = Acl(empty);
        if unsafe { acl_set_fd_np(fd.as_raw_fd(), empty.0, ACL_TYPE_EXTENDED) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::os::fd::BorrowedFd;

    use rustix::fs::FileType;
    use rustix::io::Errno;

    use super::Access;

    const ACCESS: &str = "system.posix_acl_access";
    const DEFAULT: &str = "system.posix_acl_default";
    const HEADER: usize = 4;
    const ACL_USER: u16 = 0x02;
    const ACL_GROUP: u16 = 0x08;
    const ACL_MASK: u16 = 0x10;
    const WRITE: u16 = 0o2;

    fn read(fd: BorrowedFd<'_>, name: &str) -> std::io::Result<Option<Vec<u8>>> {
        let size = match rustix::fs::fgetxattr(fd, name, &mut [0u8; 0][..]) {
            Ok(size) => size,
            Err(Errno::NODATA | Errno::NOTSUP) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut value = vec![0; size];
        let read = rustix::fs::fgetxattr(fd, name, &mut value[..])?;
        value.truncate(read);
        Ok(Some(value))
    }

    // Each entry is a little-endian tag, permission bits and user or group id.
    fn entries(value: &[u8]) -> impl Iterator<Item = (u16, u16, u32)> + '_ {
        value
            .get(HEADER..)
            .unwrap_or_default()
            .chunks_exact(8)
            .map(|entry| {
                (
                    u16::from_le_bytes([entry[0], entry[1]]),
                    u16::from_le_bytes([entry[2], entry[3]]),
                    u32::from_le_bytes([entry[4], entry[5], entry[6], entry[7]]),
                )
            })
    }

    // The mode's group bits already show the mask, so only the named users and
    // groups the mask lets through are extra.
    pub(super) fn others_access(fd: BorrowedFd<'_>, uid: u32) -> std::io::Result<Access> {
        let Some(value) = read(fd, ACCESS)? else {
            return Ok(Access::None);
        };
        let mask = entries(&value)
            .find(|(tag, _, _)| *tag == ACL_MASK)
            .map_or(0o7, |(_, perm, _)| perm);
        Ok(entries(&value)
            .filter(|(tag, _, id)| {
                *tag == ACL_GROUP || (*tag == ACL_USER && *id != uid && *id != 0)
            })
            .map(|(_, perm, _)| perm & mask)
            .map(|perm| Access::of(perm != 0, perm & WRITE != 0))
            .max()
            .unwrap_or(Access::None))
    }

    pub(super) fn clear(fd: BorrowedFd<'_>) -> std::io::Result<()> {
        let directory =
            FileType::from_raw_mode(rustix::fs::fstat(fd)?.st_mode) == FileType::Directory;
        for name in [ACCESS, DEFAULT] {
            if name == DEFAULT && !directory {
                continue;
            }
            match rustix::fs::fremovexattr(fd, name) {
                Ok(()) | Err(Errno::NODATA | Errno::NOTSUP) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

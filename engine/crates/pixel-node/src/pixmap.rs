#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::ptr::NonNull;

use rustix::ioctl::{Setter, opcode};
use rustix::mm::{MapFlags, ProtFlags};

#[repr(C)]
struct DmaBufSync {
    flags: u64,
}

const DMA_BUF_SYNC_READ: u64 = 1;
const DMA_BUF_SYNC_END: u64 = 1 << 2;
const DMA_BUF_IOCTL_SYNC: rustix::ioctl::Opcode = opcode::write::<DmaBufSync>(b'b', 0);

/// One plane of an Electron shared texture: a dmabuf mapped for CPU reads.
/// The fd is duplicated on construction because Electron closes its copy as
/// soon as the paint callback releases the texture.
pub struct PixmapSurface {
    fd: OwnedFd,
    map: Mapping,
    offset: usize,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

struct Mapping {
    base: NonNull<u8>,
    len: usize,
}

unsafe impl Send for Mapping {}

impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            let _ = rustix::mm::munmap(self.base.as_ptr().cast(), self.len);
        }
    }
}

impl PixmapSurface {
    pub fn from_plane(
        raw_fd: i32,
        width: u32,
        height: u32,
        stride: u32,
        offset: u32,
        size: u32,
    ) -> Result<Self, String> {
        if raw_fd < 0 {
            return Err("invalid dmabuf fd".to_string());
        }
        let stride = stride as usize;
        let rows = stride
            .checked_mul(height as usize)
            .ok_or_else(|| "pixmap dimensions overflow".to_string())?;
        if (width as usize) * 4 > stride {
            return Err("pixmap stride is smaller than its row".to_string());
        }
        if rows > size as usize {
            return Err("pixmap plane is smaller than its dimensions".to_string());
        }
        let fd = unsafe { BorrowedFd::borrow_raw(raw_fd) }
            .try_clone_to_owned()
            .map_err(|error| format!("dmabuf fd duplication failed: {error}"))?;
        // The plane offset is not necessarily page aligned, so map from the
        // start of the buffer and index into it.
        let len = offset as usize + size as usize;
        let base = unsafe {
            rustix::mm::mmap(
                std::ptr::null_mut(),
                len,
                ProtFlags::READ,
                MapFlags::SHARED,
                &fd,
                0,
            )
        }
        .map_err(|error| format!("dmabuf mmap failed: {error}"))?;
        let base = NonNull::new(base.cast::<u8>()).ok_or_else(|| "dmabuf mapped to null".to_string())?;
        Ok(Self {
            fd,
            map: Mapping { base, len },
            offset: offset as usize,
            width,
            height,
            stride,
        })
    }

    pub fn lock(&self) -> Result<LockedPixmap<'_>, String> {
        // Best effort: exporters that don't implement the sync ioctl still
        // allow direct reads, they just can't flush caches for us.
        sync(self.fd.as_fd(), DMA_BUF_SYNC_READ);
        Ok(LockedPixmap {
            surface: self,
            width: self.width,
            height: self.height,
            stride: self.stride,
        })
    }
}

fn sync(fd: BorrowedFd<'_>, flags: u64) {
    let sync = DmaBufSync { flags };
    unsafe {
        let _ = rustix::ioctl::ioctl(fd, Setter::<{ DMA_BUF_IOCTL_SYNC }, DmaBufSync>::new(sync));
    }
}

pub struct LockedPixmap<'a> {
    surface: &'a PixmapSurface,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

impl Drop for LockedPixmap<'_> {
    fn drop(&mut self) {
        sync(
            self.surface.fd.as_fd(),
            DMA_BUF_SYNC_READ | DMA_BUF_SYNC_END,
        );
    }
}

impl LockedPixmap<'_> {
    pub fn pixels(&self) -> &[u8] {
        let len = self.stride * self.height as usize;
        unsafe {
            std::slice::from_raw_parts(
                self.surface.map.base.as_ptr().add(self.surface.offset),
                len,
            )
        }
    }
}

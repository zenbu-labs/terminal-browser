#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd};
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

/// One plane of an Electron shared texture, readable by the CPU. The fd is
/// duplicated on construction because Electron closes its copy as soon as
/// the paint callback releases the texture.
///
/// Reads prefer the GPU driver's own mapping (see [`crate::gbm`]), which
/// picks per buffer between a direct pointer and a staged copy; a raw mmap
/// of the fd is the fallback when gbm is unavailable.
pub struct PixmapSurface {
    fd: OwnedFd,
    backing: Backing,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    /// Runs when the frame dies -- consumed, coalesced away, or dropped on an
    /// error path -- so the producer can release the texture only after any
    /// reader is done with the mapping.
    on_drop: Option<Box<dyn FnOnce() + Send>>,
}

enum Backing {
    Gbm(crate::gbm::Bo),
    Raw { map: Mapping, offset: usize },
}

impl Drop for PixmapSurface {
    fn drop(&mut self) {
        if let Some(hook) = self.on_drop.take() {
            hook();
        }
    }
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
        modifier: u64,
    ) -> Result<Self, String> {
        if raw_fd < 0 {
            return Err("invalid dmabuf fd".to_string());
        }
        let row_bytes = stride as usize;
        let rows = row_bytes
            .checked_mul(height as usize)
            .ok_or_else(|| "pixmap dimensions overflow".to_string())?;
        if (width as usize) * 4 > row_bytes {
            return Err("pixmap stride is smaller than its row".to_string());
        }
        if rows > size as usize {
            return Err("pixmap plane is smaller than its dimensions".to_string());
        }
        let fd = unsafe { BorrowedFd::borrow_raw(raw_fd) }
            .try_clone_to_owned()
            .map_err(|error| format!("dmabuf fd duplication failed: {error}"))?;
        if let Some(bo) = crate::gbm::import(fd.as_raw_fd(), width, height, stride, offset, modifier)
        {
            return Ok(Self {
                fd,
                backing: Backing::Gbm(bo),
                width,
                height,
                stride: row_bytes,
                on_drop: None,
            });
        }
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
            backing: Backing::Raw {
                map: Mapping { base, len },
                offset: offset as usize,
            },
            width,
            height,
            stride: row_bytes,
            on_drop: None,
        })
    }

    pub fn set_on_drop(&mut self, hook: Box<dyn FnOnce() + Send>) {
        self.on_drop = Some(hook);
    }

    pub fn lock(&self) -> Result<LockedPixmap<'_>, String> {
        match &self.backing {
            Backing::Gbm(bo) => {
                let map = crate::gbm::map_read(bo, self.width, self.height)?;
                Ok(LockedPixmap {
                    width: self.width,
                    height: self.height,
                    stride: map.stride,
                    source: LockSource::Gbm(map),
                })
            }
            Backing::Raw { .. } => {
                // Best effort: exporters that don't implement the sync ioctl
                // still allow direct reads, they just can't flush caches.
                sync(self.fd.as_fd(), DMA_BUF_SYNC_READ);
                Ok(LockedPixmap {
                    width: self.width,
                    height: self.height,
                    stride: self.stride,
                    source: LockSource::Raw(self),
                })
            }
        }
    }
}

fn sync(fd: BorrowedFd<'_>, flags: u64) {
    let sync = DmaBufSync { flags };
    unsafe {
        let _ = rustix::ioctl::ioctl(fd, Setter::<{ DMA_BUF_IOCTL_SYNC }, DmaBufSync>::new(sync));
    }
}

pub struct LockedPixmap<'a> {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    source: LockSource<'a>,
}

enum LockSource<'a> {
    Gbm(crate::gbm::BoMap),
    Raw(&'a PixmapSurface),
}

impl Drop for LockedPixmap<'_> {
    fn drop(&mut self) {
        if let LockSource::Raw(surface) = &self.source {
            sync(surface.fd.as_fd(), DMA_BUF_SYNC_READ | DMA_BUF_SYNC_END);
        }
    }
}

impl LockedPixmap<'_> {
    pub fn pixels(&self) -> &[u8] {
        match &self.source {
            LockSource::Gbm(map) => map.pixels(),
            LockSource::Raw(surface) => {
                let Backing::Raw { map, offset } = &surface.backing else {
                    unreachable!("raw lock always comes from a raw backing");
                };
                let len = self.stride * self.height as usize;
                unsafe { std::slice::from_raw_parts(map.base.as_ptr().add(*offset), len) }
            }
        }
    }
}

#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::os::fd::BorrowedFd;
use std::ptr::NonNull;

use rustix::mm::{MapFlags, ProtFlags};

/// A software frame from Electron's capturer: a read-only shared memory
/// region of plain cached RAM. Unlike [`crate::pixmap`] there is no GPU
/// import and no cache synchronization -- an mmap is all it takes.
pub struct ShmSurface {
    map: Mapping,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    /// Runs when the frame dies -- consumed, coalesced away, or dropped on an
    /// error path -- so the producer can release the pooled region only after
    /// any reader is done with it.
    on_drop: Option<Box<dyn FnOnce() + Send>>,
}

impl Drop for ShmSurface {
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

impl ShmSurface {
    /// The mapping keeps the memory alive on its own, so the fd is only
    /// borrowed for the mmap call; the producer keeps it open until release.
    pub fn from_region(
        raw_fd: i32,
        width: u32,
        height: u32,
        stride: u32,
        size: u32,
    ) -> Result<Self, String> {
        if raw_fd < 0 {
            return Err("invalid shm fd".to_string());
        }
        let row_bytes = stride as usize;
        if (width as usize) * 4 > row_bytes {
            return Err("shm stride is smaller than its row".to_string());
        }
        let rows = row_bytes
            .checked_mul(height as usize)
            .ok_or_else(|| "shm dimensions overflow".to_string())?;
        if rows > size as usize {
            return Err("shm region is smaller than its dimensions".to_string());
        }
        let fd = unsafe { BorrowedFd::borrow_raw(raw_fd) };
        let len = size as usize;
        let base = unsafe {
            rustix::mm::mmap(
                std::ptr::null_mut(),
                len,
                ProtFlags::READ,
                MapFlags::SHARED,
                fd,
                0,
            )
        }
        .map_err(|error| format!("shm mmap failed: {error}"))?;
        let base = NonNull::new(base.cast::<u8>()).ok_or_else(|| "shm mapped to null".to_string())?;
        Ok(Self {
            map: Mapping { base, len },
            width,
            height,
            stride: row_bytes,
            on_drop: None,
        })
    }

    pub fn set_on_drop(&mut self, hook: Box<dyn FnOnce() + Send>) {
        self.on_drop = Some(hook);
    }

    pub fn pixels(&self) -> &[u8] {
        let len = self.stride * self.height as usize;
        unsafe { std::slice::from_raw_parts(self.map.base.as_ptr(), len) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use std::os::fd::AsRawFd;

    fn region(bytes: &[u8]) -> File {
        let fd = rustix::fs::memfd_create("shm-test", rustix::fs::MemfdFlags::CLOEXEC)
            .expect("memfd_create");
        let mut file = File::from(fd);
        file.write_all(bytes).expect("write");
        file
    }

    #[test]
    fn maps_and_reads_a_memfd_region() {
        let pixels: Vec<u8> = (0..=255u8).collect();
        let file = region(&pixels);
        let surface = ShmSurface::from_region(file.as_raw_fd(), 8, 8, 32, 256).expect("map");
        assert_eq!(surface.pixels().len(), 256);
        assert_eq!(surface.pixels()[..8], pixels[..8]);
    }

    #[test]
    fn rejects_a_region_smaller_than_its_dimensions() {
        let file = region(&[0u8; 64]);
        let result = ShmSurface::from_region(file.as_raw_fd(), 8, 8, 32, 64);
        assert!(result.is_err());
    }

    #[test]
    fn runs_the_drop_hook_once_consumed() {
        let file = region(&[0u8; 256]);
        let (sent, received) = std::sync::mpsc::channel::<u32>();
        let mut surface = ShmSurface::from_region(file.as_raw_fd(), 8, 8, 32, 256).expect("map");
        surface.set_on_drop(Box::new(move || {
            let _ = sent.send(1);
        }));
        drop(surface);
        assert_eq!(received.try_recv(), Ok(1));
    }
}

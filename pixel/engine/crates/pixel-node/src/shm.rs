#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::os::fd::BorrowedFd;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};

use rustix::mm::{MapFlags, ProtFlags};

pub struct ShmSurface {
    map: Arc<Mapping>,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    on_drop: Option<Box<dyn FnOnce() + Send>>,
}

struct CachedMapping {
    dev: u64,
    ino: u64,
    len: usize,
    map: Arc<Mapping>,
    last_used: std::time::Instant,
}

static MAPPINGS: Mutex<Vec<CachedMapping>> = Mutex::new(Vec::new());
static MAP_HITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static MAP_MISSES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const MAPPING_CAPACITY: usize = 16;
const MAPPING_IDLE_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

fn mapping_for(fd: BorrowedFd<'_>, len: usize) -> Result<Arc<Mapping>, String> {
    let stat = rustix::fs::fstat(fd).map_err(|error| format!("shm fstat failed: {error}"))?;
    let (dev, ino) = (stat.st_dev as u64, stat.st_ino as u64);
    let now = std::time::Instant::now();
    let mut cache = MAPPINGS.lock().unwrap_or_else(|error| error.into_inner());
    cache.retain(|entry| now.duration_since(entry.last_used) < MAPPING_IDLE_LIMIT);
    if let Some(at) = cache
        .iter()
        .position(|entry| entry.dev == dev && entry.ino == ino && entry.len == len)
    {
        let mut entry = cache.remove(at);
        entry.last_used = now;
        let map = entry.map.clone();
        cache.push(entry);
        MAP_HITS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        return Ok(map);
    }
    // what
    let misses = MAP_MISSES.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    if misses <= 5 || misses.is_multiple_of(500) {
        pixel_core::logging::debug(
            "shm",
            format!(
                "mapping a new {} byte frame buffer (dev {dev} ino {ino}); {misses} new so far, {} reused",
                len,
                MAP_HITS.load(std::sync::atomic::Ordering::Relaxed)
            ),
        );
    }
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
    let map = Arc::new(Mapping { base, len });
    if cache.len() >= MAPPING_CAPACITY {
        cache.remove(0);
    }
    cache.push(CachedMapping { dev, ino, len, map: map.clone(), last_used: now });
    Ok(map)
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
unsafe impl Sync for Mapping {}

impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            let _ = rustix::mm::munmap(self.base.as_ptr().cast(), self.len);
        }
    }
}

impl ShmSurface {
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
        let map = mapping_for(fd, size as usize)?;
        Ok(Self {
            map,
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
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "pixel-shm-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&path);
        let mut file = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .expect("temp region");
        let _ = std::fs::remove_file(&path);
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
    fn reuses_the_mapping_across_frames_of_one_region() {
        let file = region(&[7u8; 640]);
        let first = ShmSurface::from_region(file.as_raw_fd(), 8, 8, 32, 640).expect("map");
        let second = ShmSurface::from_region(file.as_raw_fd(), 8, 8, 32, 640).expect("map");
        assert!(Arc::ptr_eq(&first.map, &second.map));
        assert_eq!(second.pixels()[..8], [7u8; 8]);
    }
}

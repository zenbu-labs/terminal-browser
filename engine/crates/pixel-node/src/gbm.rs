//! CPU access to dmabufs through the GPU driver's own mapping machinery.
//!
//! A raw `mmap` of a dmabuf fd shows the pages exactly as they physically
//! are; whether that is fast is private knowledge of the driver that
//! allocated them. Mesa's GBM library moves the decision to the party that
//! knows: `gbm_bo_map(TRANSFER_READ)` hands back a directly-readable pointer
//! when the pages are CPU-friendly, and otherwise stages a driver-optimized
//! copy (GPU blit into cached memory) and hands back that.
//!
//! libgbm is loaded with `dlopen` so the prebuilt module still loads on
//! machines without Mesa; everything falls back to the raw mmap path in
//! [`super::pixmap`]. libgbm makes no thread-safety promises, so one mutex
//! serializes every call.

#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::ffi::{CStr, c_char, c_int, c_void};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::{Mutex, MutexGuard, OnceLock};

const GBM_BO_IMPORT_FD_MODIFIER: u32 = 0x5504;
const GBM_BO_TRANSFER_READ: u32 = 1 << 0;
const GBM_BO_TRANSFER_WRITE: u32 = 1 << 1;
/// fourcc 'AR24': 4 bytes per pixel, blue in the lowest byte -- the layout
/// chromium's bgra frames use.
const GBM_FORMAT_ARGB8888: u32 = 0x3432_5241;
const GBM_BO_USE_LINEAR: u32 = 1 << 4;

#[repr(C)]
struct ImportFdModifierData {
    width: u32,
    height: u32,
    format: u32,
    num_fds: u32,
    fds: [c_int; 4],
    strides: [c_int; 4],
    offsets: [c_int; 4],
    modifier: u64,
}

struct Lib {
    create_device: unsafe extern "C" fn(c_int) -> *mut c_void,
    bo_import: unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32) -> *mut c_void,
    bo_map: unsafe extern "C" fn(
        *mut c_void,
        u32,
        u32,
        u32,
        u32,
        u32,
        *mut u32,
        *mut *mut c_void,
    ) -> *mut c_void,
    bo_unmap: unsafe extern "C" fn(*mut c_void, *mut c_void),
    bo_destroy: unsafe extern "C" fn(*mut c_void),
    bo_create: unsafe extern "C" fn(*mut c_void, u32, u32, u32, u32) -> *mut c_void,
    bo_get_fd: unsafe extern "C" fn(*mut c_void) -> c_int,
    bo_get_stride: unsafe extern "C" fn(*mut c_void) -> u32,
}

impl Lib {
    fn open() -> Result<Self, String> {
        unsafe {
            let handle = libc::dlopen(
                c"libgbm.so.1".as_ptr(),
                libc::RTLD_NOW | libc::RTLD_LOCAL,
            );
            if handle.is_null() {
                return Err("libgbm.so.1 not found".into());
            }
            let sym = |name: &CStr| -> Result<*mut c_void, String> {
                let p = libc::dlsym(handle, name.as_ptr());
                if p.is_null() {
                    Err(format!("libgbm lacks {}", name.to_string_lossy()))
                } else {
                    Ok(p)
                }
            };
            macro_rules! load {
                ($name:literal) => {
                    std::mem::transmute(sym($name)?)
                };
            }
            Ok(Self {
                create_device: load!(c"gbm_create_device"),
                bo_import: load!(c"gbm_bo_import"),
                bo_map: load!(c"gbm_bo_map"),
                bo_unmap: load!(c"gbm_bo_unmap"),
                bo_destroy: load!(c"gbm_bo_destroy"),
                bo_create: load!(c"gbm_bo_create"),
                bo_get_fd: load!(c"gbm_bo_get_fd"),
                bo_get_stride: load!(c"gbm_bo_get_stride"),
            })
        }
    }
}

struct Device {
    lib: Lib,
    dev: *mut c_void,
    _node: OwnedFd,
}

unsafe impl Send for Device {}

static DEVICE: OnceLock<Option<Mutex<Device>>> = OnceLock::new();

fn device() -> Option<MutexGuard<'static, Device>> {
    DEVICE
        .get_or_init(|| match init_device() {
            Ok(device) => Some(Mutex::new(device)),
            Err(why) => {
                pixel_core::logging::info(
                    "pixmap",
                    format!("dmabuf reads via raw mmap ({why})"),
                );
                None
            }
        })
        .as_ref()
        .map(|m| m.lock().unwrap_or_else(|e| e.into_inner()))
}

fn init_device() -> Result<Device, String> {
    if std::env::var("TERMINAL_BROWSER_DMABUF_MAP").as_deref() == Ok("mmap") {
        return Err("TERMINAL_BROWSER_DMABUF_MAP=mmap".into());
    }
    let lib = Lib::open()?;
    for index in 128..136 {
        let path = format!("/dev/dri/renderD{index}");
        let Ok(node) = rustix::fs::open(
            &*path,
            rustix::fs::OFlags::RDWR | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        ) else {
            continue;
        };
        let dev = unsafe { (lib.create_device)(node.as_raw_fd()) };
        if !dev.is_null() {
            pixel_core::logging::info("pixmap", format!("dmabuf reads via gbm ({path})"));
            return Ok(Device { lib, dev, _node: node });
        }
    }
    Err("no usable DRM render node".into())
}

/// An imported buffer object. Destroys itself through the serialized device.
pub struct Bo {
    bo: *mut c_void,
}

unsafe impl Send for Bo {}

impl Drop for Bo {
    fn drop(&mut self) {
        if let Some(device) = device() {
            unsafe { (device.lib.bo_destroy)(self.bo) };
        }
    }
}

pub fn import(fd: c_int, width: u32, height: u32, stride: u32, offset: u32, modifier: u64) -> Option<Bo> {
    let device = device()?;
    let mut data = ImportFdModifierData {
        width,
        height,
        format: GBM_FORMAT_ARGB8888,
        num_fds: 1,
        fds: [fd, 0, 0, 0],
        strides: [stride as c_int, 0, 0, 0],
        offsets: [offset as c_int, 0, 0, 0],
        modifier,
    };
    let bo = unsafe {
        (device.lib.bo_import)(
            device.dev,
            GBM_BO_IMPORT_FD_MODIFIER,
            (&raw mut data).cast(),
            0,
        )
    };
    if bo.is_null() {
        return None;
    }
    Some(Bo { bo })
}

/// One mapped read of a buffer. The pointer is valid until drop, which
/// unmaps (and releases any staging copy the driver made).
pub struct BoMap {
    ptr: *const u8,
    map_data: *mut c_void,
    bo: *mut c_void,
    pub stride: usize,
    len: usize,
}

unsafe impl Send for BoMap {}

impl BoMap {
    pub fn pixels(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl Drop for BoMap {
    fn drop(&mut self) {
        if let Some(device) = device() {
            unsafe { (device.lib.bo_unmap)(self.bo, self.map_data) };
        }
    }
}

pub fn map_read(bo: &Bo, width: u32, height: u32) -> Result<BoMap, String> {
    map(bo, width, height, GBM_BO_TRANSFER_READ)
}

fn map(bo: &Bo, width: u32, height: u32, flags: u32) -> Result<BoMap, String> {
    let device = device().ok_or("gbm device unavailable")?;
    let mut stride: u32 = 0;
    let mut map_data: *mut c_void = std::ptr::null_mut();
    let ptr = unsafe {
        (device.lib.bo_map)(bo.bo, 0, 0, width, height, flags, &raw mut stride, &raw mut map_data)
    };
    if ptr.is_null() || ptr as isize == -1 {
        return Err("gbm_bo_map failed".into());
    }
    Ok(BoMap {
        ptr: ptr.cast_const().cast(),
        map_data,
        bo: bo.bo,
        stride: stride as usize,
        len: stride as usize * height as usize,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;

    /// Full round trip on real hardware: allocate a linear bo, write a
    /// pattern through a gbm write-map, export its dmabuf fd, import it back
    /// (the production path), and read the pattern through a read-map.
    #[test]
    fn import_and_map_round_trip() {
        let Some(guard) = device() else {
            eprintln!("skipping: no gbm device on this machine");
            return;
        };
        let (w, h) = (64u32, 16u32);
        let (bo_raw, fd, stride) = unsafe {
            let bo = (guard.lib.bo_create)(guard.dev, w, h, GBM_FORMAT_ARGB8888, GBM_BO_USE_LINEAR);
            assert!(!bo.is_null(), "bo_create failed");
            let fd = (guard.lib.bo_get_fd)(bo);
            assert!(fd >= 0, "bo_get_fd failed");
            ((Bo { bo }), OwnedFd::from_raw_fd(fd), (guard.lib.bo_get_stride)(bo))
        };
        drop(guard);

        {
            let map = map(&bo_raw, w, h, GBM_BO_TRANSFER_WRITE).expect("write map");
            let ptr = map.ptr.cast_mut();
            for y in 0..h as usize {
                for x in 0..w as usize {
                    unsafe {
                        *ptr.add(y * map.stride + x * 4) = (x * 3 + y) as u8;
                    }
                }
            }
        }

        let imported = import(fd.as_raw_fd(), w, h, stride, 0, 0).expect("import back");
        let read = map_read(&imported, w, h).expect("read map");
        let px = read.pixels();
        for y in 0..h as usize {
            for x in 0..w as usize {
                assert_eq!(px[y * read.stride + x * 4], (x * 3 + y) as u8, "at {x},{y}");
            }
        }
    }
}

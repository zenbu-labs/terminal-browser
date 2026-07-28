#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::NonNull;

type IOSurfaceRef = *mut c_void;

const LOCK_READ_ONLY: u32 = 1;

#[link(name = "IOSurface", kind = "framework")]
unsafe extern "C" {
    fn IOSurfaceLock(surface: IOSurfaceRef, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceUnlock(surface: IOSurfaceRef, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceGetBaseAddress(surface: IOSurfaceRef) -> *mut c_void;
    fn IOSurfaceGetWidth(surface: IOSurfaceRef) -> usize;
    fn IOSurfaceGetHeight(surface: IOSurfaceRef) -> usize;
    fn IOSurfaceGetBytesPerRow(surface: IOSurfaceRef) -> usize;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFRelease(cf: *const c_void);
}

pub struct RetainedSurface(NonNull<c_void>);

unsafe impl Send for RetainedSurface {}

impl Drop for RetainedSurface {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0.as_ptr()) };
    }
}

impl RetainedSurface {
    pub fn from_handle(handle: &[u8]) -> Result<Self, String> {
        let pointer: [u8; size_of::<usize>()] = handle
            .try_into()
            .map_err(|_| "invalid IOSurface handle".to_string())?;
        let surface = NonNull::new(usize::from_ne_bytes(pointer) as IOSurfaceRef)
            .ok_or_else(|| "empty IOSurface handle".to_string())?;
        unsafe { CFRetain(surface.as_ptr()) };
        Ok(Self(surface))
    }

    pub fn lock(&self) -> Result<LockedSurface<'_>, String> {
        let surface = self.0;
        let status =
            unsafe { IOSurfaceLock(surface.as_ptr(), LOCK_READ_ONLY, std::ptr::null_mut()) };
        if status != 0 {
            return Err(format!("IOSurface lock failed with {status}"));
        }
        let lock = SurfaceLock(surface);
        let width = unsafe { IOSurfaceGetWidth(surface.as_ptr()) };
        let height = unsafe { IOSurfaceGetHeight(surface.as_ptr()) };
        let stride = unsafe { IOSurfaceGetBytesPerRow(surface.as_ptr()) };
        let base = NonNull::new(unsafe { IOSurfaceGetBaseAddress(surface.as_ptr()) }.cast::<u8>())
            .ok_or_else(|| "IOSurface has no CPU address".to_string())?;
        let len = stride
            .checked_mul(height)
            .ok_or_else(|| "IOSurface dimensions overflow".to_string())?;
        let width = u32::try_from(width).map_err(|_| "IOSurface is too wide".to_string())?;
        let height = u32::try_from(height).map_err(|_| "IOSurface is too tall".to_string())?;
        Ok(LockedSurface {
            _lock: lock,
            _owner: std::marker::PhantomData,
            base,
            len,
            width,
            height,
            stride,
        })
    }
}

struct SurfaceLock(NonNull<c_void>);

impl Drop for SurfaceLock {
    fn drop(&mut self) {
        unsafe {
            IOSurfaceUnlock(self.0.as_ptr(), LOCK_READ_ONLY, std::ptr::null_mut());
        }
    }
}

pub struct LockedSurface<'a> {
    _lock: SurfaceLock,
    _owner: std::marker::PhantomData<&'a RetainedSurface>,
    base: NonNull<u8>,
    len: usize,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

impl LockedSurface<'_> {
    pub fn pixels(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.base.as_ptr(), self.len) }
    }
}

use std::ffi::{CString, c_char, c_void};
use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

use pixel_core::device::{DeviceHost, SurfaceCover, SurfacePlacement};

#[repr(C)]
pub struct PixelFrame {
    pub rgba: *const u8,
    pub width: u32,
    pub height: u32,
    pub premultiplied: bool,
    pub rects: *const u32,
    pub rect_count: u32,
    pub moves: *const i32,
    pub move_count: u32,
    pub work_ms: f32,
    pub kind: u32,
}

#[repr(C)]
pub struct PixelPlacement {
    pub surface: u32,
    pub rect: [f32; 4],
    pub visible: [f32; 4],
}

#[repr(C)]
pub struct PixelCover {
    pub surface: u32,
    pub rect: [f32; 4],
    pub opaque: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PixelCallbacks {
    pub context: *mut c_void,
    pub event: extern "C" fn(*mut c_void, *const c_char),
    pub present: extern "C" fn(*mut c_void, *const PixelFrame),
    pub write: extern "C" fn(*mut c_void, *const c_char),
    pub place: extern "C" fn(*mut c_void, *const PixelPlacement, u32, *const PixelCover, u32),
}

// SAFETY: the app promises its context and callbacks stay valid and thread safe until pixel_engine_stop returns.
unsafe impl Send for PixelCallbacks {}

impl PixelCallbacks {
    pub(crate) fn event(&self, json: &str) {
        if let Ok(json) = CString::new(json) {
            (self.event)(self.context, json.as_ptr());
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct SharedCallbacks(Arc<Mutex<Option<PixelCallbacks>>>);

impl SharedCallbacks {
    pub(crate) fn set(&self, callbacks: Option<PixelCallbacks>) {
        *self.lock() = callbacks;
    }

    fn lock(&self) -> MutexGuard<'_, Option<PixelCallbacks>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub(crate) struct Host {
    callbacks: SharedCallbacks,
    rects: Vec<u32>,
    moves: Vec<i32>,
}

impl Host {
    pub(crate) fn new(callbacks: SharedCallbacks) -> Self {
        Self { callbacks, rects: Vec::new(), moves: Vec::new() }
    }
}

impl DeviceHost for Host {
    fn present(&mut self, frame: &pixel_core::Frame<'_>) -> io::Result<usize> {
        let Some(callbacks) = *self.callbacks.lock() else {
            return Ok(0);
        };
        self.rects.clear();
        for rect in frame.repainted.iter().chain(frame.changed) {
            self.rects.extend([rect.x, rect.y, rect.w, rect.h]);
        }
        self.moves.clear();
        for shift in frame.moves {
            let r = shift.rect;
            self.moves.extend([r.x as i32, r.y as i32, r.w as i32, r.h as i32, shift.dy]);
        }
        let canvas = frame.canvas;
        let presented = PixelFrame {
            rgba: canvas.pixels.as_ptr(),
            width: canvas.width,
            height: canvas.height,
            premultiplied: frame.premultiplied,
            rects: self.rects.as_ptr(),
            rect_count: (self.rects.len() / 4) as u32,
            moves: self.moves.as_ptr(),
            move_count: (self.moves.len() / 5) as u32,
            work_ms: frame.work_ms,
            kind: u32::from(frame.kind),
        };
        (callbacks.present)(callbacks.context, &presented);
        Ok(canvas.pixels.len())
    }

    fn place(&mut self, surfaces: &[SurfacePlacement], covers: &[SurfaceCover]) {
        let Some(callbacks) = *self.callbacks.lock() else {
            return;
        };
        let placements: Vec<PixelPlacement> =
            surfaces.iter().map(|s| PixelPlacement { surface: s.surface, rect: s.rect, visible: s.visible }).collect();
        let covers: Vec<PixelCover> = covers.iter().map(|c| PixelCover { surface: c.surface, rect: c.rect, opaque: c.opaque }).collect();
        (callbacks.place)(callbacks.context, placements.as_ptr(), placements.len() as u32, covers.as_ptr(), covers.len() as u32);
    }

    fn write(&mut self, data: &str) {
        if let Some(callbacks) = *self.callbacks.lock()
            && let Ok(data) = CString::new(data)
        {
            (callbacks.write)(callbacks.context, data.as_ptr());
        }
    }
}

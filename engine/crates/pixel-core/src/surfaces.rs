use std::cell::RefCell;
use std::collections::HashMap;

// Surfaces are client-streamed pixel buffers (e.g. an embedded browser's
// frames) that nodes reference by id and paint blits into the canvas. The
// store is thread-local because surfaces are written and painted on the
// engine thread only.
pub struct Surface {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

thread_local! {
    static SURFACES: RefCell<HashMap<u32, Surface>> = RefCell::new(HashMap::new());
}

pub fn set(id: u32, width: u32, height: u32, rgba: &[u8]) {
    SURFACES.with_borrow_mut(|surfaces| {
        let surface = surfaces.entry(id).or_insert(Surface {
            width,
            height,
            pixels: Vec::new(),
        });
        surface.width = width;
        surface.height = height;
        surface.pixels.clear();
        surface.pixels.extend_from_slice(rgba);
    });
}

pub fn remove(id: u32) {
    SURFACES.with_borrow_mut(|surfaces| {
        surfaces.remove(&id);
    });
}

pub fn with<R>(id: u32, read: impl FnOnce(&Surface) -> R) -> Option<R> {
    SURFACES.with_borrow(|surfaces| surfaces.get(&id).map(read))
}

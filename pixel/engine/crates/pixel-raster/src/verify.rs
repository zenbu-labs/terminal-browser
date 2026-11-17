use std::sync::atomic::{AtomicU64, Ordering};

use pixel_core::Color;
use pixel_core::fonts::Font;
use pixel_core::scene::Item;
use pixel_core::surfaces::Rect;

use crate::canvas::Canvas;

static FRAMES: AtomicU64 = AtomicU64::new(0);

pub(crate) fn enabled() -> bool {
    pixel_core::verify::enabled()
}

// Paints the whole scene again from nothing and compares it with what drawing only the damage produced.
pub(crate) fn check(view: usize, drawn: &Canvas, root: &Item, fonts: &[Font], host_surfaces: bool, clear: Color, damage: &[Rect]) {
    let Some(settings) = pixel_core::verify::settings() else { return };
    let frame = FRAMES.fetch_add(1, Ordering::Relaxed);
    let mut fresh = Canvas::new(drawn.width, drawn.height);
    crate::draw::paint_scene(&mut fresh, root, fonts, host_surfaces, &[Rect::sized(drawn.width, drawn.height)], Some(clear), None);
    let mut wrong = 0u64;
    let mut bounds = Rect::default();
    for (i, (a, b)) in drawn.pixels.chunks_exact(4).zip(fresh.pixels.chunks_exact(4)).enumerate() {
        if a != b {
            wrong += 1;
            let (x, y) = (i as u32 % drawn.width, i as u32 / drawn.width);
            bounds = bounds.union(Rect { x, y, w: 1, h: 1 });
        }
    }
    let damaged: u64 = damage.iter().map(|r| r.area()).sum();
    if wrong == 0 {
        pixel_core::verify::report(&format!("frame {frame} view {view} ok damage {damaged}px in {}", damage.len()), true);
        return;
    }
    pixel_core::verify::report(
        &format!("frame {frame} view {view} MISMATCH {wrong}px within {},{} {}x{} damage {:?}", bounds.x, bounds.y, bounds.w, bounds.h, damage),
        false,
    );
    if let Some(dir) = &settings.pictures {
        save(dir, frame, drawn, &fresh);
    }
}

fn save(dir: &std::path::Path, frame: u64, drawn: &Canvas, fresh: &Canvas) {
    let _ = std::fs::create_dir_all(dir);
    let diff: Vec<u8> = drawn
        .pixels
        .chunks_exact(4)
        .zip(fresh.pixels.chunks_exact(4))
        .flat_map(|(a, b)| if a == b { [a[0] / 4, a[1] / 4, a[2] / 4, 255] } else { [255, 0, 255, 255] })
        .collect();
    for (name, pixels) in [("drawn", &drawn.pixels), ("fresh", &fresh.pixels), ("diff", &diff)] {
        let _ = image::save_buffer(dir.join(format!("frame-{frame}-{name}.png")), pixels, drawn.width, drawn.height, image::ColorType::Rgba8);
    }
}

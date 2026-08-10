//! The store of embedded surface pixels (one entry per chromium page, kept in
//! the engine thread). A producer submits frames through [`write`], painting
//! reads them through [`with`]. The format conversion itself -- including how
//! the two kinds of source memory are read -- lives in [`convert`].

use std::cell::RefCell;
use std::collections::HashMap;

mod convert;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub fn sized(w: u32, h: u32) -> Self {
        Self { x: 0, y: 0, w, h }
    }

    pub fn is_empty(self) -> bool {
        self.w == 0 || self.h == 0
    }

    pub fn union(self, other: Rect) -> Rect {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Rect {
            x,
            y,
            w: (self.x + self.w).max(other.x + other.w) - x,
            h: (self.y + self.h).max(other.y + other.h) - y,
        }
    }

    pub fn clamped(self, width: u32, height: u32) -> Rect {
        let x = self.x.min(width);
        let y = self.y.min(height);
        Rect {
            x,
            y,
            w: self.w.min(width - x),
            h: self.h.min(height - y),
        }
    }
}

pub struct Surface {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    /// Whether every pixel currently in the buffer is fully opaque, observed while
    /// converting. Painting trusts this to skip work the surface will cover.
    pub opaque: bool,
}

thread_local! {
    static SURFACES: RefCell<HashMap<u32, Surface>> = RefCell::new(HashMap::new());
}

/// Where a frame's BGRA bytes live, which decides how they are read.
pub enum Source<'a> {
    /// Ordinary cached memory: a software bitmap, or a locked macOS
    /// IOSurface. Rows are compared against the previous frame so an
    /// unchanged frame reports an empty region and costs no repaint.
    Cached { bgra: &'a [u8], stride: usize },
    /// Write-combined or uncached memory: a mapped Linux dmabuf. Read once
    /// with streaming loads; the producer's damage rect is trusted instead
    /// of comparing pixels, because re-reading this memory is what's slow.
    Uncached { bgra: &'a [u8], stride: usize },
}

/// Converts a frame into the surface's own rgba buffer, touching only the
/// rows the producer says changed. Returns the region worth repainting:
/// everything on a resize (there is no previous content worth keeping),
/// nothing when a cached source turns out identical to what is stored.
pub fn write(id: u32, width: u32, height: u32, damage: Option<Rect>, source: Source<'_>) -> Rect {
    SURFACES.with_borrow_mut(|surfaces| {
        let surface = surfaces.entry(id).or_insert(Surface {
            width: 0,
            height: 0,
            pixels: Vec::new(),
            opaque: false,
        });
        let resized = surface.width != width || surface.height != height;
        if resized {
            surface.width = width;
            surface.height = height;
            surface
                .pixels
                .resize(width as usize * height as usize * 4, 0);
        }
        let region = match damage {
            Some(damage) if !resized => damage.clamped(width, height),
            _ => Rect::sized(width, height),
        };
        if region.is_empty() {
            return region;
        }
        let whole = region == Rect::sized(width, height);
        let (changed, region_opaque) = match source {
            Source::Cached { bgra, stride } => {
                let converted =
                    convert::region_cached(&mut surface.pixels, width, bgra, stride, region);
                (converted.changed, converted.opaque)
            }
            Source::Uncached { bgra, stride } => (
                true,
                convert::region_uncached(&mut surface.pixels, width, bgra, stride, region),
            ),
        };
        // A partial write can only preserve opacity, never establish it: pixels outside
        // the region keep whatever alpha they had.
        surface.opaque = region_opaque && (surface.opaque || whole);
        if !changed && !resized {
            crate::profiler::count("surface.unchanged", 1);
            return Rect::default();
        }
        region
    })
}

pub fn remove(id: u32) {
    SURFACES.with_borrow_mut(|surfaces| {
        surfaces.remove(&id);
    });
}

pub fn with<R>(id: u32, read: impl FnOnce(&Surface) -> R) -> Option<R> {
    SURFACES.with_borrow(|surfaces| surfaces.get(&id).map(read))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bgra(pixels: &[[u8; 4]]) -> Vec<u8> {
        pixels.iter().flatten().copied().collect()
    }

    fn cached(bgra: &[u8], stride: usize) -> Source<'_> {
        Source::Cached { bgra, stride }
    }

    #[test]
    fn union_of_disjoint_rects_covers_both() {
        let a = Rect { x: 2, y: 3, w: 1, h: 1 };
        let b = Rect { x: 8, y: 1, w: 2, h: 4 };
        assert_eq!(a.union(b), Rect { x: 2, y: 1, w: 8, h: 4 });
        assert_eq!(a.union(Rect::default()), a);
        assert_eq!(Rect::default().union(b), b);
    }

    #[test]
    fn a_rect_running_past_the_surface_is_clipped_to_it() {
        let rect = Rect { x: 6, y: 0, w: 10, h: 10 };
        assert_eq!(rect.clamped(8, 4), Rect { x: 6, y: 0, w: 2, h: 4 });
    }

    #[test]
    fn the_first_frame_writes_the_whole_surface() {
        let source = bgra(&[[1, 2, 3, 4], [5, 6, 7, 8]]);
        let damage = Rect { x: 0, y: 0, w: 1, h: 1 };
        assert_eq!(
            write(1, 2, 1, Some(damage), cached(&source, 8)),
            Rect::sized(2, 1)
        );
        with(1, |s| assert_eq!(s.pixels, [3, 2, 1, 4, 7, 6, 5, 8])).unwrap();
        remove(1);
    }

    #[test]
    fn later_frames_only_touch_the_damaged_pixels() {
        write(2, 2, 1, None, cached(&bgra(&[[1, 2, 3, 4], [5, 6, 7, 8]]), 8));
        let second = bgra(&[[9, 9, 9, 9], [10, 20, 30, 40]]);
        let damage = Rect { x: 1, y: 0, w: 1, h: 1 };
        assert_eq!(write(2, 2, 1, Some(damage), cached(&second, 8)), damage);
        with(2, |s| assert_eq!(s.pixels, [3, 2, 1, 4, 30, 20, 10, 40])).unwrap();
        remove(2);
    }

    #[test]
    fn a_resize_ignores_damage_because_there_is_nothing_to_keep() {
        write(3, 1, 1, None, cached(&bgra(&[[1, 2, 3, 4]]), 4));
        let grown = bgra(&[[1, 2, 3, 4], [5, 6, 7, 8]]);
        let damage = Rect { x: 0, y: 0, w: 1, h: 1 };
        assert_eq!(
            write(3, 2, 1, Some(damage), cached(&grown, 8)),
            Rect::sized(2, 1)
        );
        with(3, |s| assert_eq!(s.pixels, [3, 2, 1, 4, 7, 6, 5, 8])).unwrap();
        remove(3);
    }

    #[test]
    fn an_identical_cached_frame_reports_nothing_changed() {
        let source = bgra(&[[1, 2, 3, 255], [5, 6, 7, 255]]);
        write(4, 2, 1, None, cached(&source, 8));
        assert_eq!(write(4, 2, 1, None, cached(&source, 8)), Rect::default());
        remove(4);
    }

    fn gradient(width: u32, height: u32, stride: usize, translucent_at: Option<(usize, usize)>) -> Vec<u8> {
        let mut src = vec![0u8; stride * height as usize];
        for y in 0..height as usize {
            for x in 0..width as usize {
                let o = y * stride + x * 4;
                src[o] = (x * 7 + y) as u8;
                src[o + 1] = (x * 13 + y * 3) as u8;
                src[o + 2] = (x + y * 11) as u8;
                src[o + 3] = if translucent_at == Some((x, y)) { 0x40 } else { 0xFF };
            }
        }
        src
    }

    #[test]
    fn uncached_writes_match_cached_writes_pixel_for_pixel() {
        let (w, h, stride) = (301u32, 47u32, 301 * 4 + 12);
        let src = gradient(w, h, stride, None);
        let plain = write(90_001, w, h, None, Source::Cached { bgra: &src, stride });
        let fused = write(90_002, w, h, None, Source::Uncached { bgra: &src, stride });
        assert_eq!(plain, fused);
        let a = with(90_001, |s| s.pixels.clone()).unwrap();
        let b = with(90_002, |s| s.pixels.clone()).unwrap();
        assert_eq!(a, b);
        assert_eq!(with(90_001, |s| s.opaque), with(90_002, |s| s.opaque));
        remove(90_001);
        remove(90_002);
    }

    #[test]
    fn uncached_writes_handle_odd_damage_offsets() {
        let (w, h, stride) = (128u32, 32u32, 128 * 4);
        let src = gradient(w, h, stride, None);
        write(90_003, w, h, None, Source::Uncached { bgra: &src, stride });
        let mut src2 = src.clone();
        for y in 5..9 {
            for x in 3..61 {
                src2[y * stride + x * 4] = 0xAB;
            }
        }
        let damage = Rect { x: 3, y: 5, w: 58, h: 4 };
        write(90_003, w, h, Some(damage), Source::Uncached { bgra: &src2, stride });
        write(90_004, w, h, None, Source::Cached { bgra: &src2, stride });
        let a = with(90_003, |s| s.pixels.clone()).unwrap();
        let b = with(90_004, |s| s.pixels.clone()).unwrap();
        assert_eq!(a, b, "odd-x damage swizzles identically");
        remove(90_003);
        remove(90_004);
    }

    #[test]
    fn uncached_writes_detect_translucency() {
        let (w, h, stride) = (64u32, 16u32, 64 * 4);
        let src = gradient(w, h, stride, Some((3, 2)));
        write(90_005, w, h, None, Source::Uncached { bgra: &src, stride });
        assert_eq!(with(90_005, |s| s.opaque), Some(false));
        remove(90_005);
    }
}

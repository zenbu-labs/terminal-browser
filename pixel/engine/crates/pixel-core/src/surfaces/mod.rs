

use std::cell::RefCell;
use std::collections::HashMap;

mod convert;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpaqueArea {
    pub surface: Option<u32>,
    pub rect: Rect,
}

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

    pub fn covering(area: crate::tree::PxRect) -> Rect {
        let (x, y) = (area.x.floor().max(0.0), area.y.floor().max(0.0));
        Rect {
            x: x as u32,
            y: y as u32,
            w: ((area.x + area.w).ceil() - x).max(0.0) as u32,
            h: ((area.y + area.h).ceil() - y).max(0.0) as u32,
        }
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

    pub fn area(self) -> u64 {
        u64::from(self.w) * u64::from(self.h)
    }

    pub fn contains(self, other: Rect) -> bool {
        !other.is_empty()
            && other.x >= self.x
            && other.y >= self.y
            && other.x + other.w <= self.x + self.w
            && other.y + other.h <= self.y + self.h
    }

    pub fn intersects(self, other: Rect) -> bool {
        !self.is_empty()
            && !other.is_empty()
            && self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }
}

/// One row of a compared region that differs, as the pixel span `[x0, x1)`.
#[derive(Clone, Copy, Debug)]
pub struct RowChange {
    pub y: u32,
    pub x0: u32,
    pub x1: u32,
}

// https://github.com/zenbu-labs/pixel/pull/18
pub const IMAGE_OVERHEAD_PX: u64 = 30_000;
const MAX_CHANGED_RECTS: usize = 32;

/// Blank pixels a rect covering both would add over keeping them apart.
fn wasted(a: Rect, b: Rect) -> u64 {
    a.union(b).area().saturating_sub(a.area() + b.area())
}
pub fn group_rects(rects: impl IntoIterator<Item = Rect>) -> Vec<Rect> {
    let mut out: Vec<Rect> = Vec::new();
    for rect in rects {
        if rect.is_empty() {
            continue;
        }
        let full = out.len() >= MAX_CHANGED_RECTS;
        match out.last_mut() {
            Some(last) if full || wasted(*last, rect) < IMAGE_OVERHEAD_PX => *last = last.union(rect),
            _ => out.push(rect),
        }
    }
    out
}

pub fn rects_from_rows(changes: Vec<RowChange>) -> Vec<Rect> {
    group_rects(changes.into_iter().map(|c| Rect { x: c.x0, y: c.y, w: c.x1 - c.x0, h: 1 }))
}

pub struct Surface {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

thread_local! {
    static SURFACES: RefCell<HashMap<u32, Surface>> = RefCell::new(HashMap::new());
}


pub fn write(
    id: u32,
    width: u32,
    height: u32,
    damage: Option<&[Rect]>,
    bgra: &[u8],
    stride: usize,
) -> Vec<Rect> {
    SURFACES.with_borrow_mut(|surfaces| {
        let surface = surfaces.entry(id).or_insert(Surface {
            width: 0,
            height: 0,
            pixels: Vec::new(),
        });
        let resized = surface.width != width || surface.height != height;
        if resized {
            surface.width = width;
            surface.height = height;
            surface
                .pixels
                .resize(width as usize * height as usize * 4, 0);
        }
        if resized {
            let whole = Rect::sized(width, height);
            convert::region(&mut surface.pixels, width, bgra, stride, whole);
            return vec![whole];
        }
        let whole = [Rect::sized(width, height)];
        let regions: &[Rect] = damage.unwrap_or(&whole);
        let mut changed: Vec<Rect> = Vec::new();
        for region in regions {
            let region = region.clamped(width, height);
            if region.is_empty() {
                continue;
            }
            changed.extend(convert::region_tight(&mut surface.pixels, width, bgra, stride, region));
        }
        if changed.is_empty() {
            crate::profiler::count("surface.unchanged", || 1);
        }
        changed
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
    fn a_first_frame_or_a_resize_writes_the_whole_surface_whatever_the_damage() {
        let source = bgra(&[[1, 2, 3, 4]]);
        let damage = Rect { x: 0, y: 0, w: 1, h: 1 };
        assert_eq!(write(1, 1, 1, Some(&[damage]), &source, 4), vec![Rect::sized(1, 1)]);
        with(1, |s| assert_eq!(s.pixels, source)).unwrap();
        let grown = bgra(&[[1, 2, 3, 4], [5, 6, 7, 8]]);
        assert_eq!(write(1, 2, 1, Some(&[damage]), &grown, 8), vec![Rect::sized(2, 1)]);
        with(1, |s| assert_eq!(s.pixels, grown)).unwrap();
        remove(1);
    }

    #[test]
    fn later_frames_only_touch_the_damaged_pixels() {
        write(2, 2, 1, None, &bgra(&[[1, 2, 3, 4], [5, 6, 7, 8]]), 8);
        let second = bgra(&[[9, 9, 9, 9], [10, 20, 30, 40]]);
        let damage = Rect { x: 1, y: 0, w: 1, h: 1 };
        assert_eq!(write(2, 2, 1, Some(&[damage]), &second, 8), vec![damage]);
        with(2, |s| assert_eq!(s.pixels, [1, 2, 3, 4, 10, 20, 30, 40])).unwrap();
        remove(2);
    }

    #[test]
    fn an_identical_frame_reports_nothing_changed_with_or_without_damage() {
        let source = bgra(&[[1, 2, 3, 255], [5, 6, 7, 255]]);
        write(4, 2, 1, None, &source, 8);
        assert!(write(4, 2, 1, None, &source, 8).is_empty());
        let damage = Rect { x: 0, y: 0, w: 2, h: 1 };
        assert!(write(4, 2, 1, Some(&[damage]), &source, 8).is_empty());
        remove(4);
    }

    #[test]
    fn a_bounding_dirty_rect_narrows_to_the_pixels_that_changed() {
        let (w, h) = (4u32, 40u32);
        let mut first = vec![0u8; (w * h * 4) as usize];
        for px in first.chunks_exact_mut(4) {
            px.copy_from_slice(&[9, 9, 9, 255]);
        }
        write(6, w, h, None, &first, w as usize * 4);
        let mut second = first.clone();
        let at = |x: u32, y: u32| ((y * w + x) * 4) as usize;
        second[at(1, 2)..at(1, 2) + 4].copy_from_slice(&[1, 1, 1, 255]);
        second[at(3, 30)..at(3, 30) + 4].copy_from_slice(&[2, 2, 2, 255]);
        second[at(2, 31)..at(2, 31) + 4].copy_from_slice(&[3, 3, 3, 255]);
        let parts = write(6, w, h, Some(&[Rect::sized(w, h)]), &second, w as usize * 4);
        // Far apart down a surface this narrow, one rect covering all three costs 85 blank
        // pixels, far less than a second image is worth.
        assert_eq!(parts, vec![Rect { x: 1, y: 2, w: 3, h: 30 }]);
        remove(6);
    }

    #[test]
    fn changes_far_apart_on_a_wide_surface_stay_separate() {
        let (w, h) = (2000u32, 60u32);
        let mut first = vec![0u8; (w * h * 4) as usize];
        for px in first.chunks_exact_mut(4) {
            px.copy_from_slice(&[9, 9, 9, 255]);
        }
        write(7, w, h, None, &first, w as usize * 4);
        let mut second = first.clone();
        let at = |x: u32, y: u32| ((y * w + x) * 4) as usize;
        second[at(10, 2)..at(10, 2) + 4].copy_from_slice(&[1, 1, 1, 255]);
        second[at(1900, 50)..at(1900, 50) + 4].copy_from_slice(&[2, 2, 2, 255]);
        let parts = write(7, w, h, Some(&[Rect::sized(w, h)]), &second, w as usize * 4);
        // Joining these would blank out most of a 1891 by 49 rect, so they travel apart.
        assert_eq!(
            parts,
            vec![Rect { x: 10, y: 2, w: 1, h: 1 }, Rect { x: 1900, y: 50, w: 1, h: 1 }]
        );
        remove(7);
    }


}

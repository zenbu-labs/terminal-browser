
use super::patched::Patched;
use super::tiles::{intersect, subtract};
use pixel_raster::{Canvas, PixelFrame as Frame};
use pixel_core::surfaces::Rect;

impl Patched {
    pub(super) fn reset_screen(&mut self, canvas: &Canvas) {
        self.shown.clear();
        self.shown.extend_from_slice(&canvas.pixels);
    }

    /// Records that the terminal now shows the canvas inside `rect`.
    pub(super) fn remember_exact(&mut self, canvas: &Canvas, rect: Rect) {
        if self.shown.len() == canvas.pixels.len() {
            copy_region(&canvas.pixels, &mut self.shown, canvas.width, rect);
        }
    }

    pub(super) fn outside_surfaces(&self, rect: Rect) -> Vec<Rect> {
        let mut pieces = vec![rect];
        for area in self.opaque.iter().filter(|area| area.surface.is_some()) {
            pieces = subtract(&pieces, area.rect);
        }
        pieces
    }

    pub(super) fn compared_pieces(&self, rect: Rect) -> Vec<Rect> {
        let mut pieces = self.outside_surfaces(rect);
        pieces.extend(self.ui_over_surfaces.iter().map(|ui| intersect(rect, *ui)).filter(|r| !r.is_empty()));
        pieces
    }

    pub(super) fn changed_within(&self, canvas: &Canvas, rect: Rect) -> Option<Rect> {
        let stride = canvas.width as usize * 4;
        let (mut top, mut bottom, mut left, mut right) = (u32::MAX, 0u32, u32::MAX, 0u32);
        for row in rect.y..rect.y + rect.h {
            let start = row as usize * stride + rect.x as usize * 4;
            let end = start + rect.w as usize * 4;
            let (now, was) = (&canvas.pixels[start..end], &self.shown[start..end]);
            if now == was {
                continue;
            }
            top = top.min(row);
            bottom = row;
            let first = now.chunks_exact(4).zip(was.chunks_exact(4)).position(|(a, b)| a != b).unwrap_or(0) as u32;
            let last = rect.w - 1 - now.chunks_exact(4).zip(was.chunks_exact(4)).rev().position(|(a, b)| a != b).unwrap_or(0) as u32;
            left = left.min(rect.x + first);
            right = right.max(rect.x + last);
        }
        (top != u32::MAX).then(|| Rect { x: left, y: top, w: right - left + 1, h: bottom - top + 1 })
    }

    pub(super) fn damage(&self, frame: Frame<'_>, previous_ui: &[Rect]) -> Vec<Rect> {
        let size = (frame.canvas.width, frame.canvas.height);
        let mut out: Vec<Rect> = frame.changed.iter().map(|r| r.clamped(size.0, size.1)).filter(|r| !r.is_empty()).collect();
        out.extend(self.ui_over_surfaces.iter().filter(|ui| !previous_ui.contains(ui)).copied());
        out
    }
}

pub(super) fn copy_region(from: &[u8], to: &mut [u8], width: u32, rect: Rect) {
    if rect.is_empty() {
        return;
    }
    let stride = width as usize * 4;
    for row in rect.y..rect.y + rect.h {
        let start = row as usize * stride + rect.x as usize * 4;
        let end = start + rect.w as usize * 4;
        to[start..end].copy_from_slice(&from[start..end]);
    }
}

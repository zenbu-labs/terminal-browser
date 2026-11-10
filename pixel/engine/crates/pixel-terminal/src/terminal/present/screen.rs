
use super::patched::Patched;
use super::tiles::{intersect, subtract};
use pixel_raster::{Canvas, PixelFrame as Frame};
use pixel_core::surfaces::Rect;

const DIFF_BLOCK: u32 = 64;

impl Patched {
    fn block_grid(frame: (u32, u32)) -> (u32, u32) {
        (frame.0.max(1).div_ceil(DIFF_BLOCK), frame.1.max(1).div_ceil(DIFF_BLOCK))
    }

    fn block_rect(&self, bx: u32, by: u32, frame: (u32, u32)) -> Rect {
        Rect { x: bx * DIFF_BLOCK, y: by * DIFF_BLOCK, w: DIFF_BLOCK, h: DIFF_BLOCK }.clamped(frame.0, frame.1)
    }

    pub(super) fn reset_screen(&mut self, canvas: &Canvas) {
        self.shown.clear();
        self.shown.extend_from_slice(&canvas.pixels);
    }

    fn screen_valid(&self, canvas: &Canvas) -> bool {
        self.shown.len() == canvas.pixels.len() && self.base == Some((canvas.width, canvas.height))
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

    pub(super) fn refine_damage(&self, frame: Frame<'_>, previous_ui: &[Rect]) -> Vec<Rect> {
        let canvas = frame.canvas;
        let size = (canvas.width, canvas.height);
        let clamp = |r: &Rect| r.clamped(size.0, size.1);
        if !self.screen_valid(canvas) {
            return frame.changed.iter().chain(frame.repainted).map(clamp).filter(|r| !r.is_empty()).collect();
        }
        let mut out: Vec<Rect> = Vec::new();
        out.extend(frame.changed.iter().map(clamp).filter(|r| !r.is_empty()));
        out.extend(self.ui_over_surfaces.iter().filter(|ui| !previous_ui.contains(ui)).copied());
        for rect in frame.repainted.iter().map(clamp).filter(|r| !r.is_empty()) {
            let mut runs = Vec::new();
            let mut pieces = self.outside_surfaces(rect);
            pieces.extend(previous_ui.iter().map(|ui| intersect(rect, *ui)).filter(|r| !r.is_empty()));
            for piece in pieces {
                self.scan_blocks(canvas, piece, &mut runs);
            }
            out.extend(pixel_core::surfaces::group_rects(runs));
        }
        out
    }

    fn scan_blocks(&self, canvas: &Canvas, rect: Rect, out: &mut Vec<Rect>) {
        let frame = (canvas.width, canvas.height);
        let (cols, rows) = Self::block_grid(frame);
        let x0 = rect.x / DIFF_BLOCK;
        let x1 = ((rect.x + rect.w - 1) / DIFF_BLOCK).min(cols - 1);
        let y0 = rect.y / DIFF_BLOCK;
        let y1 = ((rect.y + rect.h - 1) / DIFF_BLOCK).min(rows - 1);
        for by in y0..=y1 {
            let mut run: Option<Rect> = None;
            for bx in x0..=x1 {
                let block = intersect(self.block_rect(bx, by, frame), rect);
                match self.changed_within(canvas, block) {
                    Some(part) => run = Some(run.map_or(part, |current: Rect| current.union(part))),
                    None => {
                        if let Some(current) = run.take() {
                            out.push(current);
                        }
                    }
                }
            }
            if let Some(current) = run {
                out.push(current);
            }
        }
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

pub mod color;
pub mod device;
pub mod encode;
pub mod grid;
pub mod paint;
mod test_backend;

use pixel_core::HostColors;
use pixel_core::backend::Frame;

pub use color::{CellColor, ColorTier, Palette};
pub use device::{CellMetrics, cell_device};
pub use encode::Encoder;
pub use grid::CellGrid;
pub use paint::Caret;
pub use test_backend::{TestBackend, TestHandle};

pub struct CellPresenter {
    cell: (f32, f32),
    size: (u16, u16),
    palette: Palette,
    host: HostColors,
    current: CellGrid,
    next: CellGrid,
    encoder: Encoder,
    caret: Option<Caret>,
    stale: bool,
    offsets: std::collections::HashMap<(usize, u64), f32>,
}

impl CellPresenter {
    pub fn new(tier: ColorTier, host: HostColors, cell: (u32, u32), size: (u16, u16)) -> Self {
        Self {
            cell: (cell.0.max(1) as f32, cell.1.max(1) as f32),
            size,
            palette: Palette::new(tier, &host),
            host,
            current: CellGrid::new(size.0, size.1),
            next: CellGrid::new(size.0, size.1),
            encoder: Encoder::default(),
            caret: None,
            stale: true,
            offsets: std::collections::HashMap::new(),
        }
    }

    pub fn tier(&self) -> ColorTier {
        self.palette.tier
    }

    pub fn set_tier(&mut self, tier: ColorTier) {
        if tier != self.palette.tier {
            self.palette = Palette::new(tier, &self.host);
            self.stale = true;
        }
    }

    pub fn set_colors(&mut self, host: HostColors) {
        if host != self.host {
            self.host = host;
            self.palette = Palette::new(self.palette.tier, &host);
            self.stale = true;
        }
    }

    pub fn set_geometry(&mut self, cell: (u32, u32), size: (u16, u16)) {
        let cell = (cell.0.max(1) as f32, cell.1.max(1) as f32);
        if cell != self.cell || size != self.size {
            self.cell = cell;
            self.size = size;
            self.stale = true;
        }
    }

    pub fn redraw(&mut self) {
        self.stale = true;
    }

    pub fn grid(&self) -> &CellGrid {
        &self.current
    }

    pub fn caret(&self) -> Option<Caret> {
        self.caret
    }

    fn moved_layers(&mut self, frame: &Frame<'_>) -> Vec<encode::Scroll> {
        let mut out = Vec::new();
        for view in frame.views {
            if !matches!(view.damage, pixel_core::scene::Damage::Whole { .. }) {
                continue;
            }
            let mut layers = Vec::new();
            scroll_layers(&view.scene.root, None, &mut layers);
            for (node, visible, offset) in layers {
                let Some(before) = self.offsets.insert((view.view, node), offset) else { continue };
                let rows = (offset - before) / self.cell.1;
                if rows.fract() != 0.0 || rows == 0.0 {
                    continue;
                }
                let top = (visible.y / self.cell.1).round().max(0.0) as u16;
                let bottom = ((visible.y + visible.h) / self.cell.1).round().min(self.size.1 as f32) as u16;
                if bottom > top && (rows.abs() as u16) < bottom - top {
                    out.push(encode::Scroll { top, bottom, by: rows as i32 });
                }
            }
        }
        out
    }

    fn worth_scrolling(&mut self, moved: Vec<encode::Scroll>) -> Vec<encode::Scroll> {
        let mut out = Vec::new();
        for scroll in moved {
            let (top, bottom) = (scroll.top, scroll.bottom);
            if self.next.stale_cells(&self.current, top, bottom, scroll.by) < self.next.stale_cells(&self.current, top, bottom, 0) {
                self.current.scroll(top, bottom, scroll.by);
                out.push(scroll);
            }
        }
        out
    }

    pub fn present(&mut self, frame: &Frame<'_>, out: &mut Vec<u8>) {
        let changed = frame.views.iter().any(|view| view.damage != pixel_core::scene::Damage::None);
        if !changed && !self.stale {
            return;
        }
        if (self.next.width, self.next.height) != self.size {
            self.next.resize(self.size.0, self.size.1);
        }
        let moved = self.moved_layers(frame);
        self.next.clear(self.palette.foreground, self.palette.background);
        let mut caret = None;
        for view in frame.views {
            if let Some(found) = paint::paint_view(&mut self.next, &self.palette, self.cell, view) {
                caret = Some(found);
            }
        }
        paint::finish(&mut self.next, &self.palette);
        if self.stale || (self.current.width, self.current.height) != self.size {
            self.encoder.full(&self.next, caret, out);
        } else {
            let scrolls = self.worth_scrolling(moved);
            self.encoder.diff_scrolled(&self.current, &self.next, &scrolls, caret, out);
        }
        self.stale = false;
        self.caret = caret;
        std::mem::swap(&mut self.current, &mut self.next);
    }
}

fn scroll_layers(item: &pixel_core::scene::Item, clip: Option<pixel_core::PxRect>, out: &mut Vec<(u64, pixel_core::PxRect, f32)>) {
    let visible = clip.map_or(item.bounds, |c| item.bounds.intersect(c));
    if let Some(scroll) = item.scroll() {
        out.push((item.node, visible, scroll.offset));
    }
    let inner = if item.clips { Some(visible) } else { clip };
    for child in &item.children {
        scroll_layers(child, inner, out);
    }
}

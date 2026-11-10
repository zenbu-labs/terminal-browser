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

    pub fn present(&mut self, frame: &Frame<'_>, out: &mut Vec<u8>) {
        let changed = frame.scenes.iter().any(|view| view.changed);
        if !changed && !self.stale {
            return;
        }
        if (self.next.width, self.next.height) != self.size {
            self.next.resize(self.size.0, self.size.1);
        }
        self.next.clear(self.palette.foreground, self.palette.background);
        let mut caret = None;
        for view in frame.scenes {
            if let Some(found) = paint::paint_view(&mut self.next, &self.palette, self.cell, view) {
                caret = Some(found);
            }
        }
        paint::finish(&mut self.next, &self.palette);
        if self.stale || (self.current.width, self.current.height) != self.size {
            self.encoder.full(&self.next, caret, out);
        } else {
            self.encoder.diff(&self.current, &self.next, caret, out);
        }
        self.stale = false;
        self.caret = caret;
        std::mem::swap(&mut self.current, &mut self.next);
    }
}

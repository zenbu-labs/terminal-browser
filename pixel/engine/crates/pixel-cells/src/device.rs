use std::sync::Arc;

use pixel_core::fonts::Font;
use pixel_core::text_metrics::{LineMetrics, TextMetrics};
use pixel_core::{ColorDepth, Device, Pointer, Step};

use crate::ColorTier;

#[derive(Debug, Clone, Copy)]
pub struct CellMetrics {
    pub cell: (f32, f32),
}

pub fn columns(ch: char) -> usize {
    match ch {
        '\u{FE0F}' | '\t' => 1,
        _ if ch.is_control() => 0,
        _ => unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0),
    }
}

impl TextMetrics for CellMetrics {
    fn advance(&self, _font: &Font, ch: char, _px: f32) -> f32 {
        columns(ch) as f32 * self.cell.0
    }

    fn line(&self, _font: &Font, _px: f32) -> LineMetrics {
        let height = self.cell.1;
        LineMetrics { ascent: height * 0.8, descent: -height * 0.2, line_gap: 0.0, new_line_size: height }
    }
}

pub const WHEEL_LINES: f32 = 3.0;

pub fn cell_device(cell: (u32, u32), tier: ColorTier) -> Device {
    let cell = (cell.0.max(1) as f32, cell.1.max(1) as f32);
    Device {
        name: "cells".into(),
        text: Arc::new(CellMetrics { cell }),
        lattice: cell,
        scroll: Arc::new(Step { per_tick: WHEEL_LINES }),
        colors: match tier {
            ColorTier::TrueColor => ColorDepth::TrueColor,
            ColorTier::Ansi256 => ColorDepth::Indexed256,
            ColorTier::Ansi16 => ColorDepth::Indexed16,
            ColorTier::Mono => ColorDepth::Monochrome,
        },
        pointer: Pointer::Coarse,
    }
}

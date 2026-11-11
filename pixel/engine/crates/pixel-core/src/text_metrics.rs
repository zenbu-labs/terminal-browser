use std::ops::Range;

use crate::fonts::Font;
use crate::system_fonts;
use crate::text_input::{MARK_CHAR, Mark, mark_advance_at};

pub use fontdue::LineMetrics;

pub trait TextMetrics: Send + Sync {
    fn advance(&self, font: &Font, ch: char, px: f32) -> f32;
    fn line(&self, font: &Font, px: f32) -> LineMetrics;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct FontMetrics;

impl TextMetrics for FontMetrics {
    fn advance(&self, font: &Font, ch: char, px: f32) -> f32 {
        if draws_itself(font, ch) {
            return font.metrics(ch, px).advance_width;
        }
        match monospace_advance(font, px) {
            Some(cell) => cell * columns(ch) as f32,
            None => natural_fallback_advance(font, ch, px),
        }
    }

    fn line(&self, font: &Font, px: f32) -> LineMetrics {
        font.primary().horizontal_line_metrics(px).expect("font has horizontal metrics")
    }
}

pub fn monospace_advance(font: &Font, px: f32) -> Option<f32> {
    let narrow = font.metrics('i', px).advance_width;
    (narrow > 0.0 && narrow == font.metrics('M', px).advance_width).then_some(narrow)
}

pub fn draws_itself(font: &Font, ch: char) -> bool {
    ch.is_control() || font.lookup_glyph_index(ch) != 0 || (ch.is_whitespace() && font.fallback_for(ch).is_none())
}

pub fn columns(ch: char) -> usize {
    unicode_width::UnicodeWidthChar::width(ch).unwrap_or(1)
}

fn natural_fallback_advance(font: &Font, ch: char, px: f32) -> f32 {
    if let Some(face) = font.fallback_for(ch) {
        return face.metrics(ch, px).advance_width;
    }
    system_fonts::advance(ch, px).unwrap_or_else(|| if columns(ch) == 0 { 0.0 } else { font.metrics(ch, px).advance_width })
}

type AdvanceKey = (usize, char, u32);

std::thread_local! {
    static ADVANCE_CACHE: std::cell::RefCell<std::collections::HashMap<AdvanceKey, f32>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

fn cached_advance(font: &Font, ch: char, px: f32) -> f32 {
    ADVANCE_CACHE.with_borrow_mut(|cache| *cache.entry((font.id(), ch, px.to_bits())).or_insert_with(|| font.text_metrics().advance(font, ch, px)))
}

pub fn measure_text(font: &Font, text: &str, px: f32) -> f32 {
    measure_marked(font, text, 0..text.len(), px, &[])
}

pub fn measure_marked(font: &Font, text: &str, range: Range<usize>, px: f32, marks: &[Mark]) -> f32 {
    text[range.clone()]
        .char_indices()
        .map(|(i, ch)| if ch == MARK_CHAR { mark_advance_at(marks, range.start + i) } else { cached_advance(font, ch, px) })
        .sum()
}

pub fn char_advance(font: &Font, ch: char, offset: usize, px: f32, marks: &[Mark]) -> f32 {
    if ch == MARK_CHAR {
        return mark_advance_at(marks, offset);
    }
    cached_advance(font, ch, px)
}

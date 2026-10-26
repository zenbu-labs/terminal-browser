
use std::io;
use std::time::{Duration, Instant};

use super::super::Terminal;
use crate::canvas::Canvas;
use crate::kitty::{Placement, Transmit};
use crate::surfaces::Rect;
use crate::wrapper::Wrapper;

const FIRST_NOTE_ID: u32 = 20_000;
const STATUS_ID: u32 = 20_100;
const MAX_NOTES: usize = 6;
// overflow protection
const Z: i32 = (1 << 30) + 1;
const NOTE_LIFETIME: Duration = Duration::from_millis(1600);
const MARGIN: u32 = 8;
const PAD: u32 = 6;
const NOTE_FG: [u8; 4] = [255, 255, 255, 255];
const NOTE_BG: [u8; 4] = [180, 30, 120, 255];
const STATUS_FG: [u8; 4] = [210, 215, 225, 255];
const STATUS_BG: [u8; 4] = [20, 21, 26, 255];

struct Note {
    id: u32,
    text: String,
    born: Instant,
    placed: Option<Rect>,
}

#[derive(Default)]
pub(crate) struct Overlay {
    font: Option<crate::fonts::Font>,
    frame: (u32, u32),
    notes: Vec<Note>,
    next: u32,
    status: String,
    status_shown: String,
    status_placed: Option<Rect>,
}

impl Overlay {
    fn on(&self) -> bool {
        self.font.is_some()
    }
}

fn render(font: &crate::fonts::Font, text: &str, px: f32, fg: [u8; 4], bg: [u8; 4]) -> (u32, u32, Vec<u8>) {
    let metrics = font.horizontal_line_metrics(px);
    let ascent = metrics.map_or(px * 0.8, |m| m.ascent);
    let line = metrics.map_or(px * 1.4, |m| m.ascent - m.descent + m.line_gap);
    let width = crate::canvas::measure_text(font, text, px).ceil().max(1.0) as u32 + PAD * 2;
    let height = line.ceil().max(1.0) as u32 + PAD;
    let mut canvas = Canvas::new(width, height);
    canvas.fill_rect(0, 0, width, height, bg);
    canvas.draw_text(font, text, PAD as i32, (ascent + PAD as f32 / 2.0) as i32, px, fg);
    (width, height, canvas.pixels)
}

impl Terminal {
    pub fn set_overlay_font(&mut self, font: crate::fonts::Font) {
        self.overlay.font = Some(font);
    }

    pub fn overlay_off(&mut self) -> io::Result<()> {
        if !self.overlay.on() {
            return Ok(());
        }
        let mut out = Vec::new();
        for note in self.overlay.notes.drain(..) {
            out.extend_from_slice(&crate::kitty::kitty_delete_one(note.id));
        }
        if self.overlay.status_placed.take().is_some() {
            out.extend_from_slice(&crate::kitty::kitty_delete_one(STATUS_ID));
        }
        self.overlay.status_shown.clear();
        self.overlay.font = None;
        self.write_overlay(&out)
    }

    pub(crate) fn note(&mut self, text: impl Into<String>) {
        if !self.overlay.on() {
            return;
        }
        let id = FIRST_NOTE_ID + self.overlay.next % MAX_NOTES as u32;
        self.overlay.next += 1;
        if self.overlay.notes.len() == MAX_NOTES {
            self.overlay.notes.remove(0);
        }
        self.overlay.notes.push(Note { id, text: text.into(), born: Instant::now(), placed: None });
    }

    pub(in crate::terminal) fn set_status(&mut self, text: String) {
        if self.overlay.on() {
            self.overlay.status = text;
        }
    }

    pub(in crate::terminal) fn overlay_frame(&mut self, size: (u32, u32)) {
        self.overlay.frame = size;
    }

    pub(crate) fn overlay_due(&self) -> Option<Instant> {
        self.overlay.notes.iter().map(|n| n.born + NOTE_LIFETIME).min()
    }

    pub(crate) fn draw_overlay(&mut self) -> io::Result<()> {
        let mut out = Vec::new();
        self.append_overlay(&mut out)?;
        self.write_overlay(&out)
    }

    pub(in crate::terminal) fn append_overlay(&mut self, out: &mut Vec<u8>) -> io::Result<()> {
        if !self.overlay.on() || self.overlay.frame.0 == 0 {
            return Ok(());
        }
        let px = (self.cell().1 as f32 * 0.5).clamp(11.0, 18.0);
        let Some(font) = self.overlay.font.clone() else { return Ok(()) };
        let now = Instant::now();

        let mut notes = std::mem::take(&mut self.overlay.notes);
        notes.retain(|note| {
            if now.duration_since(note.born) < NOTE_LIFETIME {
                return true;
            }
            if note.placed.is_some() {
                out.extend_from_slice(&crate::kitty::kitty_delete_one(note.id));
            }
            false
        });
        let mut y = MARGIN;
        for note in &mut notes {
            let (w, h, pixels) = render(&font, &note.text, px, NOTE_FG, NOTE_BG);
            let rect = Rect { x: self.overlay.frame.0.saturating_sub(w) / 2, y, w, h };
            y += h + 4;
            if note.placed == Some(rect) {
                continue;
            }
            self.place_overlay(out, note.id, rect, &pixels, note.placed.is_some());
            note.placed = Some(rect);
        }
        self.overlay.notes = notes;

        if self.overlay.status != self.overlay.status_shown && !self.overlay.status.is_empty() {
            let (w, h, pixels) = render(&font, &self.overlay.status.clone(), px, STATUS_FG, STATUS_BG);
            let rect = Rect {
                x: MARGIN,
                y: self.overlay.frame.1.saturating_sub(h + MARGIN),
                w,
                h,
            };
            let replacing = self.overlay.status_placed.is_some();
            self.place_overlay(out, STATUS_ID, rect, &pixels, replacing);
            self.overlay.status_placed = Some(rect);
            self.overlay.status_shown = self.overlay.status.clone();
        }
        Ok(())
    }

    fn place_overlay(&self, out: &mut Vec<u8>, id: u32, rect: Rect, pixels: &[u8], replacing: bool) {
        let (cw, ch) = self.cell();
        if replacing {
            out.extend_from_slice(&crate::kitty::kitty_delete_placement(id));
        }
        out.extend_from_slice(format!("\x1b[{};{}H", rect.y / ch + 1, rect.x / cw + 1).as_bytes());
        out.extend_from_slice(&crate::kitty::kitty_transmit_placed(
            Transmit {
                image_id: id,
                width: rect.w,
                height: rect.h,
                placement: Placement::Cursor { z: Z, offset: (rect.x % cw, rect.y % ch) },
                transient: self.identity.transient_images(),
            },
            pixels,
            Wrapper::None,
        ));
    }

    fn write_overlay(&mut self, body: &[u8]) -> io::Result<()> {
        self.write_synchronized(body).map(|_| ())
    }
}

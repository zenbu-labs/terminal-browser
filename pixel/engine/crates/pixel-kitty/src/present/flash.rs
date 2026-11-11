
use std::io;
use std::time::{Duration, Instant};

use crate::Kitty;
use crate::kitty::{Placement, Transmit};
use pixel_core::surfaces::Rect;
use crate::wrapper::Wrapper;

const FIRST_ID: u32 = 10_000;
const MAX_FLASHES: usize = 256;
const STRIPS: usize = 4;
const THICKNESS: u32 = 3;
const LIFETIME: Duration = Duration::from_millis(700);
const DIMMED_ALPHA: u8 = 110;
const Z: i32 = 1 << 30;
const WHOLE_FRAME: [u8; 3] = [255, 200, 40];
const PATCH: [u8; 3] = [255, 40, 220];

struct Flash {
    rect: Rect,
    color: [u8; 3],
    born: Instant,
    dimmed: bool,
    ids: [u32; STRIPS],
}

#[derive(Default)]
pub(crate) struct Flashes {
    live: Vec<Flash>,
    next: u32,
}

impl Flashes {
    fn alloc(&mut self) -> [u32; STRIPS] {
        let base = FIRST_ID + (self.next % MAX_FLASHES as u32) * STRIPS as u32;
        self.next += 1;
        [base, base + 1, base + 2, base + 3]
    }
}

fn strips(rect: Rect) -> [Rect; STRIPS] {
    let t = THICKNESS.min(rect.w / 2).min(rect.h / 2);
    let inner_h = rect.h.saturating_sub(2 * t);
    [
        Rect { x: rect.x, y: rect.y, w: rect.w, h: t },
        Rect { x: rect.x, y: rect.y + rect.h - t, w: rect.w, h: t },
        Rect { x: rect.x, y: rect.y + t, w: t, h: inner_h },
        Rect { x: rect.x + rect.w - t, y: rect.y + t, w: t, h: inner_h },
    ]
}

fn solid(rect: Rect, color: [u8; 3], alpha: u8) -> Vec<u8> {
    let px = [color[0], color[1], color[2], alpha];
    px.repeat(rect.area() as usize)
}

impl Kitty {
    pub(super) fn flash(&mut self, out: &mut Vec<u8>, rect: Rect, whole_frame: bool) {
        if self.wrapper.relayed() {
            return;
        }
        if self.flashes.live.len() >= MAX_FLASHES {
            let oldest = self.flashes.live.remove(0);
            delete_strips(out, &oldest);
        }
        let flash = Flash {
            rect,
            color: if whole_frame { WHOLE_FRAME } else { PATCH },
            born: Instant::now(),
            dimmed: false,
            ids: self.flashes.alloc(),
        };
        self.draw_strips(out, &flash, 255);
        self.flashes.live.push(flash);
    }

    pub fn highlight_active(&self) -> bool {
        !self.flashes.live.is_empty()
    }

    pub fn tick_highlights(&mut self) -> io::Result<()> {
        if self.flashes.live.is_empty() {
            return Ok(());
        }
        let now = Instant::now();
        let mut out = Vec::new();
        let mut live = std::mem::take(&mut self.flashes.live);
        live.retain(|flash| {
            if now.duration_since(flash.born) >= LIFETIME {
                delete_strips(&mut out, flash);
                return false;
            }
            true
        });
        for flash in &mut live {
            if flash.dimmed || now.duration_since(flash.born) < LIFETIME / 2 {
                continue;
            }
            flash.dimmed = true;
            let snapshot = Flash { rect: flash.rect, color: flash.color, born: flash.born, dimmed: true, ids: flash.ids };
            self.draw_strips(&mut out, &snapshot, DIMMED_ALPHA);
        }
        self.flashes.live = live;
        if out.is_empty() {
            return Ok(());
        }
        let mut frame = b"\x1b[?2026h".to_vec();
        frame.extend_from_slice(&out);
        frame.extend_from_slice(b"\x1b[?2026l");
        self.io.out().write_all(&frame)?;
        self.io.out().flush()
    }

    fn draw_strips(&self, out: &mut Vec<u8>, flash: &Flash, alpha: u8) {
        let (cw, ch) = self.cell();
        for (id, strip) in flash.ids.iter().zip(strips(flash.rect)) {
            if strip.is_empty() {
                continue;
            }
            out.extend_from_slice(&crate::kitty::kitty_delete_placement(*id));
            out.extend_from_slice(format!("\x1b[{};{}H", strip.y / ch + 1, strip.x / cw + 1).as_bytes());
            out.extend_from_slice(&crate::kitty::kitty_transmit_placed(
                Transmit {
                    image_id: *id,
                    width: strip.w,
                    height: strip.h,
                    placement: Placement::Cursor { z: Z, offset: (strip.x % cw, strip.y % ch) },
                    transient: self.identity.transient_images(),
                },
                &solid(strip, flash.color, alpha),
                Wrapper::None,
            ));
        }
    }
}

fn delete_strips(out: &mut Vec<u8>, flash: &Flash) {
    for id in flash.ids {
        out.extend_from_slice(&crate::kitty::kitty_delete_one(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_frame_the_rect_without_overlapping_and_thin_out_for_tiny_rects() {
        let [top, bottom, left, right] = strips(Rect { x: 10, y: 20, w: 40, h: 30 });
        assert_eq!(top, Rect { x: 10, y: 20, w: 40, h: 3 });
        assert_eq!(bottom, Rect { x: 10, y: 47, w: 40, h: 3 });
        assert_eq!(left, Rect { x: 10, y: 23, w: 3, h: 24 });
        assert_eq!(right, Rect { x: 47, y: 23, w: 3, h: 24 });
        assert!(!top.intersects(left) && !bottom.intersects(right));
        let total: u64 = [top, bottom, left, right].iter().map(|r| r.area()).sum();
        assert_eq!(total, 40 * 30 - 34 * 24);

        let [top, _, left, _] = strips(Rect { x: 0, y: 0, w: 2, h: 5 });
        assert_eq!((top.h, left.w), (1, 1));
    }

    #[test]
    fn ids_cycle_through_a_bounded_range() {
        let mut flashes = Flashes::default();
        let first = flashes.alloc();
        for _ in 1..MAX_FLASHES {
            flashes.alloc();
        }
        assert_eq!(flashes.alloc(), first);
        assert_eq!(first, [FIRST_ID, FIRST_ID + 1, FIRST_ID + 2, FIRST_ID + 3]);
        assert!((FIRST_ID + (MAX_FLASHES * STRIPS) as u32) < 100_000, "highlight ids must stay clear of tile ids");
    }
}

use std::collections::BTreeMap;
use std::io;

use crate::Kitty;
use super::tiles::{TILE_Z, intersect, subtract};
use pixel_raster::{Canvas, Overlay, PixelFrame as Frame, Pixels, ScrollLayer};
use pixel_core::surfaces::Rect;

const STRIPE_PX: u32 = 128;
const MAX_PATCHES: usize = 6;
const JUMP_UPLOAD_BUDGET: usize = 2_200_000;
const INLINE_JUMP_UPLOAD_BUDGET: usize = 900_000;
const MAX_HOLD_FRAMES: u32 = 4;
const PATCH_Z: i32 = TILE_Z;
const FIRST_STRIPE_ID: u32 = 2_000;
const FIRST_OVERLAY_ID: u32 = 30_000;
const OVERLAY_Z: i32 = TILE_Z + 1;
const KEEP_SCREENS: i64 = 3;
const MAX_PINNED_ROWS_SHARE: u32 = 4;
const MAX_PINNED_COLUMNS_SHARE: u32 = 3;
const MIN_PINNED_COLUMNS: u32 = 8;
const PINNED_SAMPLE_EVERY: usize = 8;

#[derive(Debug)]
pub(crate) struct Layer {
    pub(super) area: Rect,
    stripes: BTreeMap<i64, Stripe>,
    overlays: Vec<SentOverlay>,
    free_ids: Vec<u32>,
    next_id: u32,
    holding: u32,
    origin: Option<i64>,
    pinned: Pinned,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Pinned {
    rects: [Rect; 4],
    pixels: [Vec<u8>; 4],
}

impl Pinned {
    fn new(area: Rect, [top, bottom, left, right]: [u32; 4], canvas: &Canvas, worth: impl Fn(Rect) -> bool) -> Self {
        let middle = area.h - top - bottom;
        let rects = [
            Rect { x: area.x, y: area.y, w: area.w, h: top },
            Rect { x: area.x, y: area.y + area.h - bottom, w: area.w, h: bottom },
            Rect { x: area.x, y: area.y + top, w: left, h: middle },
            Rect { x: area.x + area.w - right, y: area.y + top, w: right, h: middle },
        ]
        .map(|rect| if !rect.is_empty() && worth(rect) { opaque_part(canvas, rect) } else { Rect::default() });
        Self { rects, pixels: Default::default() }.capture(canvas)
    }

    fn capture(mut self, canvas: &Canvas) -> Self {
        self.pixels = self.rects.map(|r| region_pixels(canvas, r));
        self
    }

    // Refreshes the pixels of regions whose content changed in place, and drops a region that stopped
    // being fully opaque.
    fn refresh(&mut self, canvas: &Canvas) {
        let stride = canvas.width as usize * 4;
        for (rect, pixels) in self.rects.iter_mut().zip(self.pixels.iter_mut()) {
            if rect.is_empty() {
                continue;
            }
            let len = rect.w as usize * 4;
            let same = (0..rect.h as usize).all(|r| {
                let at = (rect.y as usize + r) * stride + rect.x as usize * 4;
                canvas.pixels[at..at + len] == pixels[r * len..(r + 1) * len]
            });
            if same {
                continue;
            }
            if opaque_part(canvas, *rect) == *rect {
                *pixels = region_pixels(canvas, *rect);
            } else {
                *rect = Rect::default();
                pixels.clear();
            }
        }
    }

}

// The parts of screen row y not covered by a pinned region, as pixel ranges from the area's left edge.
fn open_spans(pinned: &[Rect; 4], area: Rect, y: u32) -> Vec<std::ops::Range<u32>> {
    if pinned.iter().all(|r| r.is_empty() || y < r.y || y >= r.y + r.h) {
        return vec![0..area.w];
    }
    let mut covered: Vec<(u32, u32)> = pinned
        .iter()
        .filter(|r| !r.is_empty() && y >= r.y && y < r.y + r.h)
        .map(|r| (r.x - area.x, r.x - area.x + r.w))
        .collect();
    covered.sort_unstable();
    let mut spans = Vec::new();
    let mut at = 0;
    for (start, end) in covered {
        if start > at {
            spans.push(at..start);
        }
        at = at.max(end);
    }
    if at < area.w {
        spans.push(at..area.w);
    }
    spans
}

// Terminals blend a see-through pixel with whatever image lies under it, and under a pinned region lie
// stale stripes, so a pinned region keeps only fully opaque pixels: rows and columns at its ends with
// any see-through pixel (a rounded corner) are left to the stripes, and a region with one inside is dropped.
fn region_pixels(canvas: &Canvas, rect: Rect) -> Vec<u8> {
    let stride = canvas.width as usize * 4;
    let len = rect.w as usize * 4;
    let mut pixels = Vec::with_capacity(len * rect.h as usize);
    for y in rect.y..rect.y + rect.h {
        let at = y as usize * stride + rect.x as usize * 4;
        pixels.extend_from_slice(&canvas.pixels[at..at + len]);
    }
    pixels
}

fn opaque_part(canvas: &Canvas, rect: Rect) -> Rect {
    if rect.is_empty() {
        return rect;
    }
    let stride = canvas.width as usize * 4;
    let opaque = |x: u32, y: u32| canvas.pixels[y as usize * stride + x as usize * 4 + 3] == 255;
    let column = |x: u32| (rect.y..rect.y + rect.h).all(|y| opaque(x, y));
    let row = |y: u32, x0: u32, x1: u32| {
        let at = y as usize * stride;
        canvas.pixels[at + x0 as usize * 4..at + x1 as usize * 4].iter().skip(3).step_by(4).all(|&a| a == 255)
    };
    let mut x0 = rect.x;
    let mut x1 = rect.x + rect.w;
    if rect.w >= rect.h {
        while x0 < x1 && !column(x0) {
            x0 += 1;
        }
        while x1 > x0 && !column(x1 - 1) {
            x1 -= 1;
        }
    }
    let mut y0 = rect.y;
    let mut y1 = rect.y + rect.h;
    while y0 < y1 && !row(y0, x0, x1) {
        y0 += 1;
    }
    while y1 > y0 && !row(y1 - 1, x0, x1) {
        y1 -= 1;
    }
    let trimmed = Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if trimmed.is_empty() || !(trimmed.y..trimmed.y + trimmed.h).all(|y| row(y, trimmed.x, trimmed.x + trimmed.w)) {
        return Rect::default();
    }
    trimmed
}

#[derive(Debug)]
struct Stripe {
    pixels: Vec<u8>,
    sent: Vec<u8>,
    unknown: Vec<Rect>,
    pending: Option<Rect>,
    image: Option<Placed>,
    patches: Vec<Patch>,
}

#[derive(Debug)]
struct Placed {
    id: u32,
    shown: Option<(u32, u32, u32)>,
}

#[derive(Debug)]
struct Patch {
    rect: Rect,
    placed: Placed,
}

#[derive(Debug)]
struct SentOverlay {
    rect: Rect,
    rgba: Vec<u8>,
    z: i32,
}

#[derive(Default)]
pub(super) struct LayerReport {
    pub stripes_sent: u64,
    pub overlays_sent: u64,
    pub moved: u64,
}

impl Layer {
    pub(super) fn new(area: Rect) -> Self {
        Self { area, stripes: BTreeMap::new(), overlays: Vec::new(), free_ids: Vec::new(), next_id: FIRST_STRIPE_ID, holding: 0, origin: None, pinned: Pinned::default() }
    }

    pub(super) fn holding(&self) -> bool {
        self.holding > 0
    }

    fn next_id(&mut self) -> u32 {
        self.free_ids.pop().unwrap_or_else(|| {
            self.next_id += 1;
            self.next_id - 1
        })
    }

    fn stored_row(&self, content_y: i64) -> Option<&[u8]> {
        let stripe = i64::from(STRIPE_PX);
        let entry = self.stripes.get(&content_y.div_euclid(stripe))?;
        let row = content_y.rem_euclid(stripe) as u32;
        if entry.unknown.iter().any(|u| row >= u.y && row < u.y + u.h) {
            return None;
        }
        let row_len = self.area.w as usize * 4;
        Some(&entry.pixels[row as usize * row_len..(row as usize + 1) * row_len])
    }

    // The row the terminal showed at screen row y last frame, before the content moved: the stripes,
    // with the pinned regions drawn over them where they were.
    fn shown_row(&self, y: u32, before: i64, row: &mut Vec<u8>) -> bool {
        let area = self.area;
        row.clear();
        let Some(stored) = self.stored_row(i64::from(y) - before) else { return false };
        row.extend_from_slice(stored);
        for (region, pixels) in self.pinned.rects.iter().zip(&self.pinned.pixels) {
            if !region.is_empty() && y >= region.y && y < region.y + region.h {
                let len = region.w as usize * 4;
                let from = (y - region.y) as usize * len;
                let to = (region.x - area.x) as usize * 4;
                row[to..to + len].copy_from_slice(&pixels[from..from + len]);
            }
        }
        true
    }

    // Parts of the area at its edges that showed the same pixels last frame, though the content under
    // them moved, belong to something fixed to the screen (a sticky header, a sticky sidebar) rather
    // than to the scrolled content. While the content stays put they keep their place and only their
    // pixels are refreshed.
    fn find_pinned(&mut self, canvas: &Canvas, layer: &ScrollLayer) -> Pinned {
        let area = self.area;
        let Some(before) = self.origin else { return Pinned::default() };
        if before == layer.origin_y {
            let mut pinned = std::mem::take(&mut self.pinned);
            pinned.refresh(canvas);
            return pinned;
        }
        let row_len = area.w as usize * 4;
        let stride = canvas.width as usize * 4;
        let canvas_row = |y: u32| {
            let at = y as usize * stride + area.x as usize * 4;
            &canvas.pixels[at..at + row_len]
        };
        let mut shown = Vec::with_capacity(row_len);
        let mut unchanged = |y: u32| self.shown_row(y, before, &mut shown) && shown.as_slice() == canvas_row(y);
        let rows_limit = area.h / MAX_PINNED_ROWS_SHARE;
        let top = (0..rows_limit).take_while(|&r| unchanged(area.y + r)).count() as u32;
        let bottom = (0..rows_limit).take_while(|&r| unchanged(area.y + area.h - 1 - r)).count() as u32;
        let columns_limit = area.w / MAX_PINNED_COLUMNS_SHARE;
        let middle = area.y + top..area.y + area.h - bottom;
        // A side whose columns look the same in the stripes at the new offset (plain margins) gains
        // nothing from pinning; a sample of rows tells cheaply.
        let moves = |bytes: std::ops::Range<usize>| {
            middle.clone().step_by(PINNED_SAMPLE_EVERY).any(|y| {
                self.stored_row(i64::from(y) - layer.origin_y).is_some_and(|stored| stored[bytes.clone()] != canvas_row(y)[bytes.clone()])
            })
        };
        let columns = columns_limit as usize * 4;
        let mut left = if !self.pinned.rects[2].is_empty() || moves(0..columns) { columns_limit } else { 0 };
        let mut right = if !self.pinned.rects[3].is_empty() || moves(row_len - columns..row_len) { columns_limit } else { 0 };
        let nothing_pinned = self.pinned.rects.iter().all(|r| r.is_empty());
        for y in middle {
            if left == 0 && right == 0 {
                break;
            }
            let was = if nothing_pinned {
                self.stored_row(i64::from(y) - before)
            } else {
                self.shown_row(y, before, &mut shown).then_some(shown.as_slice())
            };
            let Some(shown) = was else {
                (left, right) = (0, 0);
                break;
            };
            let now = canvas_row(y);
            let (l, r) = (left as usize * 4, right as usize * 4);
            if now[..l] != shown[..l] {
                left = (now[..l].iter().zip(&shown[..l]).position(|(a, b)| a != b).unwrap_or(l) / 4) as u32;
            }
            if now[row_len - r..] != shown[row_len - r..] {
                right = (now[row_len - r..].iter().rev().zip(shown[row_len - r..].iter().rev()).position(|(a, b)| a != b).unwrap_or(r) / 4) as u32;
            }
        }
        let narrow = |columns: u32| if columns < MIN_PINNED_COLUMNS { 0 } else { columns };
        // Pinning only pays when the stripes would have had to change there: plain margins that scroll
        // along look the same at every offset and are cheaper left in the stripes.
        let worth = |rect: Rect| {
            let bytes = (rect.x - area.x) as usize * 4..(rect.x - area.x + rect.w) as usize * 4;
            (rect.y..rect.y + rect.h).any(|y| {
                self.stored_row(i64::from(y) - layer.origin_y).is_some_and(|stored| stored[bytes.clone()] != canvas_row(y)[bytes.clone()])
            })
        };
        Pinned::new(area, [top, bottom, narrow(left), narrow(right)], canvas, worth)
    }

    fn pinned_overlays(&self) -> Vec<Overlay> {
        self.pinned
            .rects
            .into_iter()
            .zip(&self.pinned.pixels)
            .filter(|(rect, _)| !rect.is_empty())
            .map(|(rect, pixels)| Overlay { pixels: Pixels { rect, rgba: pixels.clone() }, above: true })
            .collect()
    }

    pub(super) fn delete_all(&self, out: &mut Vec<u8>) {
        for stripe in self.stripes.values() {
            for id in stripe.ids() {
                out.extend_from_slice(&crate::kitty::kitty_delete_one(id));
            }
        }
        for index in 0..self.overlays.len() {
            out.extend_from_slice(&crate::kitty::kitty_delete_one(FIRST_OVERLAY_ID + index as u32));
        }
    }
}

impl Stripe {
    fn ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.image.iter().map(|p| p.id).chain(self.patches.iter().map(|p| p.placed.id))
    }
}

fn covers(now: &[u8], sent: &[u8], rect: Rect, row_len: usize) -> bool {
    if sent.is_empty() {
        return true;
    }
    (rect.y..rect.y + rect.h).all(|y| {
        let at = y as usize * row_len + rect.x as usize * 4;
        let len = rect.w as usize * 4;
        now[at..at + len].chunks_exact(4).zip(sent[at..at + len].chunks_exact(4)).all(|(n, o)| n[3] == 255 || o[3] == 0 || n == o)
    })
}

fn union(a: Rect, b: Rect) -> Rect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    Rect { x, y, w: (a.x + a.w).max(b.x + b.w) - x, h: (a.y + a.h).max(b.y + b.h) - y }
}

impl Kitty {
    fn place_part(&self, out: &mut Vec<u8>, placed: &mut Placed, at: (u32, u32), rows: Option<(u32, u32)>, z: i32) {
        let (cw, ch) = self.cell();
        let want = (at.1, rows.map_or(0, |r| r.0), rows.map_or(0, |r| r.1));
        if placed.shown == Some(want) {
            return;
        }
        out.extend_from_slice(format!("\x1b[{};{}H", at.1 / ch + 1, at.0 / cw + 1).as_bytes());
        out.extend_from_slice(&crate::kitty::kitty_place_rows(placed.id, rows, (at.0 % cw, at.1 % ch), z, self.wrapper));
        placed.shown = Some(want);
    }

    fn send_unplaced(&mut self, out: &mut Vec<u8>, id: u32, size: (u32, u32), fill: impl FnOnce(&mut [u8])) -> io::Result<()> {
        let len = (size.0 * size.1 * 4) as usize;
        match self.patch_medium() {
            Some(medium) => {
                let name = pixel_core::profiler::span("kitty.handoff", || self.hand_off_payload(medium, len, fill))?;
                out.extend_from_slice(&crate::kitty::kitty_transmit_unplaced(id, size.0, size.1, &name, medium, self.wrapper));
            }
            None => {
                let mut data = vec![0u8; len];
                fill(&mut data);
                out.extend_from_slice(&crate::kitty::kitty_transmit_unplaced_inline(id, size.0, size.1, &data, self.wrapper));
            }
        }
        Ok(())
    }

    fn send_part(&mut self, out: &mut Vec<u8>, id: u32, rect: Rect, stripe: &[u8], width: u32, premultiplied: bool) -> io::Result<()> {
        let row_len = width as usize * 4;
        let part_len = rect.w as usize * 4;
        let fill = |b: &mut [u8]| {
            for row in 0..rect.h as usize {
                let from = (rect.y as usize + row) * row_len + rect.x as usize * 4;
                b[row * part_len..(row + 1) * part_len].copy_from_slice(&stripe[from..from + part_len]);
            }
            super::straighten(b, premultiplied);
        };
        self.send_unplaced(out, id, (rect.w, rect.h), fill)
    }

    pub(super) fn draw_layer(&mut self, frame: Frame<'_>, layer: &ScrollLayer, out: &mut Vec<u8>) -> io::Result<LayerReport> {
        let Some(mut state) = self.patches.layer.take() else {
            return Ok(LayerReport::default());
        };
        state.pinned = if layer.pinned_rows { pixel_core::profiler::span("present.pinned", || state.find_pinned(frame.canvas, layer)) } else { Pinned::default() };
        let result = self.draw_stripes(frame, layer, &mut state, out).and_then(|mut report| {
            let mut overlays = layer.overlays.clone();
            overlays.extend(state.pinned_overlays());
            report.overlays_sent = self.draw_overlays(&overlays, &mut state, out)?;
            Ok(report)
        });
        state.origin = Some(layer.origin_y);
        self.patches.layer = Some(state);
        result
    }

    fn draw_stripes(&mut self, frame: Frame<'_>, layer: &ScrollLayer, state: &mut Layer, out: &mut Vec<u8>) -> io::Result<LayerReport> {
        let canvas = frame.canvas;
        let area = state.area;
        let stripe = i64::from(STRIPE_PX);
        let top = i64::from(area.y) - layer.origin_y;
        let bottom = top + i64::from(area.h);
        let visible = top.div_euclid(stripe)..=(bottom - 1).div_euclid(stripe);
        let mut report = LayerReport::default();
        let mut row_buf = Vec::new();
        let row_len = area.w as usize * 4;
        let stride = canvas.width as usize * 4;
        let premultiplied = frame.premultiplied;
        let mut consolidated = false;
        let pinned = state.pinned.rects;
        let band_of = |k: i64| {
            let y0 = layer.origin_y + k * stripe;
            let shown_top = y0.max(i64::from(area.y));
            let shown_bottom = (y0 + stripe).min(i64::from(area.y + area.h));
            (y0, shown_top, Rect { x: 0, y: (shown_top - y0) as u32, w: area.w, h: (shown_bottom - shown_top) as u32 })
        };
        let on_screen = state.stripes.values().any(|s| s.ids().next().is_some() && s.image.iter().chain(s.patches.iter().map(|p| &p.placed)).any(|p| p.shown.is_some()));
        let jump = (state.holding > 0 && state.holding < MAX_HOLD_FRAMES)
            || (state.holding == 0 && on_screen && visible.clone().all(|k| state.stripes.get(&k).is_none_or(|s| s.image.is_none() && s.patches.is_empty())));
        for k in visible.clone() {
            let (_, shown_top, band) = band_of(k);
            if !state.stripes.contains_key(&k) {
                let unknown = vec![Rect::sized(area.w, STRIPE_PX)];
                state.stripes.insert(k, Stripe { pixels: vec![0; (area.w * STRIPE_PX * 4) as usize], sent: Vec::new(), unknown, pending: None, image: None, patches: Vec::new() });
            }
            let screen = Rect { x: area.x, y: shown_top as u32, w: area.w, h: band.h };
            let unders: Vec<_> = layer.under.iter().filter(|u| !intersect(u.rect, screen).is_empty()).collect();
            let entry = state.stripes.get_mut(&k).expect("inserted above");
            let mut diff = entry.pending.take();
            for r in 0..band.h {
                let y = screen.y + r;
                let start = y as usize * stride + area.x as usize * 4;
                let mut row = &canvas.pixels[start..start + row_len];
                if unders.iter().any(|u| y >= u.rect.y && y < u.rect.y + u.rect.h) {
                    row_buf.clear();
                    row_buf.extend_from_slice(row);
                    for under in unders.iter().filter(|u| y >= u.rect.y && y < u.rect.y + u.rect.h) {
                        let x0 = under.rect.x.max(area.x);
                        let x1 = (under.rect.x + under.rect.w).min(area.x + area.w);
                        let from = ((y - under.rect.y) * under.rect.w + (x0 - under.rect.x)) as usize * 4;
                        let to = (x0 - area.x) as usize * 4;
                        let len = (x1 - x0) as usize * 4;
                        row_buf[to..to + len].copy_from_slice(&under.rgba[from..from + len]);
                    }
                    row = &row_buf;
                }
                let at = (band.y + r) as usize * row_len;
                for span in open_spans(&pinned, area, y) {
                    let bytes = span.start as usize * 4..span.end as usize * 4;
                    let stored = &mut entry.pixels[at + bytes.start..at + bytes.end];
                    let row = &row[bytes];
                    if stored != row {
                        let first = stored.chunks_exact(4).zip(row.chunks_exact(4)).position(|(p, q)| p != q).unwrap_or(0) as u32;
                        let last = stored.chunks_exact(4).zip(row.chunks_exact(4)).rposition(|(p, q)| p != q).unwrap_or(0) as u32;
                        let changed = Rect { x: span.start + first, y: band.y + r, w: last + 1 - first, h: 1 };
                        diff = Some(diff.map_or(changed, |d| union(d, changed)));
                        stored.copy_from_slice(row);
                    }
                }
            }
            for unseen in entry.unknown.iter().map(|u| intersect(*u, band)).filter(|u| !u.is_empty()) {
                diff = Some(diff.map_or(unseen, |d| union(d, unseen)));
            }
            entry.unknown = subtract(&entry.unknown, band);
            entry.pending = diff;
        }
        let medium = self.patch_medium();
        let budget = if medium.is_some() { JUMP_UPLOAD_BUDGET } else { INLINE_JUMP_UPLOAD_BUDGET };
        let stripe_bytes = row_len * STRIPE_PX as usize;
        let mut spent = 0;
        for k in visible.clone() {
            let entry = state.stripes.get_mut(&k).expect("inserted above");
            let complete = entry.unknown.is_empty() && entry.patches.len() >= 2 && !consolidated && medium.is_none_or(|m| self.has_ready_payload(m, stripe_bytes));
            let Some(diff) = (if complete { Some(Rect::sized(area.w, STRIPE_PX)) } else { entry.pending }) else {
                continue;
            };
            let mut rect = diff;
            loop {
                let grown = entry.patches.iter().filter(|p| !intersect(p.rect, rect).is_empty()).fold(rect, |r, p| union(r, p.rect));
                if grown == rect {
                    break;
                }
                rect = grown;
            }
            let whole = rect.area() * 2 >= u64::from(area.w * STRIPE_PX) || entry.patches.len() >= MAX_PATCHES || !covers(&entry.pixels, &entry.sent, rect, row_len);
            let cost = if whole { stripe_bytes } else { rect.area() as usize * 4 };
            if jump && spent > 0 && spent + cost > budget {
                continue;
            }
            spent += cost;
            consolidated |= complete;
            entry.pending = None;
            let (merged, kept): (Vec<Patch>, Vec<Patch>) = std::mem::take(&mut entry.patches).into_iter().partition(|p| !intersect(p.rect, rect).is_empty());
            entry.patches = kept;
            let mut freed: Vec<u32> = merged.iter().map(|p| p.placed.id).collect();
            if whole {
                freed.extend(entry.patches.drain(..).map(|p| p.placed.id));
                let id = match entry.image.take() {
                    Some(image) => image.id,
                    None => freed.pop().unwrap_or_else(|| state.next_id()),
                };
                let entry = state.stripes.get_mut(&k).expect("inserted above");
                self.send_part(out, id, Rect::sized(area.w, STRIPE_PX), &entry.pixels, area.w, premultiplied)?;
                entry.sent.clone_from(&entry.pixels);
                entry.image = Some(Placed { id, shown: None });
                report.stripes_sent += 1;
            } else {
                let id = freed.pop().unwrap_or_else(|| state.next_id());
                let entry = state.stripes.get_mut(&k).expect("inserted above");
                self.send_part(out, id, rect, &entry.pixels, area.w, premultiplied)?;
                entry.patches.push(Patch { rect, placed: Placed { id, shown: None } });
                report.overlays_sent += 1;
            }
            for id in freed {
                out.extend_from_slice(&crate::kitty::kitty_delete_one(id));
                state.free_ids.push(id);
            }
        }
        let waiting = jump && visible.clone().any(|k| state.stripes.get(&k).is_some_and(|s| s.pending.is_some()));
        state.holding = if waiting { state.holding + 1 } else { 0 };
        if waiting {
            pixel_core::profiler::count("present.stripes", || report.stripes_sent);
            return Ok(report);
        }
        for k in visible.clone() {
            let (y0, shown_top, band) = band_of(k);
            let entry = state.stripes.get_mut(&k).expect("inserted above");
            let mut image = entry.image.take();
            let mut patches = std::mem::take(&mut entry.patches);
            if let Some(image) = image.as_mut() {
                let rows = (band.h < STRIPE_PX).then_some((band.y, band.h));
                self.place_part(out, image, (area.x, shown_top as u32), rows, 0);
                report.moved += 1;
            }
            for patch in &mut patches {
                let seen = intersect(patch.rect, band);
                if seen.is_empty() {
                    if patch.placed.shown.take().is_some() {
                        out.extend_from_slice(&crate::kitty::kitty_delete_placement(patch.placed.id));
                    }
                    continue;
                }
                let rows = (seen.h < patch.rect.h).then_some((seen.y - patch.rect.y, seen.h));
                let top = (y0 + i64::from(seen.y)) as u32;
                self.place_part(out, &mut patch.placed, (area.x + patch.rect.x, top), rows, PATCH_Z);
            }
            let entry = state.stripes.get_mut(&k).expect("inserted above");
            entry.image = image;
            entry.patches = patches;
        }
        let keep = KEEP_SCREENS * i64::from(area.h) / stripe;
        let (first, last) = (*visible.start(), *visible.end());
        let mut dropped = Vec::new();
        for (&k, entry) in state.stripes.iter_mut() {
            if visible.contains(&k) {
                continue;
            }
            if k < first - keep || k > last + keep {
                for id in entry.ids() {
                    out.extend_from_slice(&crate::kitty::kitty_delete_one(id));
                }
                dropped.push(k);
            } else {
                for placed in entry.image.iter_mut().chain(entry.patches.iter_mut().map(|p| &mut p.placed)) {
                    if placed.shown.take().is_some() {
                        out.extend_from_slice(&crate::kitty::kitty_delete_placement(placed.id));
                    }
                }
            }
        }
        for k in dropped {
            if let Some(entry) = state.stripes.remove(&k) {
                state.free_ids.extend(entry.ids());
            }
        }
        pixel_core::profiler::count("present.stripes", || report.stripes_sent);
        Ok(report)
    }

    fn draw_overlays(&mut self, overlays: &[Overlay], state: &mut Layer, out: &mut Vec<u8>) -> io::Result<u64> {
        let (cw, ch) = self.cell();
        let mut sent = 0;
        for (index, overlay) in overlays.iter().enumerate() {
            let id = FIRST_OVERLAY_ID + index as u32;
            let rect = overlay.pixels.rect;
            let z = OVERLAY_Z + i32::from(overlay.above);
            let previous = state.overlays.get(index);
            let same_image = previous.is_some_and(|s| (s.rect.w, s.rect.h) == (rect.w, rect.h) && s.rgba == overlay.pixels.rgba);
            let placed = same_image && previous.is_some_and(|s| s.rect == rect && s.z == z);
            if !same_image {
                let pixels = &overlay.pixels.rgba;
                self.send_unplaced(out, id, (rect.w, rect.h), |b| b.copy_from_slice(pixels))?;
                sent += 1;
            }
            if !placed {
                out.extend_from_slice(format!("\x1b[{};{}H", rect.y / ch + 1, rect.x / cw + 1).as_bytes());
                out.extend_from_slice(&crate::kitty::kitty_place_rows(id, None, (rect.x % cw, rect.y % ch), z, self.wrapper));
            }
            if !placed || !same_image {
                let entry = SentOverlay { rect, rgba: overlay.pixels.rgba.clone(), z };
                match state.overlays.get_mut(index) {
                    Some(slot) => *slot = entry,
                    None => state.overlays.push(entry),
                }
            }
        }
        for index in overlays.len()..state.overlays.len() {
            out.extend_from_slice(&crate::kitty::kitty_delete_one(FIRST_OVERLAY_ID + index as u32));
        }
        state.overlays.truncate(overlays.len());
        pixel_core::profiler::count("present.overlays", || sent);
        Ok(sent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pixel_raster::Canvas;

    fn content(width: u32, height: u32, origin_y: i64) -> Canvas {
        let mut canvas = Canvas::new(width, height);
        for y in 0..height {
            let row = (i64::from(y) - origin_y) as u32;
            for px in canvas.pixels[(y * width * 4) as usize..((y + 1) * width * 4) as usize].chunks_exact_mut(4) {
                px.copy_from_slice(&[row as u8, (row >> 8) as u8, 7, 255]);
            }
        }
        canvas
    }

    fn draw(kitty: &mut Kitty, canvas: &Canvas, layer: &ScrollLayer) -> String {
        let frame = Frame { canvas, premultiplied: false, changed: &[], repainted: &[], opaque: &[], ui_over_surfaces: &[], layer: Some(layer), surfaces: None };
        let mut out = Vec::new();
        kitty.draw_layer(frame, layer, &mut out).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn inline_layers_send_stripes_once_and_scroll_by_placing_them() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        assert!(kitty.patch_medium().is_none());
        let area = Rect::sized(64, 2 * STRIPE_PX);
        kitty.patches.layer = Some(Layer::new(area));
        let first = ScrollLayer { area, origin_y: 0, under: Vec::new(), overlays: Vec::new(), pinned_rows: false };
        let out = draw(&mut kitty, &content(64, area.h, 0), &first);
        assert_eq!(out.matches("a=t,f=32,o=z,s=64,v=128,t=d,").count(), 2);
        assert_eq!(out.matches("a=p,").count(), 2);

        let scrolled = ScrollLayer { origin_y: -i64::from(STRIPE_PX), ..first };
        let out = draw(&mut kitty, &content(64, area.h, scrolled.origin_y), &scrolled);
        assert_eq!(out.matches("a=t,").count(), 1, "only the stripe scrolled into view is uploaded");
        assert!(out.contains("\x1b[1;1H\x1b_Ga=p,i=2001,p=1,C=1,q=2"), "the second stripe moves to the top");
        assert!(out.contains("a=d,d=i,i=2000,p=1"), "the stripe scrolled out of view is hidden but kept");
    }

    fn with_header(width: u32, height: u32, origin_y: i64, header: u32) -> Canvas {
        let mut canvas = content(width, height, origin_y);
        for px in canvas.pixels[..(header * width * 4) as usize].chunks_exact_mut(4) {
            px.copy_from_slice(&[200, 10, 10, 255]);
        }
        canvas
    }

    #[test]
    fn a_header_that_stays_put_while_the_page_scrolls_is_sent_once_as_an_overlay() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        let area = Rect::sized(64, 2 * STRIPE_PX);
        kitty.patches.layer = Some(Layer::new(area));
        let at = |origin_y| ScrollLayer { area, origin_y, under: Vec::new(), overlays: Vec::new(), pinned_rows: true };
        draw(&mut kitty, &with_header(64, area.h, 0, 20), &at(0));
        let out = draw(&mut kitty, &with_header(64, area.h, -30, 20), &at(-30));
        assert!(out.contains(&format!("i={FIRST_OVERLAY_ID}")), "the header is shown on its own: {out}");
        let state = kitty.patches.layer.as_ref().unwrap();
        assert_eq!((state.pinned.rects[0].h, state.pinned.rects[1].h), (20, 0));
        let out = draw(&mut kitty, &with_header(64, area.h, -60, 20), &at(-60));
        assert!(!out.contains(&format!("i={FIRST_OVERLAY_ID},")), "an unchanged header is not sent again: {out}");
        let state = kitty.patches.layer.as_ref().unwrap();
        assert_eq!((state.pinned.rects[0].h, state.pinned.rects[1].h), (20, 0));
        let out = draw(&mut kitty, &content(64, area.h, -90), &at(-90));
        assert!(out.contains(&format!("a=d,d=I,i={FIRST_OVERLAY_ID}")) || out.contains(&format!("i={FIRST_OVERLAY_ID},")), "a header that goes away stops being shown: {out}");
        let state = kitty.patches.layer.as_ref().unwrap();
        assert_eq!((state.pinned.rects[0].h, state.pinned.rects[1].h), (0, 0));
        let canvas = content(64, area.h, -90);
        for y in 0..area.h {
            let want = &canvas.pixels[(y * 64 * 4) as usize..((y + 1) * 64 * 4) as usize];
            assert_eq!(state.stored_row(i64::from(y) + 90), Some(want), "row {y} uncovered by the header is up to date");
        }
    }

    fn with_sidebar(width: u32, height: u32, origin_y: i64, side: u32) -> Canvas {
        let mut canvas = content(width, height, origin_y);
        for (y, row) in canvas.pixels.chunks_exact_mut((width * 4) as usize).enumerate() {
            for px in row[..(side * 4) as usize].chunks_exact_mut(4) {
                px.copy_from_slice(&[10, 200, (y % 7) as u8 * 30, 255]);
            }
        }
        canvas
    }

    #[test]
    fn a_sidebar_that_stays_put_is_kept_out_of_the_scrolled_stripes() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        let area = Rect::sized(64, 2 * STRIPE_PX);
        kitty.patches.layer = Some(Layer::new(area));
        let at = |origin_y| ScrollLayer { area, origin_y, under: Vec::new(), overlays: Vec::new(), pinned_rows: true };
        draw(&mut kitty, &with_sidebar(64, area.h, 0, 16), &at(0));
        draw(&mut kitty, &with_sidebar(64, area.h, -30, 16), &at(-30));
        let state = kitty.patches.layer.as_ref().unwrap();
        assert_eq!((state.pinned.rects[0].h, state.pinned.rects[2].w, state.pinned.rects[3].w), (0, 16, 0));
        let out = draw(&mut kitty, &with_sidebar(64, area.h, -60, 16), &at(-60));
        assert!(out.matches("a=t,").count() <= 2, "only rows scrolled into view are uploaded, not the sidebar: {out}");
        let canvas = content(64, area.h, -60);
        let state = kitty.patches.layer.as_ref().unwrap();
        for y in 0..area.h {
            let want = &canvas.pixels[(y * 64 * 4 + 16 * 4) as usize..((y + 1) * 64 * 4) as usize];
            assert_eq!(&state.stored_row(i64::from(y) + 60).unwrap()[16 * 4..], want, "row {y} right of the sidebar is up to date");
        }
    }
}

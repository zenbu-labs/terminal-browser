use std::collections::BTreeMap;
use std::io;

use crate::Kitty;
use super::tiles::{TILE_Z, intersect, subtract};
use pixel_raster::{PixelFrame as Frame, ScrollLayer};
use pixel_core::surfaces::Rect;

const STRIPE_PX: u32 = 128;
const MAX_PATCHES: usize = 6;
const JUMP_UPLOAD_BUDGET: usize = 2_200_000;
const MAX_HOLD_FRAMES: u32 = 4;
const PATCH_Z: i32 = TILE_Z;
const FIRST_STRIPE_ID: u32 = 2_000;
const FIRST_OVERLAY_ID: u32 = 30_000;
const OVERLAY_Z: i32 = TILE_Z + 1;
const KEEP_SCREENS: i64 = 3;

#[derive(Debug)]
pub(crate) struct Layer {
    pub(super) area: Rect,
    stripes: BTreeMap<i64, Stripe>,
    overlays: Vec<SentOverlay>,
    free_ids: Vec<u32>,
    next_id: u32,
    holding: u32,
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
        Self { area, stripes: BTreeMap::new(), overlays: Vec::new(), free_ids: Vec::new(), next_id: FIRST_STRIPE_ID, holding: 0 }
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

    fn send_part(&mut self, out: &mut Vec<u8>, id: u32, rect: Rect, stripe: &[u8], width: u32, premultiplied: bool) -> io::Result<()> {
        let medium = self.patch_medium().expect("layers are only drawn with a patch medium");
        let row_len = width as usize * 4;
        let part_len = rect.w as usize * 4;
        let fill = |b: &mut [u8]| {
            for row in 0..rect.h as usize {
                let from = (rect.y as usize + row) * row_len + rect.x as usize * 4;
                b[row * part_len..(row + 1) * part_len].copy_from_slice(&stripe[from..from + part_len]);
            }
            super::straighten(b, premultiplied);
        };
        let name = pixel_core::profiler::span("kitty.handoff", || self.hand_off_payload(medium, part_len * rect.h as usize, fill))?;
        out.extend_from_slice(&crate::kitty::kitty_transmit_unplaced(id, rect.w, rect.h, &name, medium, self.wrapper));
        Ok(())
    }

    pub(super) fn draw_layer(&mut self, frame: Frame<'_>, layer: &ScrollLayer, out: &mut Vec<u8>) -> io::Result<LayerReport> {
        let Some(mut state) = self.patches.layer.take() else {
            return Ok(LayerReport::default());
        };
        let result = self.draw_stripes(frame, layer, &mut state, out).and_then(|mut report| {
            report.overlays_sent = self.draw_overlays(layer, &mut state, out)?;
            Ok(report)
        });
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
                let stored = &mut entry.pixels[at..at + row_len];
                if stored != row {
                    let first = stored.chunks_exact(4).zip(row.chunks_exact(4)).position(|(p, q)| p != q).unwrap_or(0) as u32;
                    let last = stored.chunks_exact(4).zip(row.chunks_exact(4)).rposition(|(p, q)| p != q).unwrap_or(0) as u32;
                    let changed = Rect { x: first, y: band.y + r, w: last + 1 - first, h: 1 };
                    diff = Some(diff.map_or(changed, |d| union(d, changed)));
                    stored.copy_from_slice(row);
                }
            }
            for unseen in entry.unknown.iter().map(|u| intersect(*u, band)).filter(|u| !u.is_empty()) {
                diff = Some(diff.map_or(unseen, |d| union(d, unseen)));
            }
            entry.unknown = subtract(&entry.unknown, band);
            entry.pending = diff;
        }
        let medium = self.patch_medium().expect("layers are only drawn with a patch medium");
        let stripe_bytes = row_len * STRIPE_PX as usize;
        let mut spent = 0;
        for k in visible.clone() {
            let entry = state.stripes.get_mut(&k).expect("inserted above");
            let complete = entry.unknown.is_empty() && entry.patches.len() >= 2 && !consolidated && self.has_ready_payload(medium, stripe_bytes);
            let Some(diff) = (if complete { Some(Rect::sized(area.w, STRIPE_PX)) } else { entry.pending }) else {
                continue;
            };
            let mut rect = diff;
            for patch in entry.patches.iter().filter(|p| !intersect(p.rect, diff).is_empty()) {
                rect = union(rect, patch.rect);
            }
            let whole = rect.area() * 2 >= u64::from(area.w * STRIPE_PX) || entry.patches.len() >= MAX_PATCHES || !covers(&entry.pixels, &entry.sent, rect, row_len);
            let cost = if whole { stripe_bytes } else { rect.area() as usize * 4 };
            if jump && spent > 0 && spent + cost > JUMP_UPLOAD_BUDGET {
                continue;
            }
            spent += cost;
            consolidated |= complete;
            entry.pending = None;
            let (merged, kept): (Vec<Patch>, Vec<Patch>) = std::mem::take(&mut entry.patches).into_iter().partition(|p| !intersect(p.rect, diff).is_empty());
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

    fn draw_overlays(&mut self, layer: &ScrollLayer, state: &mut Layer, out: &mut Vec<u8>) -> io::Result<u64> {
        let (cw, ch) = self.cell();
        let mut sent = 0;
        for (index, overlay) in layer.overlays.iter().enumerate() {
            let id = FIRST_OVERLAY_ID + index as u32;
            let rect = overlay.pixels.rect;
            let z = OVERLAY_Z + i32::from(overlay.above);
            let previous = state.overlays.get(index);
            let same_image = previous.is_some_and(|s| (s.rect.w, s.rect.h) == (rect.w, rect.h) && s.rgba == overlay.pixels.rgba);
            let placed = same_image && previous.is_some_and(|s| s.rect == rect && s.z == z);
            if !same_image {
                let medium = self.patch_medium().expect("layers are only drawn with a patch medium");
                let pixels = &overlay.pixels.rgba;
                let name = pixel_core::profiler::span("kitty.handoff", || self.hand_off_payload(medium, pixels.len(), |b| b.copy_from_slice(pixels)))?;
                out.extend_from_slice(&crate::kitty::kitty_transmit_unplaced(id, rect.w, rect.h, &name, medium, self.wrapper));
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
        for index in layer.overlays.len()..state.overlays.len() {
            out.extend_from_slice(&crate::kitty::kitty_delete_one(FIRST_OVERLAY_ID + index as u32));
        }
        state.overlays.truncate(layer.overlays.len());
        pixel_core::profiler::count("present.overlays", || sent);
        Ok(sent)
    }
}

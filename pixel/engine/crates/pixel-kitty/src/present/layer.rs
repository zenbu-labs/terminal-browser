use std::collections::BTreeMap;
use std::io;

use crate::Kitty;
use super::tiles::{TILE_Z, intersect, subtract};
use pixel_raster::{PixelFrame as Frame, ScrollLayer};
use pixel_core::surfaces::Rect;

pub(super) const STRIPE_PX: u32 = 128;
pub(super) fn web_stripe_px() -> Option<u32> {
    static PX: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *PX.get_or_init(|| std::env::var("PIXEL_WEB_STRIPE_PX").ok().and_then(|v| v.trim().parse::<u32>().ok()).map(|px| px.clamp(16, 512)))
}
const MAX_PATCHES: usize = 6;
const JUMP_UPLOAD_BUDGET: usize = 2_200_000;
const INLINE_JUMP_UPLOAD_BUDGET: usize = 900_000;
const MAX_HOLD_FRAMES: u32 = 4;
const PATCH_Z: i32 = TILE_Z;
const FIRST_OVERLAY_ID: u32 = 30_000;
const OVERLAY_Z: i32 = TILE_Z + 1;
const KEEP_SCREENS: i64 = 3;
const DEPTH_Z: i32 = PATCH_Z + MAX_PATCHES as i32;
const STRIP_IDS: std::ops::Range<u32> = 1_000_000..2_000_000;

fn keep_screens() -> i64 {
    static KEEP: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *KEEP.get_or_init(|| std::env::var("PIXEL_KEEP_SCREENS").ok().and_then(|v| v.trim().parse::<i64>().ok()).map_or(KEEP_SCREENS, |k| k.clamp(0, 6)))
}
const RUN_BLOCK_PX: usize = 8;
const _: () = assert!(super::MIN_IMAGE_COST_BYTES >= 4 * RUN_BLOCK_PX as u64);
const _: () = assert!(
    FIRST_OVERLAY_ID < STRIP_IDS.start
        && super::tiles::FIRST_TILE_ID < STRIP_IDS.start
        && super::flash::LAST_ID < STRIP_IDS.start
        && super::overlay::STATUS_ID < STRIP_IDS.start
        && super::transmit_strategy::FIRST_PATCH_ID + super::transmit_strategy::POOL < STRIP_IDS.start
);

#[derive(Debug)]
pub(crate) struct Layer {
    pub(super) area: Rect,
    stripes: BTreeMap<i64, Stripe>,
    overlays: Vec<SentOverlay>,
    holding: u32,
    z: i32,
    whole_at_percent: u64,
    stacks: bool,
    clears_holes: bool,
    see_through_over: Vec<Rect>,
    stripe_px: u32,
    compared: Option<(i64, Rect, Vec<Rect>)>,
}

#[derive(Debug)]
struct Stripe {
    pixels: Vec<u8>,
    sent: Vec<u8>,
    unknown: Vec<Rect>,
    pending: Vec<Rect>,
    images: Vec<Piece>,
    patches: Vec<Patch>,
}

#[derive(Debug)]
struct Piece {
    x: u32,
    w: u32,
    placed: Placed,
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
    level: i32,
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
    pub waiting: bool,
    pub see_through: bool,
}

impl Layer {
    pub(super) fn new(area: Rect, stripe_px: u32) -> Self {
        Self { whole_at_percent: 50, stacks: false, ..Self::for_node(area, 0, stripe_px) }
    }

    pub(super) fn for_node(area: Rect, depth: u32, stripe_px: u32) -> Self {
        Self {
            whole_at_percent: 80,
            stacks: true,
            clears_holes: false,
            see_through_over: Vec::new(),
            stripe_px,
            compared: None,
            area,
            stripes: BTreeMap::new(),
            overlays: Vec::new(),
            holding: 0,
            z: depth as i32 * DEPTH_Z,
        }
    }

    pub(super) fn watch_see_through_over(&mut self, others: Vec<Rect>) {
        self.see_through_over = others;
    }

    pub(super) fn clear_holes(&mut self) {
        if !self.clears_holes {
            self.clears_holes = true;
            self.compared = None;
        }
    }

    pub(super) fn for_screen(area: Rect, depth: u32, stripe_px: u32) -> Self {
        Self { clears_holes: true, ..Self::for_node(area, depth, stripe_px) }
    }

    #[cfg(test)]
    pub(super) fn upload_cost(&self, canvas: &pixel_raster::Canvas, origin_y: i64, holes: &[Rect]) -> usize {
        let area = self.area;
        let stripe_px = self.stripe_px;
        let stripe = i64::from(stripe_px);
        let top = i64::from(area.y) - origin_y;
        let bottom = top + i64::from(area.h);
        let row_len = area.w as usize * 4;
        let stride = canvas.width as usize * 4;
        let stripe_bytes = row_len * stripe_px as usize;
        let mut cost = 0;
        for k in top.div_euclid(stripe)..=(bottom - 1).div_euclid(stripe) {
            let y0 = origin_y + k * stripe;
            let shown_top = y0.max(i64::from(area.y));
            let shown_bottom = (y0 + stripe).min(i64::from(area.y + area.h));
            let band = Rect { x: 0, y: (shown_top - y0) as u32, w: area.w, h: (shown_bottom - shown_top) as u32 };
            let Some(entry) = self.stripes.get(&k) else {
                cost += if uploads_whole(band, area.w, stripe_px, 0, self.whole_at_percent) { stripe_bytes } else { row_len * band.h as usize };
                continue;
            };
            let mut diff = entry.pending.iter().copied().reduce(union);
            let hidden = local_holes(holes, area, y0, band);
            for unseen in entry.unknown.iter().map(|u| intersect(*u, band)).filter(|u| !u.is_empty()) {
                for part in subtract_all(vec![unseen], &hidden) {
                    diff = Some(diff.map_or(part, |d| union(d, part)));
                }
            }
            for r in 0..band.h {
                let y = shown_top as u32 + r;
                let start = y as usize * stride + area.x as usize * 4;
                let row = &canvas.pixels[start..start + row_len];
                let at = (band.y + r) as usize * row_len;
                for span in open_spans(area, holes, y) {
                    let bytes = span.start as usize * 4..span.end as usize * 4;
                    let stored = &entry.pixels[at + bytes.start..at + bytes.end];
                    let row = &row[bytes];
                    if stored != row {
                        let first = stored.chunks_exact(4).zip(row.chunks_exact(4)).position(|(p, q)| p != q).unwrap_or(0) as u32;
                        let last = stored.chunks_exact(4).zip(row.chunks_exact(4)).rposition(|(p, q)| p != q).unwrap_or(0) as u32;
                        let changed = Rect { x: span.start + first, y: band.y + r, w: last + 1 - first, h: 1 };
                        diff = Some(diff.map_or(changed, |d| union(d, changed)));
                    }
                }
            }
            if let Some(rect) = diff {
                let whole = uploads_whole(rect, area.w, stripe_px, entry.patches.len(), self.whole_at_percent);
                cost += if whole { stripe_bytes } else { rect.area() as usize * 4 };
            }
        }
        cost
    }

    pub(super) fn jumping(&self, origin_y: i64) -> bool {
        let stripe = i64::from(self.stripe_px);
        let top = i64::from(self.area.y) - origin_y;
        let mut visible = top.div_euclid(stripe)..=(top + i64::from(self.area.h) - 1).div_euclid(stripe);
        let on_screen = self.stripes.values().any(|s| s.images.iter().map(|p| &p.placed).chain(s.patches.iter().map(|p| &p.placed)).any(|p| p.shown.is_some()));
        (self.holding > 0 && self.holding < MAX_HOLD_FRAMES)
            || (self.holding == 0 && on_screen && visible.all(|k| self.stripes.get(&k).is_none_or(|s| s.images.is_empty() && s.patches.is_empty())))
    }

    pub(super) fn forget_compared(&mut self) {
        self.compared = None;
    }

    pub(super) fn holding(&self) -> bool {
        self.holding > 0
    }

    pub(super) fn delete_all(&self, out: &mut Vec<u8>, ids: &mut ImageIds) {
        for stripe in self.stripes.values() {
            for id in stripe.ids() {
                out.extend_from_slice(&crate::kitty::kitty_delete_one(id));
            }
            ids.give_back(stripe.ids());
        }
        for index in 0..self.overlays.len() {
            out.extend_from_slice(&crate::kitty::kitty_delete_one(FIRST_OVERLAY_ID + index as u32));
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct ImageIds {
    free: Vec<u32>,
    issued: u32,
}

impl ImageIds {
    fn take(&mut self) -> u32 {
        self.free.pop().unwrap_or_else(|| {
            let id = STRIP_IDS.start + self.issued;
            assert!(id < STRIP_IDS.end, "web layers ran out of image ids");
            self.issued += 1;
            id
        })
    }

    fn give_back(&mut self, ids: impl IntoIterator<Item = u32>) {
        self.free.extend(ids);
    }
}

impl Stripe {
    fn ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.images.iter().map(|p| p.placed.id).chain(self.patches.iter().map(|p| p.placed.id))
    }
}

pub(super) fn open_spans(area: Rect, holes: &[Rect], y: u32) -> Vec<std::ops::Range<u32>> {
    let mut covered: Vec<(u32, u32)> = holes
        .iter()
        .filter(|h| y >= h.y && y < h.y + h.h)
        .map(|h| (h.x.max(area.x) - area.x, (h.x + h.w).min(area.x + area.w).saturating_sub(area.x)))
        .filter(|(a, b)| a < b)
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

fn seen_columns(unknown: &[Rect], width: u32, stripe_px: u32, image_cost: u64) -> Vec<std::ops::Range<u32>> {
    let mut unseen_rows = vec![0u32; width as usize];
    for rect in unknown {
        for x in rect.x..(rect.x + rect.w).min(width) {
            unseen_rows[x as usize] += rect.h;
        }
    }
    column_runs((0..width).filter(|x| unseen_rows[*x as usize] < stripe_px), stripe_px, image_cost)
}

fn only_columns(pixels: &[u8], width: u32, columns: &[std::ops::Range<u32>]) -> Vec<u8> {
    let mut kept = vec![0u8; pixels.len()];
    for (row, out) in pixels.chunks_exact(width as usize * 4).zip(kept.chunks_exact_mut(width as usize * 4)) {
        for columns in columns {
            let bytes = columns.start as usize * 4..columns.end as usize * 4;
            out[bytes.clone()].copy_from_slice(&row[bytes]);
        }
    }
    kept
}

fn column_runs(columns: impl Iterator<Item = u32>, height: u32, image_cost: u64) -> Vec<std::ops::Range<u32>> {
    let mut runs: Vec<std::ops::Range<u32>> = Vec::new();
    for x in columns {
        match runs.last_mut() {
            Some(run) if worth_one_image(u64::from(x - run.end) * u64::from(height), image_cost) => run.end = x + 1,
            _ => runs.push(x..x + 1),
        }
    }
    runs
}

fn drawn_columns(pixels: &[u8], width: u32, image_cost: u64) -> Vec<std::ops::Range<u32>> {
    let mut drawn = vec![false; width as usize];
    for row in pixels.chunks_exact(width as usize * 4) {
        for (x, px) in row.chunks_exact(4).enumerate() {
            drawn[x] |= px[3] != 0;
        }
    }
    let height = (pixels.len() / (width as usize * 4)) as u32;
    column_runs((0..width).filter(|x| drawn[*x as usize]), height, image_cost)
}

fn closed_spans(width: u32, open: &[std::ops::Range<u32>]) -> Vec<std::ops::Range<u32>> {
    let mut closed = Vec::new();
    let mut at = 0;
    for span in open {
        if span.start > at {
            closed.push(at..span.start);
        }
        at = span.end;
    }
    if at < width {
        closed.push(at..width);
    }
    closed
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

fn uploads_whole(rect: Rect, width: u32, stripe_px: u32, patches: usize, whole_at_percent: u64) -> bool {
    rect.area() * 100 >= u64::from(width * stripe_px) * whole_at_percent || patches >= MAX_PATCHES
}

fn worth_one_image(extra_px: u64, image_cost: u64) -> bool {
    extra_px * 4 <= image_cost
}

fn merge_extra_px(a: Rect, b: Rect) -> u64 {
    union(a, b).area().saturating_sub(a.area() + b.area() - intersect(a, b).area())
}

fn changed_runs(stored: &[u8], now: &[u8], image_cost: u64) -> Vec<(u32, u32)> {
    let mut runs: Vec<(u32, u32)> = Vec::new();
    let mut extend = |x: u32| match runs.last_mut() {
        Some(run) if worth_one_image(u64::from(x.saturating_sub(run.1 + 1)), image_cost) => run.1 = x,
        _ => runs.push((x, x)),
    };
    let differs = |x: usize| stored[x * 4..x * 4 + 4] != now[x * 4..x * 4 + 4];
    let pixels = stored.len().min(now.len()) / 4;
    let mut start = 0;
    while start < pixels {
        let end = (start + RUN_BLOCK_PX).min(pixels);
        if stored[start * 4..end * 4] != now[start * 4..end * 4] {
            let first = (start..end).find(|&x| differs(x)).expect("the block differs");
            let last = (first..end).rev().find(|&x| differs(x)).expect("the block differs");
            extend(first as u32);
            extend(last as u32);
        }
        start = end;
    }
    runs
}

fn opaque(pixels: &[u8], rect: Rect, row_len: usize) -> bool {
    (rect.y..rect.y + rect.h).all(|y| {
        let at = y as usize * row_len + rect.x as usize * 4;
        all_opaque(&pixels[at..at + rect.w as usize * 4])
    })
}

pub(super) fn all_opaque(rgba: &[u8]) -> bool {
    const ALPHA: u128 = u128::from_le_bytes([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    let blocks = rgba.chunks_exact(16);
    let rest = blocks.remainder();
    let all = blocks.fold(ALPHA, |all, block| all & u128::from_le_bytes(block.try_into().expect("16 bytes")));
    all & ALPHA == ALPHA && rest.chunks_exact(4).all(|px| px[3] == 255)
}

fn contains(outer: Rect, inner: Rect) -> bool {
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}

fn add_changed(diff: &mut Vec<Rect>, rect: Rect, image_cost: u64) {
    match diff.iter_mut().find(|d| worth_one_image(merge_extra_px(**d, rect), image_cost)) {
        Some(d) => *d = union(*d, rect),
        None => diff.push(rect),
    }
}

fn settle(mut rects: Vec<Rect>, image_cost: u64) -> Vec<Rect> {
    loop {
        let cheapest = (0..rects.len())
            .flat_map(|i| (i + 1..rects.len()).map(move |j| (i, j)))
            .min_by_key(|&(i, j)| merge_extra_px(rects[i], rects[j]));
        let Some((i, j)) = cheapest.filter(|&(i, j)| worth_one_image(merge_extra_px(rects[i], rects[j]), image_cost)) else { return rects };
        let merged = union(rects[i], rects[j]);
        rects.swap_remove(j);
        rects[i] = merged;
    }
}

fn subtract_all(rects: Vec<Rect>, holes: &[Rect]) -> Vec<Rect> {
    holes.iter().fold(rects, |parts, h| parts.iter().flat_map(|p| subtract(&[*p], *h)).collect())
}

fn local_holes(holes: &[Rect], area: Rect, stripe_top: i64, band: Rect) -> Vec<Rect> {
    holes
        .iter()
        .map(|h| intersect(Rect { x: h.x.saturating_sub(area.x), y: (i64::from(h.y) - stripe_top).max(0) as u32, w: h.w, h: h.h.saturating_sub((stripe_top - i64::from(h.y)).max(0) as u32) }, band))
        .filter(|h| !h.is_empty())
        .collect()
}

fn clip_rows(columns: Rect, top: i64, height: i64, area: Rect) -> Rect {
    let y0 = top.max(i64::from(area.y));
    let y1 = (top + height).min(i64::from(area.y + area.h));
    if y1 <= y0 {
        return Rect::default();
    }
    Rect { y: y0 as u32, h: (y1 - y0) as u32, ..columns }
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

    fn flash_stripe_upload(&mut self, out: &mut Vec<u8>, area: Rect, stripe_top: i64, rect: Rect) {
        if !self.highlight_transmits {
            return;
        }
        let shown = clip_rows(Rect { x: area.x + rect.x, y: 0, w: rect.w, h: 0 }, stripe_top + i64::from(rect.y), i64::from(rect.h), area);
        if !shown.is_empty() {
            self.flash(out, shown, false);
        }
    }

    fn send_part(&mut self, out: &mut Vec<u8>, id: u32, rect: Rect, stripe: &[u8], under: &[u8], width: u32, premultiplied: bool) -> io::Result<()> {
        let row_len = width as usize * 4;
        let part_len = rect.w as usize * 4;
        let fill = |b: &mut [u8]| {
            for row in 0..rect.h as usize {
                let from = (rect.y as usize + row) * row_len + rect.x as usize * 4;
                let part = &mut b[row * part_len..(row + 1) * part_len];
                part.copy_from_slice(&stripe[from..from + part_len]);
                if !under.is_empty() {
                    for (px, below) in part.chunks_exact_mut(4).zip(under[from..from + part_len].chunks_exact(4)) {
                        if px[3] != 255 && px == below {
                            px.copy_from_slice(&[0, 0, 0, 0]);
                        }
                    }
                }
            }
            super::straighten(b, premultiplied);
        };
        self.send_unplaced(out, id, (rect.w, rect.h), fill)
    }

    pub(super) fn draw_layer(&mut self, frame: Frame<'_>, layer: &ScrollLayer, out: &mut Vec<u8>) -> io::Result<LayerReport> {
        let Some(mut state) = self.patches.layer.take() else {
            return Ok(LayerReport::default());
        };
        let result = self.draw_stripes(frame, layer, &mut state, &[], true, out).and_then(|mut report| {
            report.overlays_sent = self.draw_overlays(layer, &mut state, out)?;
            Ok(report)
        });
        self.patches.layer = Some(state);
        result
    }

    pub(super) fn draw_node(&mut self, frame: Frame<'_>, layer: &ScrollLayer, state: &mut Layer, holes: &[Rect], place: bool, out: &mut Vec<u8>) -> io::Result<LayerReport> {
        self.draw_stripes(frame, layer, state, holes, place, out)
    }

    fn draw_stripes(&mut self, frame: Frame<'_>, layer: &ScrollLayer, state: &mut Layer, holes: &[Rect], place: bool, out: &mut Vec<u8>) -> io::Result<LayerReport> {
        let canvas = frame.canvas;
        let area = state.area;
        let stripe_px = state.stripe_px;
        let stripe = i64::from(stripe_px);
        let top = i64::from(area.y) - layer.origin_y;
        let bottom = top + i64::from(area.h);
        let visible = top.div_euclid(stripe)..=(bottom - 1).div_euclid(stripe);
        let mut report = LayerReport::default();
        let mut row_buf = Vec::new();
        let row_len = area.w as usize * 4;
        let stride = canvas.width as usize * 4;
        let premultiplied = frame.premultiplied;
        let clears_holes = state.clears_holes;
        let watched = state.see_through_over.clone();
        let mut watched_cols: Vec<(u32, u32)> = Vec::new();
        let mut see_through = false;
        let image_cost = self.identity.image_cost(self.patch_medium().is_none(), (canvas.width, canvas.height));
        let clear = vec![0u8; row_len];
        let mut consolidated = false;
        let moved = state.compared.as_ref().is_none_or(|(origin, ..)| *origin != layer.origin_y);
        let unmoved = layer.under.is_empty() && state.compared.as_ref().is_some_and(|(origin, was, was_holes)| *origin == layer.origin_y && *was == area && was_holes.as_slice() == holes);
        let damaged: Option<Vec<Rect>> = unmoved.then(|| frame.changed.iter().chain(frame.repainted).chain(frame.ui_over_surfaces).map(|r| intersect(*r, area)).filter(|r| !r.is_empty()).collect());
        let holes_changed = state.compared.as_ref().is_none_or(|(_, was, was_holes)| *was != area || was_holes.as_slice() != holes);
        state.compared = Some((layer.origin_y, area, holes.to_vec()));
        let band_of = |k: i64| {
            let y0 = layer.origin_y + k * stripe;
            let shown_top = y0.max(i64::from(area.y));
            let shown_bottom = (y0 + stripe).min(i64::from(area.y + area.h));
            (y0, shown_top, Rect { x: 0, y: (shown_top - y0) as u32, w: area.w, h: (shown_bottom - shown_top) as u32 })
        };
        let jump = state.jumping(layer.origin_y);
        for k in visible.clone() {
            let (y0, shown_top, band) = band_of(k);
            if !state.stripes.contains_key(&k) {
                let unknown = vec![Rect::sized(area.w, stripe_px)];
                state.stripes.insert(k, Stripe { pixels: vec![0; (area.w * stripe_px * 4) as usize], sent: Vec::new(), unknown, pending: Vec::new(), images: Vec::new(), patches: Vec::new() });
            }
            let screen = Rect { x: area.x, y: shown_top as u32, w: area.w, h: band.h };
            let unders: Vec<_> = layer.under.iter().filter(|u| !intersect(u.rect, screen).is_empty()).collect();
            let entry = state.stripes.get_mut(&k).expect("inserted above");
            let mut diff = std::mem::take(&mut entry.pending);
            for r in 0..band.h {
                let y = screen.y + r;
                if damaged.as_ref().is_some_and(|d| !d.iter().any(|d| y >= d.y && y < d.y + d.h)) {
                    continue;
                }
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
                let open = open_spans(area, holes, y);
                let reopens = clears_holes && (holes_changed || moved);
                let closed = if reopens { closed_spans(area.w, &open) } else { Vec::new() };
                watched_cols.clear();
                watched_cols.extend(
                    watched
                        .iter()
                        .filter(|o| y >= o.y && y < o.y + o.h)
                        .map(|o| (o.x.max(area.x) - area.x, (o.x + o.w).min(area.x + area.w).saturating_sub(area.x)))
                        .filter(|(a, b)| a < b),
                );
                let wanted = open.into_iter().map(|span| (span.clone(), &row[span.start as usize * 4..span.end as usize * 4], true));
                let cleared = closed.into_iter().map(|span| (span.clone(), &clear[span.start as usize * 4..span.end as usize * 4], false));
                for (span, pixels, shown) in wanted.chain(cleared) {
                    let stored = &mut entry.pixels[at + span.start as usize * 4..at + span.end as usize * 4];
                    let see_through_in = |from: u32, to: u32| {
                        watched_cols.iter().any(|&(a, b)| {
                            let (a, b) = (a.max(from), b.min(to));
                            a < b && !all_opaque(&row[a as usize * 4..b as usize * 4])
                        })
                    };
                    if stored != pixels {
                        for (first, last) in changed_runs(stored, pixels, image_cost) {
                            see_through |= shown && see_through_in(span.start + first, span.start + last + 1);
                            add_changed(&mut diff, Rect { x: span.start + first, y: band.y + r, w: last + 1 - first, h: 1 }, image_cost);
                        }
                        stored.copy_from_slice(pixels);
                    } else if shown && reopens {
                        see_through |= see_through_in(span.start, span.end);
                    }
                }
            }
            let hidden = if clears_holes { Vec::new() } else { local_holes(holes, area, y0, band) };
            let watched_here = local_holes(&watched, area, y0, band);
            let shown_holes = if watched_here.is_empty() { Vec::new() } else { local_holes(holes, area, y0, band) };
            let mut still_unknown = Vec::new();
            for unseen in std::mem::take(&mut entry.unknown) {
                still_unknown.extend(subtract(&[unseen], band));
                let shown = intersect(unseen, band);
                if shown.is_empty() {
                    continue;
                }
                let seen = subtract_all(vec![shown], &hidden);
                still_unknown.extend(subtract_all(vec![shown], &seen));
                for part in seen {
                    see_through |= watched_here
                        .iter()
                        .map(|w| intersect(part, *w))
                        .filter(|w| !w.is_empty())
                        .flat_map(|w| subtract_all(vec![w], &shown_holes))
                        .any(|w| !opaque(&entry.pixels, w, row_len));
                    add_changed(&mut diff, part, image_cost);
                }
            }
            entry.unknown = still_unknown;
            entry.pending = settle(diff, image_cost);
        }
        if see_through {
            report.see_through = true;
            return Ok(report);
        }
        let medium = self.patch_medium();
        let budget = if medium.is_some() { JUMP_UPLOAD_BUDGET } else { INLINE_JUMP_UPLOAD_BUDGET };
        let stripe_bytes = row_len * stripe_px as usize;
        let whole_at_percent = state.whole_at_percent;
        let stacks = state.stacks;
        let mut spent = 0;
        for k in visible.clone() {
            let entry = state.stripes.get_mut(&k).expect("inserted above");
            let complete = (moved || !stacks) && entry.unknown.is_empty() && entry.patches.len() >= 2 && !consolidated && medium.is_none_or(|m| self.has_ready_payload(m, stripe_bytes));
            let pending = std::mem::take(&mut entry.pending);
            let rects = if complete { vec![Rect::sized(area.w, stripe_px)] } else { pending };
            let stripe_top = layer.origin_y + k * stripe;
            for (index, &changed) in rects.iter().enumerate() {
                let entry = state.stripes.get_mut(&k).expect("inserted above");
                let stack_level = (stacks && !complete && opaque(&entry.pixels, changed, row_len))
                    .then(|| entry.patches.iter().filter(|p| !contains(changed, p.rect)).map(|p| p.level).max().unwrap_or(0) + 1)
                    .filter(|level| *level <= MAX_PATCHES as i32);
                let stacked = stack_level.is_some();
                let mut rect = changed;
                loop {
                    if stacked {
                        break;
                    }
                    let grown = entry.patches.iter().filter(|p| !intersect(p.rect, rect).is_empty()).fold(rect, |r, p| union(r, p.rect));
                    if grown == rect {
                        break;
                    }
                    rect = grown;
                }
                let level = stack_level.unwrap_or(1);
                let counted = if stacks { entry.patches.len() / 2 } else { entry.patches.len() };
                let whole = uploads_whole(rect, area.w, stripe_px, counted, whole_at_percent) || !covers(&entry.pixels, &entry.sent, rect, row_len);
                let cost = if whole { stripe_bytes } else { rect.area() as usize * 4 };
                if jump && spent > 0 && spent + cost > budget {
                    entry.pending.extend_from_slice(&rects[index..]);
                    break;
                }
                spent += cost;
                consolidated |= complete;
                let (merged, kept): (Vec<Patch>, Vec<Patch>) = std::mem::take(&mut entry.patches).into_iter().partition(|p| if stacked { contains(rect, p.rect) } else { !intersect(p.rect, rect).is_empty() });
                entry.patches = kept;
                let mut freed: Vec<u32> = merged.iter().map(|p| p.placed.id).collect();
                if whole {
                    freed.extend(entry.patches.drain(..).map(|p| p.placed.id));
                    let mut old: Vec<u32> = entry.images.drain(..).map(|p| p.placed.id).collect();
                    let columns = if clears_holes { drawn_columns(&entry.pixels, area.w, image_cost) } else { seen_columns(&entry.unknown, area.w, stripe_px, image_cost) };
                    let mut images = Vec::new();
                    for columns in columns {
                        let id = old.pop().or_else(|| freed.pop()).unwrap_or_else(|| self.patches.ids.take());
                        let part = Rect { x: columns.start, y: 0, w: columns.end - columns.start, h: stripe_px };
                        let entry = state.stripes.get_mut(&k).expect("inserted above");
                        self.send_part(out, id, part, &entry.pixels, &[], area.w, premultiplied)?;
                        self.flash_stripe_upload(out, area, stripe_top, part);
                        images.push(Piece { x: part.x, w: part.w, placed: Placed { id, shown: None } });
                    }
                    freed.extend(old);
                    let entry = state.stripes.get_mut(&k).expect("inserted above");
                    entry.sent = only_columns(&entry.pixels, area.w, &images.iter().map(|p| p.x..p.x + p.w).collect::<Vec<_>>());
                    entry.images = images;
                    report.stripes_sent += 1;
                } else {
                    let id = freed.pop().unwrap_or_else(|| self.patches.ids.take());
                    let entry = state.stripes.get_mut(&k).expect("inserted above");
                    self.send_part(out, id, rect, &entry.pixels, &entry.sent, area.w, premultiplied)?;
                    self.flash_stripe_upload(out, area, stripe_top, rect);
                    entry.patches.push(Patch { rect, placed: Placed { id, shown: None }, level });
                    report.overlays_sent += 1;
                }
                for id in freed {
                    out.extend_from_slice(&crate::kitty::kitty_delete_one(id));
                    self.patches.ids.give_back([id]);
                }
                if whole {
                    break;
                }
            }
        }
        let waiting = jump && visible.clone().any(|k| state.stripes.get(&k).is_some_and(|s| !s.pending.is_empty()));
        state.holding = if waiting { state.holding + 1 } else { 0 };
        if waiting || !place {
            pixel_core::profiler::count("present.stripes", || report.stripes_sent);
            report.waiting = waiting;
            return Ok(report);
        }
        for k in visible.clone() {
            let (y0, shown_top, band) = band_of(k);
            let entry = state.stripes.get_mut(&k).expect("inserted above");
            let mut images = std::mem::take(&mut entry.images);
            let mut patches = std::mem::take(&mut entry.patches);
            let rows = (band.h < stripe_px).then_some((band.y, band.h));
            for piece in &mut images {
                self.place_part(out, &mut piece.placed, (area.x + piece.x, shown_top as u32), rows, state.z);
            }
            report.moved += u64::from(!images.is_empty());
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
                self.place_part(out, &mut patch.placed, (area.x + patch.rect.x, top), rows, state.z + PATCH_Z + patch.level - 1);
            }
            let entry = state.stripes.get_mut(&k).expect("inserted above");
            entry.images = images;
            entry.patches = patches;
        }
        let keep = keep_screens() * i64::from(area.h) / stripe;
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
                for placed in entry.images.iter_mut().map(|p| &mut p.placed).chain(entry.patches.iter_mut().map(|p| &mut p.placed)) {
                    if placed.shown.take().is_some() {
                        out.extend_from_slice(&crate::kitty::kitty_delete_placement(placed.id));
                    }
                }
            }
        }
        for k in dropped {
            if let Some(entry) = state.stripes.remove(&k) {
                self.patches.ids.give_back(entry.ids());
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
        for index in layer.overlays.len()..state.overlays.len() {
            out.extend_from_slice(&crate::kitty::kitty_delete_one(FIRST_OVERLAY_ID + index as u32));
        }
        state.overlays.truncate(layer.overlays.len());
        pixel_core::profiler::count("present.overlays", || sent);
        Ok(sent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::Identity;
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
    fn all_opaque_finds_any_see_through_pixel_at_any_width() {
        for width in 0..40 {
            let opaque = vec![255u8; width * 4];
            assert!(all_opaque(&opaque));
            for at in 0..width {
                for channel in 0..4 {
                    let mut pixels = opaque.clone();
                    pixels[at * 4 + channel] = 254;
                    assert_eq!(all_opaque(&pixels), channel != 3, "width {width} pixel {at} channel {channel}");
                }
            }
        }
    }

    #[test]
    fn inline_layers_send_stripes_once_and_scroll_by_placing_them() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        assert!(kitty.patch_medium().is_none());
        let area = Rect::sized(64, 2 * STRIPE_PX);
        kitty.patches.layer = Some(Layer::new(area, STRIPE_PX));
        let first = ScrollLayer { area, origin_y: 0, under: Vec::new(), overlays: Vec::new() };
        let out = draw(&mut kitty, &content(64, area.h, 0), &first);
        assert_eq!(out.matches("a=t,f=32,o=z,s=64,v=128,t=d,").count(), 2);
        assert_eq!(out.matches("a=p,").count(), 2);

        let scrolled = ScrollLayer { origin_y: -i64::from(STRIPE_PX), ..first };
        let out = draw(&mut kitty, &content(64, area.h, scrolled.origin_y), &scrolled);
        assert_eq!(out.matches("a=t,").count(), 1, "only the stripe scrolled into view is uploaded");
        let (first_id, second_id) = (STRIP_IDS.start, STRIP_IDS.start + 1);
        assert!(out.contains(&format!("\x1b[1;1H\x1b_Ga=p,i={second_id},p=1,C=1,q=2")), "the second stripe moves to the top");
        assert!(out.contains(&format!("a=d,d=i,i={first_id},p=1")), "the stripe scrolled out of view is hidden but kept");
    }

    #[test]
    fn far_apart_changes_in_a_stripe_stay_separate_patches() {
        let stored = vec![0u8; 8000 * 4];
        let mut now = stored.clone();
        for x in [3usize, 5, 7000] {
            now[x * 4] = 9;
        }
        assert_eq!(changed_runs(&stored, &now, super::super::MIN_IMAGE_COST_BYTES), vec![(3, 5), (7000, 7000)]);
        let mut diff = Vec::new();
        for y in 0..4 {
            add_changed(&mut diff, Rect { x: 3, y, w: 3, h: 1 }, super::super::MIN_IMAGE_COST_BYTES);
            add_changed(&mut diff, Rect { x: 7000, y, w: 1, h: 1 }, super::super::MIN_IMAGE_COST_BYTES);
        }
        assert_eq!(settle(diff, super::super::MIN_IMAGE_COST_BYTES), vec![Rect { x: 3, y: 0, w: 3, h: 4 }, Rect { x: 7000, y: 0, w: 1, h: 4 }]);
    }

    #[test]
    fn change_runs_match_a_pixel_by_pixel_scan() {
        let naive = |a: &[u8], b: &[u8], cost: u64| {
            let mut runs: Vec<(u32, u32)> = Vec::new();
            for (x, _) in a.chunks_exact(4).zip(b.chunks_exact(4)).enumerate().filter(|(_, (p, q))| p != q) {
                let x = x as u32;
                match runs.last_mut() {
                    Some(run) if worth_one_image(u64::from(x - run.1 - 1), cost) => run.1 = x,
                    _ => runs.push((x, x)),
                }
            }
            runs
        };
        let mut seed = 7u32;
        for width in [1usize, 7, 8, 9, 63, 300, 1031] {
            for density in [1u32, 5, 40, 400] {
                let a: Vec<u8> = (0..width * 4).map(|i| (i % 251) as u8).collect();
                let mut b = a.clone();
                for x in 0..width {
                    seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                    if (seed >> 16) % density == 0 {
                        b[x * 4 + (seed as usize % 4)] ^= 0x5a;
                    }
                }
                for cost in [super::super::MIN_IMAGE_COST_BYTES, 26_150, 107_150] {
                    assert_eq!(changed_runs(&a, &b, cost), naive(&a, &b, cost), "width {width} density {density} cost {cost}");
                }
            }
        }
    }

    #[test]
    fn web_layers_share_one_pool_of_image_ids() {
        let mut ids = ImageIds::default();
        let first: Vec<u32> = (0..20_000).map(|_| ids.take()).collect();
        assert!(first.iter().all(|id| STRIP_IDS.contains(id)));
        assert_eq!(first.iter().collect::<std::collections::HashSet<_>>().len(), first.len(), "no id is handed out twice");
        ids.give_back(first[..10].iter().copied());
        let reused: Vec<u32> = (0..10).map(|_| ids.take()).collect();
        assert!(reused.iter().all(|id| first[..10].contains(id)), "freed ids come back before new ones");
        assert_eq!(ids.take(), STRIP_IDS.start + 20_000);
    }

    #[test]
    fn changes_merge_while_the_extra_pixels_cost_less_than_one_more_image() {
        let inline = Identity::Ghostty { version: (1, 3, 1) }.image_cost(true, (1650, 1188));
        let rex = Identity::Rex.image_cost(false, (3024, 1964));
        let rex_5k = Identity::Rex.image_cost(false, (5120, 2880));
        assert_eq!(Identity::Rex.image_cost(false, (1512, 982)), rex, "below the baseline window a Rex image costs the same");
        assert!(rex_5k > 2 * rex && rex_5k < 3 * rex, "a 5K window is 2.5x the baseline area, so an image is worth 2.5x the pixels");
        assert_eq!(settle(vec![Rect { x: 0, y: 0, w: 4, h: 4 }, Rect { x: 2996, y: 0, w: 4, h: 4 }], rex_5k).len(), 1);
        assert_eq!(settle(vec![Rect { x: 0, y: 0, w: 4, h: 4 }, Rect { x: 2996, y: 0, w: 4, h: 4 }], rex).len(), 2);
        let apart = vec![Rect { x: 0, y: 0, w: 4, h: 4 }, Rect { x: 1500, y: 0, w: 4, h: 4 }];
        assert_eq!(settle(apart.clone(), inline).len(), 2, "over ssh 5,984 extra pixels still compress to more than an image");
        assert_eq!(settle(apart, rex), vec![Rect { x: 0, y: 0, w: 1504, h: 4 }], "in Rex one image beats two");
        let near = vec![Rect { x: 3, y: 0, w: 3, h: 4 }, Rect { x: 300, y: 0, w: 1, h: 4 }];
        assert_eq!(settle(near, inline).len(), 1, "over ssh pixels go out compressed, so a 1,180-pixel gap is cheaper than another image");
        assert_eq!(column_runs([0, 1, 2, 43, 44].into_iter(), 128, inline), vec![0..3, 43..45]);
        assert_eq!(column_runs([0, 1, 2, 43, 44].into_iter(), 128, rex), vec![0..45]);
        assert_eq!(column_runs([0, 1, 2, 90, 91].into_iter(), 128, rex), vec![0..3, 90..92], "a 44 kB gap still costs more than one image in Rex");
    }
}

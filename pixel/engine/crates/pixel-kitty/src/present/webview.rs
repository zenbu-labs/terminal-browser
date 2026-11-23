use std::collections::{HashMap, HashSet};
use std::io;
use std::time::Instant;

use crate::Kitty;
use super::layer::{all_opaque, ImageIds, Layer};
use super::tiles::{intersect, subtract};
use pixel_core::surfaces::{DrawnLayer, Rect, ScrollNode, ScrollTree, SurfacePlacement};
use pixel_raster::{Canvas, PixelFrame as Frame, ScrollLayer};

const MAX_LAYERS: usize = 4;
const MIN_NODE_W: u32 = 200;
const MIN_NODE_H: u32 = 120;
const MIN_MOVED_W: u32 = 48;
const SCREEN: u64 = 0;
const SCREEN_DEPTH: u32 = 1_000;
const OWNER_CELL: u32 = 16;
const MOVED: u64 = 1 << 62;

#[derive(Debug)]
pub(crate) struct WebLayers {
    pub(super) surface: u32,
    pub(super) area: Rect,
    nodes: HashMap<u64, NodeLayer>,
    seen: HashMap<u64, Seen>,
    see_through: HashMap<u64, (Rect, Option<Rect>)>,
    clears_all_holes: bool,
    pinned: Vec<Rect>,
    retired: Vec<(u32, Layer)>,
}

#[derive(Debug)]
struct NodeLayer {
    layer: Layer,
    slot: u32,
    depth: u32,
    origin: Option<i64>,
    plan: Option<Planned>,
}

#[derive(Debug, Clone, Copy)]
struct Planned {
    placed: Rect,
    area: Rect,
    origin: Option<i64>,
}

#[derive(Debug)]
struct Seen {
    offset: f32,
    across: f32,
    changed: Option<Instant>,
}

#[derive(Debug, Clone, Copy)]
struct Placed {
    rect: Rect,
    origin: Option<i64>,
    depth: u32,
}

fn moved_key(layer_id: i32) -> u64 {
    MOVED | u64::from(layer_id as u32)
}

fn whole(v: f32) -> bool {
    v.fract() == 0.0 && v >= 0.0
}

pub(super) fn drawn_one_to_one(placement: &SurfacePlacement, canvas: (u32, u32)) -> Option<Rect> {
    let [x, y, w, h] = placement.rect;
    let aligned = [x, y, w, h].into_iter().all(whole);
    let rect = Rect { x: x as u32, y: y as u32, w: w as u32, h: h as u32 };
    let fits = rect.x + rect.w <= canvas.0 && rect.y + rect.h <= canvas.1;
    (aligned && placement.visible == placement.rect && placement.size == (rect.w, rect.h) && fits && !rect.is_empty()).then_some(rect)
}

fn translation(m: &[f32; 16]) -> Option<(i64, i64)> {
    let linear = m[0] == 1.0 && m[1] == 0.0 && m[3] == 0.0 && m[4] == 0.0 && m[5] == 1.0 && m[7] == 0.0 && m[15] == 1.0;
    let px = |v: f32| (v.is_finite() && (v - v.round()).abs() < 1e-3).then(|| v.round() as i64);
    linear.then_some(())?;
    Some((px(m[12])?, px(m[13])?))
}

fn clip(a: Rect, x0: i64, y0: i64, x1: i64, y1: i64) -> Rect {
    let l = i64::from(a.x).max(x0);
    let t = i64::from(a.y).max(y0);
    let r = i64::from(a.x + a.w).min(x1);
    let b = i64::from(a.y + a.h).min(y1);
    if r <= l || b <= t {
        return Rect::default();
    }
    Rect { x: l as u32, y: t as u32, w: (r - l) as u32, h: (b - t) as u32 }
}

fn row_opaque(canvas: &Canvas, rect: Rect, y: u32) -> bool {
    let at = y as usize * canvas.width as usize * 4 + rect.x as usize * 4;
    all_opaque(&canvas.pixels[at..at + rect.w as usize * 4])
}

fn opaque_rows(canvas: &Canvas, rect: Rect) -> Option<Rect> {
    let opaque = |y: u32| row_opaque(canvas, rect, y);
    let mut top = rect.y;
    let mut bottom = rect.y + rect.h;
    while top < bottom && !opaque(top) {
        top += 1;
    }
    while bottom > top && !opaque(bottom - 1) {
        bottom -= 1;
    }
    (top < bottom && (top..bottom).all(opaque)).then_some(Rect { y: top, h: bottom - top, ..rect })
}

fn regained_rows(canvas: &Canvas, full: Rect, kept: Option<Rect>, damage: &[Rect]) -> Option<Rect> {
    let Some(kept) = kept else {
        return if damage.iter().any(|d| !intersect(*d, full).is_empty()) { opaque_rows(canvas, full) } else { None };
    };
    let mut top = kept.y;
    while top > full.y && row_opaque(canvas, full, top - 1) {
        top -= 1;
    }
    let mut bottom = kept.y + kept.h;
    while bottom < full.y + full.h && row_opaque(canvas, full, bottom) {
        bottom += 1;
    }
    Some(Rect { y: top, h: bottom - top, ..kept })
}

struct Owners<'a> {
    by_id: HashMap<i32, &'a ScrollNode>,
    layered: &'a HashSet<u64>,
}

impl<'a> Owners<'a> {
    fn new(tree: &'a ScrollTree, layered: &'a HashSet<u64>) -> Self {
        Self { by_id: tree.nodes.iter().map(|n| (n.id, n)).collect(), layered }
    }

    fn of(&self, scroll_node_id: i32) -> u64 {
        let mut at = scroll_node_id;
        for _ in 0..=self.by_id.len() {
            match self.by_id.get(&at) {
                Some(node) if node.scrolls_outer_viewport || self.layered.contains(&node.element_id) => return node.element_id,
                Some(node) if !node.scrolls_inner_viewport => at = node.container_scroll_node_id,
                _ => return SCREEN,
            }
        }
        SCREEN
    }

    fn of_layer(&self, layer: &DrawnLayer) -> u64 {
        let key = moved_key(layer.layer_id);
        if self.layered.contains(&key) { key } else { self.of(layer.scroll_node_id) }
    }
}

fn owned_region(tree: &ScrollTree, owners: &Owners<'_>, surface: Rect, wanted: u64) -> Option<Rect> {
    if tree.drawn_layers.is_empty() {
        return Some(surface);
    }
    let cols = surface.w.div_ceil(OWNER_CELL) as usize;
    let rows = surface.h.div_ceil(OWNER_CELL) as usize;
    let mut cells = vec![u64::MAX; cols * rows];
    let half = i64::from(OWNER_CELL / 2);
    for layer in &tree.drawn_layers {
        let (x, y, w, h) = layer.rect;
        let first = |start: i64| ((start - half).max(0) + i64::from(OWNER_CELL) - 1) / i64::from(OWNER_CELL);
        let last = |end: i64, count: usize| ((end - half).div_euclid(i64::from(OWNER_CELL))).min(count as i64 - 1);
        let (c0, c1) = (first(i64::from(x)), last(i64::from(x) + i64::from(w) - 1, cols));
        let (r0, r1) = (first(i64::from(y)), last(i64::from(y) + i64::from(h) - 1, rows));
        if c1 < c0 || r1 < r0 {
            continue;
        }
        let who = owners.of_layer(layer);
        for r in r0..=r1 {
            cells[r as usize * cols + c0 as usize..=r as usize * cols + c1 as usize].fill(who);
        }
    }
    let owned: Vec<(usize, usize)> = (0..rows).flat_map(|r| (0..cols).map(move |c| (c, r))).filter(|(c, r)| cells[r * cols + c] == wanted).collect();
    let c0 = owned.iter().map(|(c, _)| *c).min()?;
    let c1 = owned.iter().map(|(c, _)| *c).max()?;
    let r0 = owned.iter().map(|(_, r)| *r).min()?;
    let r1 = owned.iter().map(|(_, r)| *r).max()?;
    let x0 = if c0 == 0 { surface.x } else { surface.x + c0 as u32 * OWNER_CELL };
    let y0 = if r0 == 0 { surface.y } else { surface.y + r0 as u32 * OWNER_CELL };
    let x1 = (surface.x + (c1 as u32 + 1) * OWNER_CELL).min(surface.x + surface.w);
    let y1 = (surface.y + (r1 as u32 + 1) * OWNER_CELL).min(surface.y + surface.h);
    Some(Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
}

fn pinned_on_top(tree: &ScrollTree, owners: &Owners<'_>, surface: Rect) -> Vec<Rect> {
    let mut pinned: Vec<Rect> = Vec::new();
    for layer in &tree.drawn_layers {
        let (x, y, w, h) = layer.rect;
        let (x0, y0) = (i64::from(surface.x) + i64::from(x), i64::from(surface.y) + i64::from(y));
        let rect = clip(surface, x0, y0, x0 + i64::from(w), y0 + i64::from(h));
        if rect.is_empty() {
            continue;
        }
        if owners.of_layer(layer) == SCREEN {
            pinned.push(rect);
        } else {
            pinned = pinned.iter().flat_map(|p| subtract(&[*p], rect)).collect();
        }
    }
    pinned
}

fn place(tree: &ScrollTree, owners: &Owners<'_>, surface: Rect) -> HashMap<u64, Placed> {
    let by_id = &owners.by_id;
    let viewport = |n: &ScrollNode| n.scrolls_inner_viewport || n.scrolls_outer_viewport;
    let mut placed = HashMap::new();
    for node in &tree.nodes {
        if node.scrolls_outer_viewport {
            let origin = (node.transform_id >= 0).then(|| translation(&node.to_screen)).flatten().map(|(_, y)| i64::from(surface.y) + y);
            if let Some(rect) = owned_region(tree, owners, surface, node.element_id) {
                placed.insert(node.element_id, Placed { rect, origin, depth: 1 });
            }
            continue;
        }
        if viewport(node) {
            continue;
        }
        let mut rect = surface;
        let mut depth = 2;
        let mut ok = true;
        let mut at = Some(node);
        while let Some(n) = at {
            if viewport(n) {
                break;
            }
            let container = (n.transform_id >= 0).then(|| translation(&n.container_to_screen)).flatten();
            let contents = (n.transform_id >= 0).then(|| translation(&n.to_screen)).flatten();
            let (Some((cx, cy)), Some(_)) = (container, contents) else {
                ok = false;
                break;
            };
            let x0 = i64::from(surface.x) + cx + i64::from(n.container_origin.0);
            let y0 = i64::from(surface.y) + cy + i64::from(n.container_origin.1);
            rect = clip(rect, x0, y0, x0 + i64::from(n.container_bounds.0), y0 + i64::from(n.container_bounds.1));
            if !std::ptr::eq(n, node) {
                depth += 1;
            }
            at = by_id.get(&n.parent_id).copied();
        }
        if !ok || rect.is_empty() {
            continue;
        }
        let draws_nothing = node.is_composited && !tree.drawn_layers.is_empty() && !tree.drawn_layers.iter().any(|l| l.scroll_node_id == node.id);
        if draws_nothing {
            continue;
        }
        let origin = translation(&node.to_screen).map(|(_, y)| i64::from(surface.y) + y);
        placed.insert(node.element_id, Placed { rect, origin, depth });
    }
    placed
}

impl WebLayers {
    pub(super) fn holding(&self) -> bool {
        self.nodes.values().any(|n| n.layer.holding())
    }

    pub(super) fn delete_all(&self, out: &mut Vec<u8>, ids: &mut ImageIds) {
        for node in self.nodes.values() {
            node.layer.delete_all(out, ids);
        }
        for (_, layer) in &self.retired {
            layer.delete_all(out, ids);
        }
    }

    fn note_scrolls(&mut self, tree: &ScrollTree, now: Instant) {
        let scrolled_by = |id: i32| tree.nodes.iter().find(|n| n.id == id && n.transform_id >= 0).map_or((0.0, 0.0), |n| (n.to_screen[12], n.to_screen[13]));
        let moving = tree.drawn_layers.iter().filter_map(|l| {
            let (x, y) = l.translation?;
            let (sx, sy) = scrolled_by(l.scroll_node_id);
            Some((moved_key(l.layer_id), (x as f32 - sx, y as f32 - sy)))
        });
        let positions: Vec<(u64, (f32, f32))> = tree.nodes.iter().map(|n| (n.element_id, (n.scroll_offset.0, n.scroll_offset.1))).chain(moving).collect();
        for &(id, (across, offset)) in &positions {
            let seen = self.seen.entry(id).or_insert(Seen { offset, across, changed: None });
            let moved = if id & MOVED == 0 { seen.offset != offset } else { (seen.offset - offset).abs() > 1.0 && (seen.across - across).abs() <= 1.0 };
            if moved {
                seen.changed = Some(now);
            }
            seen.offset = offset;
            seen.across = across;
        }
        self.seen.retain(|id, _| positions.iter().any(|(p, _)| p == id));
    }

    fn free_slot(&self) -> Option<u32> {
        (0..MAX_LAYERS as u32).find(|s| !self.nodes.values().any(|n| n.slot == *s) && !self.retired.iter().any(|(r, _)| r == s))
    }

    fn plan(&mut self, tree: &ScrollTree, frame: Frame<'_>, now: Instant, stripe_px: u32, keep_screens: i64) {
        for layer in self.nodes.values_mut() {
            layer.plan = None;
        }
        let layered: HashSet<u64> = self.nodes.keys().copied().collect();
        let owners = Owners::new(tree, &layered);
        let mut placed = place(tree, &owners, self.area);
        for layer in &tree.drawn_layers {
            let Some((_, y)) = layer.translation else { continue };
            let key = moved_key(layer.layer_id);
            let moved_now = self.seen.get(&key).is_some_and(|s| s.changed == Some(now));
            if !moved_now && !layered.contains(&key) {
                continue;
            }
            let (lx, ly, lw, lh) = layer.rect;
            let (x0, y0) = (i64::from(self.area.x) + i64::from(lx), i64::from(self.area.y) + i64::from(ly));
            let rect = clip(self.area, x0, y0, x0 + i64::from(lw), y0 + i64::from(lh));
            if rect.w < MIN_MOVED_W || rect.h < MIN_NODE_H {
                continue;
            }
            let depth = placed.get(&owners.of(layer.scroll_node_id)).map_or(1, |p| p.depth) + 1;
            placed.insert(key, Placed { rect, origin: Some(i64::from(self.area.y) + i64::from(y)), depth });
        }
        let full: HashMap<u64, Rect> = placed.iter().map(|(id, p)| (*id, p.rect)).collect();
        let damage: Vec<Rect> = frame.changed.iter().chain(frame.repainted).copied().collect();
        self.see_through.retain(|id, _| full.contains_key(id));
        for (id, (from, rows)) in self.see_through.iter_mut() {
            let Some(at) = placed.get_mut(id) else { continue };
            if *from != at.rect {
                *from = at.rect;
                *rows = opaque_rows(frame.canvas, at.rect);
            } else {
                *rows = regained_rows(frame.canvas, at.rect, *rows, &damage);
            }
            match rows {
                Some(rows) => at.rect = *rows,
                None => {
                    placed.remove(id);
                }
            }
        }
        let uncovered = placed.values().filter(|p| p.depth == 1).fold(vec![self.area], |parts, p| parts.iter().flat_map(|part| subtract(&[*part], p.rect)).collect::<Vec<_>>());
        self.pinned = pinned_on_top(tree, &owners, self.area).into_iter().filter(|r| placed.values().any(|p| !intersect(*r, p.rect).is_empty())).collect();
        if !uncovered.is_empty() || !self.pinned.is_empty() {
            placed.insert(SCREEN, Placed { rect: self.area, origin: Some(i64::from(self.area.y)), depth: SCREEN_DEPTH });
        }
        let mut order: Vec<(&u64, &Placed)> = placed.iter().collect();
        order.sort_unstable_by_key(|(id, p)| (**id != SCREEN && p.depth > 1, p.depth, **id));
        for (&id, &at) in order {
            if let Some(layer) = self.nodes.get_mut(&id) {
                let keeps = at.depth <= 1 || at.origin.is_some();
                if keeps && layer.depth == at.depth && layer.layer.area.x == at.rect.x && layer.layer.area.w == at.rect.w {
                    layer.layer.area = at.rect;
                    layer.plan = Some(Planned { placed: full.get(&id).copied().unwrap_or(at.rect), area: at.rect, origin: at.origin });
                }
                continue;
            }
            let node = tree.nodes.iter().find(|n| n.element_id == id);
            let scrolled_now = self.seen.get(&id).is_some_and(|s| s.changed == Some(now));
            let promotable = at.depth <= 1
                || id == SCREEN
                || (at.origin.is_some() && id & MOVED != 0 && scrolled_now)
                || (at.origin.is_some() && node.is_some_and(|n| n.user_scrollable_vertical) && at.rect.w >= MIN_NODE_W && at.rect.h >= MIN_NODE_H && scrolled_now);
            if !promotable {
                continue;
            }
            if self.free_slot().is_none() {
                let seen = &self.seen;
                let stalest = self.nodes.iter().filter(|(id, n)| n.depth > 1 && **id != SCREEN).min_by_key(|(id, _)| seen.get(id).and_then(|s| s.changed)).map(|(id, _)| *id);
                if let Some(node) = stalest.and_then(|id| self.nodes.remove(&id)) {
                    self.retired.push((node.slot, node.layer));
                }
            }
            let Some(slot) = self.free_slot() else { continue };
            let layer = if id == SCREEN { Layer::for_screen(at.rect, at.depth, stripe_px) } else { Layer::for_node(at.rect, at.depth, stripe_px) }.keeping(keep_screens);
            self.nodes.insert(id, NodeLayer { layer, slot, depth: at.depth, origin: None, plan: Some(Planned { placed: full.get(&id).copied().unwrap_or(at.rect), area: at.rect, origin: at.origin }) });
        }
        self.watch_see_through();
        let gone: Vec<u64> = self.nodes.iter().filter(|(_, n)| n.plan.is_none()).map(|(id, _)| *id).collect();
        for id in gone {
            if let Some(node) = self.nodes.remove(&id) {
                self.retired.push((node.slot, node.layer));
            }
        }
    }

    fn watch_see_through(&mut self) {
        let regions: Vec<Rect> = self.nodes.iter().filter(|(id, _)| **id != SCREEN).filter_map(|(_, n)| n.plan.map(|p| p.area)).collect();
        let pinned_over_regions: Vec<Rect> = self.pinned.iter().flat_map(|p| regions.iter().map(|r| intersect(*p, *r))).filter(|r| !r.is_empty()).collect();
        let clears_all_holes = self.clears_all_holes;
        for (id, node) in self.nodes.iter_mut() {
            let Some(plan) = node.plan else { continue };
            let under = match *id {
                _ if clears_all_holes => {
                    node.layer.clear_holes();
                    Vec::new()
                }
                SCREEN => pinned_over_regions.clone(),
                _ => vec![plan.area],
            };
            node.layer.watch_see_through_over(under);
        }
    }
}

impl Kitty {
    pub(super) fn plan_web(&mut self, frame: Frame<'_>, out: &mut Vec<u8>) -> Option<(u32, Rect)> {
        let canvas = (frame.canvas.width, frame.canvas.height);
        let found = frame.layer.is_none().then(|| {
            frame.surfaces?.placements.iter().find_map(|p| {
                let tree = p.scroll_tree.as_ref()?;
                tree.nodes.iter().any(|n| n.scrolls_outer_viewport).then_some(())?;
                Some((p.surface, drawn_one_to_one(p, canvas)?, tree.clone()))
            })
        });
        let Some((surface, area, tree)) = found.flatten() else {
            if let Some(old) = self.patches.web.take() {
                old.delete_all(out, &mut self.patches.ids);
            }
            return None;
        };
        if self.patches.web.as_ref().is_some_and(|w| w.surface != surface || w.area != area) {
            if let Some(old) = self.patches.web.take() {
                old.delete_all(out, &mut self.patches.ids);
            }
        }
        let keep_screens = super::keep_screens_for(self.identity);
        let stripe_px = super::layer::web_stripe_px().unwrap_or_else(|| super::stripe_px_for(self.identity, super::layer::STRIPE_PX, canvas.1));
        let web = self.patches.web.get_or_insert_with(|| WebLayers { surface, area, nodes: HashMap::new(), seen: HashMap::new(), see_through: HashMap::new(), clears_all_holes: false, pinned: Vec::new(), retired: Vec::new() });
        let now = Instant::now();
        web.note_scrolls(&tree, now);
        web.plan(&tree, frame, now, stripe_px, keep_screens);
        Some((surface, area))
    }

    pub(super) fn draw_web(&mut self, frame: Frame<'_>, out: &mut Vec<u8>) -> io::Result<()> {
        for _ in 0..=MAX_LAYERS {
            match self.draw_web_pass(frame, out)? {
                Some(id) => {
                    let Some(web) = self.patches.web.as_mut() else { return Ok(()) };
                    if id == SCREEN {
                        web.clears_all_holes = true;
                    } else {
                        let Some(placed) = web.nodes.get(&id).and_then(|n| n.plan).map(|p| p.placed) else { return Ok(()) };
                        web.see_through.insert(id, (placed, opaque_rows(frame.canvas, placed)));
                    }
                    pixel_core::profiler::count("present.web_see_through", || 1);
                    self.plan_web(frame, out);
                }
                None => return Ok(()),
            }
        }
        Ok(())
    }

    fn draw_web_pass(&mut self, frame: Frame<'_>, out: &mut Vec<u8>) -> io::Result<Option<u64>> {
        let Some(mut web) = self.patches.web.take() else { return Ok(None) };
        let mut see_through_in = None;
        let scrollers: Vec<(u32, Rect)> = web.nodes.iter().filter(|(id, _)| **id != SCREEN).filter_map(|(_, n)| n.plan.map(|p| (n.depth, p.area))).collect();
        let mut order = Vec::new();
        for (id, node) in web.nodes.iter_mut() {
            let Some(plan) = node.plan else { continue };
            let holes: Vec<Rect> = if *id == SCREEN {
                scrollers.iter().flat_map(|(_, a)| web.pinned.iter().fold(vec![*a], |parts, p| parts.iter().flat_map(|part| subtract(&[*part], *p)).collect())).collect()
            } else {
                let above = scrollers.iter().filter(|(d, _)| *d > node.depth).map(|(_, a)| *a);
                above.chain(web.pinned.iter().copied()).map(|a| intersect(a, plan.area)).filter(|a| !a.is_empty()).collect()
            };
            let origin = match (plan.origin, node.origin) {
                (Some(target), _) => target,
                (None, Some(last)) => last,
                (None, None) => i64::from(plan.area.y),
            };
            order.push((!node.layer.jumping(origin), node.depth, *id, origin, plan.area, holes));
        }
        order.sort_unstable_by_key(|(steady, depth, id, ..)| (*steady, *depth, *id));
        let mut held = false;
        let mut staged = Vec::new();
        if order.iter().filter(|(steady, ..)| !steady).count() > 1 {
            for (_, _, id, origin, area, holes) in order.iter().filter(|(steady, ..)| !steady) {
                let node = web.nodes.get_mut(id).expect("listed above");
                let layer = ScrollLayer { area: *area, origin_y: *origin, under: Vec::new(), overlays: Vec::new() };
                let report = self.draw_node(frame, &layer, &mut node.layer, holes, false, out);
                node.origin = Some(*origin);
                staged.push(*id);
                match report {
                    Ok(report) => {
                        held |= report.waiting;
                        see_through_in = see_through_in.or(report.see_through.then_some(*id));
                    }
                    Err(error) => {
                        self.patches.web = Some(web);
                        return Err(error);
                    }
                }
            }
        }
        if see_through_in.is_some() {
            self.patches.web = Some(web);
            return Ok(see_through_in);
        }
        let mut result = Ok(());
        for (_, _, id, origin, area, holes) in order {
            let node = web.nodes.get_mut(&id).expect("listed above");
            if held {
                if !staged.contains(&id) {
                    node.layer.forget_compared();
                }
                continue;
            }
            let layer = ScrollLayer { area, origin_y: origin, under: Vec::new(), overlays: Vec::new() };
            match self.draw_node(frame, &layer, &mut node.layer, &holes, true, out) {
                Ok(report) => {
                    node.origin = Some(origin);
                    held = report.waiting;
                    if report.see_through {
                        see_through_in = Some(id);
                        break;
                    }
                }
                Err(error) => {
                    result = Err(error);
                    break;
                }
            }
        }
        if see_through_in.is_some() {
            self.patches.web = Some(web);
            return result.map(|()| see_through_in);
        }
        if held {
            pixel_core::profiler::count("present.web_held", || 1);
        }
        if !held {
            for (_, layer) in web.retired.drain(..) {
                layer.delete_all(out, &mut self.patches.ids);
            }
        }
        self.patches.web = Some(web);
        result.map(|()| None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pixel_core::surfaces::SurfaceLayout;
    use pixel_raster::Canvas;
    use std::sync::Arc;

    const SURFACE: Rect = Rect { x: 0, y: 0, w: 320, h: 300 };
    const CHILD: Rect = Rect { x: 40, y: 60, w: 240, h: 180 };

    fn translate(x: f32, y: f32) -> [f32; 16] {
        let mut m = [0.0; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        m[12] = x;
        m[13] = y;
        m
    }

    fn node(element_id: u64, id: i32, parent_id: i32, rect: Rect, offset: f32, outer: bool) -> ScrollNode {
        ScrollNode {
            element_id,
            id,
            parent_id,
            transform_id: id,
            container_scroll_node_id: parent_id,
            container_origin: (rect.x as i32, rect.y as i32),
            container_bounds: (rect.w, rect.h),
            bounds: (rect.w, 4000),
            scroll_offset: (0.0, offset),
            user_scrollable_horizontal: false,
            user_scrollable_vertical: true,
            is_composited: true,
            scrolls_inner_viewport: false,
            scrolls_outer_viewport: outer,
            to_screen: translate(rect.x as f32, rect.y as f32 - offset),
            container_to_screen: translate(0.0, 0.0),
        }
    }

    fn page(scroll: u32) -> Canvas {
        let mut canvas = Canvas::new(SURFACE.w, SURFACE.h);
        for y in 0..SURFACE.h {
            for x in 0..SURFACE.w {
                let inside = x >= CHILD.x && x < CHILD.x + CHILD.w && y >= CHILD.y && y < CHILD.y + CHILD.h;
                let px = if inside { let row = y - CHILD.y + scroll; [row as u8, (row >> 8) as u8, (x % 7) as u8 * 30, 255] } else { [200, (y % 5) as u8 * 40, (x % 3) as u8 * 80, 255] };
                let at = ((y * SURFACE.w + x) * 4) as usize;
                canvas.pixels[at..at + 4].copy_from_slice(&px);
            }
        }
        canvas
    }

    fn draw(kitty: &mut Kitty, scroll: u32) -> Canvas {
        draw_as(kitty, scroll, scroll)
    }

    fn draw_as(kitty: &mut Kitty, scroll: u32, painted: u32) -> Canvas {
        let canvas = page(painted);
        let tree = Arc::new(ScrollTree { nodes: vec![node(5, 2, 1, SURFACE, 0.0, true), node(7, 3, 2, CHILD, scroll as f32, false)], drawn_layers: Vec::new() });
        let layout = SurfaceLayout { placements: vec![SurfacePlacement { surface: 1, rect: [0.0, 0.0, 320.0, 300.0], visible: [0.0, 0.0, 320.0, 300.0], size: (320, 300), scroll_tree: Some(tree) }], covers: Vec::new() };
        let frame = Frame { canvas: &canvas, premultiplied: false, changed: &[], repainted: &[], opaque: &[], ui_over_surfaces: &[], layer: None, surfaces: Some(&layout) };
        let mut out = Vec::new();
        if kitty.plan_web(frame, &mut out).is_some() {
            kitty.draw_web(frame, &mut out).unwrap();
        }
        canvas
    }

    #[test]
    fn a_scrolling_child_gets_its_own_layer_placed_by_the_compositor() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        draw(&mut kitty, 0);
        assert!(kitty.patches.web.as_ref().is_some_and(|w| w.nodes.len() == 1 && w.nodes.contains_key(&5)), "only the page scroller is layered before anything scrolls");
        for scroll in [30, 75, 140] {
            let canvas = draw(&mut kitty, scroll);
            let web = kitty.patches.web.as_ref().unwrap();
            let child = &web.nodes[&7];
            assert_eq!(child.depth, 2);
            assert_eq!(child.origin, Some(i64::from(CHILD.y) - i64::from(scroll)));
            assert_eq!(child.layer.upload_cost(&canvas, child.origin.unwrap(), &[]), 0, "every child row is already in the terminal at scroll {scroll}");
            assert_eq!(web.nodes[&5].layer.upload_cost(&canvas, 0, &[CHILD]), 0, "the page around the child is already in the terminal");
        }
    }

    #[test]
    fn a_layer_follows_the_compositor_even_when_its_pixels_lag_behind() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        draw(&mut kitty, 0);
        draw(&mut kitty, 30);
        let before = kitty.patches.web.as_ref().unwrap().nodes[&7].origin.unwrap();
        draw_as(&mut kitty, 90, 30);
        let canvas = draw(&mut kitty, 120);
        let child = &kitty.patches.web.as_ref().unwrap().nodes[&7];
        assert_eq!(child.origin, Some(before - 90));
        assert_eq!(child.layer.upload_cost(&canvas, child.origin.unwrap(), &[]), 0);
    }

    fn draw_canvas(kitty: &mut Kitty, canvas: &Canvas, scroll: u32) {
        let tree = Arc::new(ScrollTree { nodes: vec![node(5, 2, 1, SURFACE, 0.0, true), node(7, 3, 2, CHILD, scroll as f32, false)], drawn_layers: Vec::new() });
        let layout = SurfaceLayout { placements: vec![SurfacePlacement { surface: 1, rect: [0.0, 0.0, 320.0, 300.0], visible: [0.0, 0.0, 320.0, 300.0], size: (320, 300), scroll_tree: Some(tree) }], covers: Vec::new() };
        let frame = Frame { canvas, premultiplied: false, changed: &[CHILD], repainted: &[], opaque: &[], ui_over_surfaces: &[], layer: None, surfaces: Some(&layout) };
        let mut out = Vec::new();
        if kitty.plan_web(frame, &mut out).is_some() {
            kitty.draw_web(frame, &mut out).unwrap();
        }
    }

    #[test]
    fn a_see_through_pixel_inside_the_page_puts_it_all_on_the_screen_layer() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        draw(&mut kitty, 0);
        draw(&mut kitty, 30);
        assert!(kitty.patches.web.as_ref().unwrap().nodes.contains_key(&7));
        let mut canvas = page(60);
        canvas.pixels[(((CHILD.y + 50) * SURFACE.w + CHILD.x + 3) * 4 + 3) as usize] = 0;
        draw_canvas(&mut kitty, &canvas, 60);
        let web = kitty.patches.web.as_ref().unwrap();
        assert!(!web.nodes.contains_key(&7), "a see-through pixel over the page would blend with stale strips");
        assert!(!web.nodes.contains_key(&5), "and the page would show it over whatever its own hole held");
        assert_eq!(web.see_through[&7], (CHILD, None));
        assert_eq!(web.nodes[&SCREEN].layer.upload_cost(&canvas, 0, &[]), 0, "the screen layer has nothing beneath it");
        let canvas = page(90);
        draw_canvas(&mut kitty, &canvas, 90);
        let web = kitty.patches.web.as_ref().unwrap();
        assert!(web.nodes.contains_key(&5), "the page scrolls on its own layer again once it is opaque");
        assert_eq!(web.see_through[&5], (SURFACE, Some(SURFACE)));
        assert_eq!(web.nodes[&5].layer.upload_cost(&canvas, 0, &[CHILD]), 0);
    }

    #[test]
    fn see_through_rows_at_the_page_edge_go_to_the_screen_layer() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        let mut canvas = page(0);
        for x in [0, 1, SURFACE.w - 2, SURFACE.w - 1] {
            canvas.pixels[((SURFACE.h - 1) * SURFACE.w + x) as usize * 4 + 3] = 0;
        }
        draw_canvas(&mut kitty, &canvas, 0);
        let web = kitty.patches.web.as_ref().unwrap();
        let rows = Rect { h: SURFACE.h - 1, ..SURFACE };
        assert_eq!(web.nodes[&5].layer.area, rows, "rounded window corners stay off the scrolling page layer");
        assert_eq!(web.nodes[&SCREEN].layer.upload_cost(&canvas, 0, &[rows]), 0, "the screen layer draws them, with nothing beneath");
        draw_canvas(&mut kitty, &canvas, 0);
        assert_eq!(kitty.patches.web.as_ref().unwrap().see_through[&5], (SURFACE, Some(rows)));
    }

    fn layer(rect: (i32, i32, u32, u32), scroll_node_id: i32) -> pixel_core::surfaces::DrawnLayer {
        pixel_core::surfaces::DrawnLayer { layer_id: 0, rect, scroll_node_id, contents_opaque: true, translation: None }
    }

    #[test]
    fn the_page_scroller_owns_only_what_moves_with_it() {
        let root = node(5, 2, 1, SURFACE, 0.0, true);
        let tree = ScrollTree {
            nodes: vec![root],
            drawn_layers: vec![layer((0, -400, 320, 4000), 2), layer((0, 0, 64, 300), -1), layer((0, 0, 320, 48), -1)],
        };
        let layered = HashSet::new();
        let owners = Owners::new(&tree, &layered);
        assert_eq!(owned_region(&tree, &owners, SURFACE, 5), Some(Rect { x: 64, y: 48, w: 256, h: 252 }), "a fixed sidebar and header stay out of the moving region");
        assert_eq!(owned_region(&tree, &owners, SURFACE, 9), None);
    }

    #[test]
    fn an_unlayered_scroller_moves_with_its_container() {
        let root = node(5, 2, 1, SURFACE, 0.0, true);
        let panel = node(7, 3, 2, Rect { x: 100, y: 0, w: 160, h: 300 }, 0.0, false);
        let tree = ScrollTree { nodes: vec![root, panel], drawn_layers: vec![layer((0, 0, 320, 300), 2), layer((100, 0, 160, 300), 3), layer((0, 0, 320, 16), -1)] };
        let layered = HashSet::new();
        let owners = Owners::new(&tree, &layered);
        assert_eq!(owned_region(&tree, &owners, SURFACE, 5), Some(Rect { x: 0, y: 16, w: 320, h: 284 }), "an unlayered scroller in the page's flow moves with the page");
        let mut fixed_tree = tree.clone();
        fixed_tree.nodes[1].container_scroll_node_id = -1;
        let owners = Owners::new(&fixed_tree, &layered);
        assert_eq!(pinned_on_top(&fixed_tree, &owners, SURFACE), vec![Rect { x: 100, y: 0, w: 160, h: 300 }, Rect { x: 0, y: 0, w: 320, h: 16 }], "an unlayered scroller in a fixed box stays with the screen");
    }

    fn page_with_header(scroll: u32) -> Canvas {
        let mut canvas = Canvas::new(SURFACE.w, SURFACE.h);
        for y in 0..SURFACE.h {
            for x in 0..SURFACE.w {
                let px = if y < 48 { [9, 9, (x % 5) as u8 * 50, 255] } else { let row = y + scroll; [row as u8, (row >> 8) as u8, (x % 7) as u8 * 30, 255] };
                let at = ((y * SURFACE.w + x) * 4) as usize;
                canvas.pixels[at..at + 4].copy_from_slice(&px);
            }
        }
        canvas
    }

    #[test]
    fn a_fixed_header_stays_on_the_screen_layer_while_the_page_moves_under_it() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        for scroll in [0u32, 40, 100] {
            let canvas = page_with_header(scroll);
            let mut root = node(5, 2, 1, SURFACE, scroll as f32, true);
            root.to_screen = translate(0.0, -(scroll as f32));
            let tree = Arc::new(ScrollTree { nodes: vec![root], drawn_layers: vec![layer((0, 0, 320, 300), 2), layer((0, 0, 320, 48), -1)] });
            let layout = SurfaceLayout { placements: vec![SurfacePlacement { surface: 1, rect: [0.0, 0.0, 320.0, 300.0], visible: [0.0, 0.0, 320.0, 300.0], size: (320, 300), scroll_tree: Some(tree) }], covers: Vec::new() };
            let frame = Frame { canvas: &canvas, premultiplied: false, changed: &[], repainted: &[], opaque: &[], ui_over_surfaces: &[], layer: None, surfaces: Some(&layout) };
            let mut out = Vec::new();
            assert!(kitty.plan_web(frame, &mut out).is_some());
            kitty.draw_web(frame, &mut out).unwrap();
            let web = kitty.patches.web.as_ref().unwrap();
            let page = &web.nodes[&5];
            assert_eq!(page.layer.area, Rect { x: 0, y: 48, w: 320, h: 252 });
            assert_eq!(page.origin, Some(-i64::from(scroll)), "the page's stripes follow the compositor");
            let screen = &web.nodes[&SCREEN];
            assert_eq!(screen.origin, Some(0), "the header's layer never moves");
            assert_eq!(page.layer.upload_cost(&canvas, -i64::from(scroll), &[]), 0, "page at {scroll} held {}", page.layer.holding());
            assert_eq!(screen.layer.upload_cost(&canvas, 0, &[page.layer.area]), 0);
        }
    }

    const SIDEBAR: Rect = Rect { x: 120, y: 60, w: 80, h: 140 };

    fn page_with_sidebar(scroll: u32) -> Canvas {
        let mut canvas = page_with_header(scroll);
        for y in 0..SURFACE.h {
            for x in 0..SURFACE.w {
                let pinned = x >= SIDEBAR.x && x < SIDEBAR.x + SIDEBAR.w && y >= SIDEBAR.y && y < SIDEBAR.y + SIDEBAR.h;
                let page = [(y + scroll) as u8, ((y + scroll) >> 8) as u8, (x % 7) as u8 * 30, 255];
                let px = if pinned { [7, (y % 3) as u8 * 60, (x % 4) as u8 * 50, 255] } else { page };
                let at = ((y * SURFACE.w + x) * 4) as usize;
                canvas.pixels[at..at + 4].copy_from_slice(&px);
            }
        }
        canvas
    }

    #[test]
    fn a_stuck_sidebar_inside_the_page_sits_on_the_screen_layer_above_it() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        for scroll in [0u32, 40, 100] {
            let canvas = page_with_sidebar(scroll);
            let mut root = node(5, 2, 1, SURFACE, scroll as f32, true);
            root.to_screen = translate(0.0, -(scroll as f32));
            let sidebar = (SIDEBAR.x as i32, SIDEBAR.y as i32, SIDEBAR.w, SIDEBAR.h);
            let tree = Arc::new(ScrollTree { nodes: vec![root], drawn_layers: vec![layer((0, 0, 320, 300), 2), layer(sidebar, -1)] });
            let layout = SurfaceLayout { placements: vec![SurfacePlacement { surface: 1, rect: [0.0, 0.0, 320.0, 300.0], visible: [0.0, 0.0, 320.0, 300.0], size: (320, 300), scroll_tree: Some(tree) }], covers: Vec::new() };
            let frame = Frame { canvas: &canvas, premultiplied: false, changed: &[], repainted: &[], opaque: &[], ui_over_surfaces: &[], layer: None, surfaces: Some(&layout) };
            let mut out = Vec::new();
            assert!(kitty.plan_web(frame, &mut out).is_some());
            kitty.draw_web(frame, &mut out).unwrap();
            let web = kitty.patches.web.as_ref().unwrap();
            assert_eq!(web.pinned, vec![SIDEBAR]);
            let page = &web.nodes[&5];
            let screen = &web.nodes[&SCREEN];
            assert_eq!(page.layer.area, SURFACE, "the page owns the whole surface around the sidebar");
            assert_eq!(page.origin, Some(-i64::from(scroll)));
            assert!(screen.depth > page.depth, "the sidebar is drawn above the page");
            assert_eq!(screen.origin, Some(0));
            assert_eq!(page.layer.upload_cost(&canvas, -i64::from(scroll), &[SIDEBAR]), 0, "the page has nothing left to send around the sidebar at {scroll}");
            let outside_sidebar = subtract(&[SURFACE], SIDEBAR);
            assert_eq!(screen.layer.upload_cost(&canvas, 0, &outside_sidebar), 0);
        }
    }

    fn draw_pinned(kitty: &mut Kitty, canvas: &Canvas, scroll: u32, pinned: (i32, i32, u32, u32), probe: bool) -> Option<u64> {
        let mut root = node(5, 2, 1, SURFACE, scroll as f32, true);
        root.to_screen = translate(0.0, -(scroll as f32));
        let tree = Arc::new(ScrollTree { nodes: vec![root], drawn_layers: vec![layer((0, 0, 320, 300), 2), layer(pinned, -1)] });
        let layout = SurfaceLayout { placements: vec![SurfacePlacement { surface: 1, rect: [0.0, 0.0, 320.0, 300.0], visible: [0.0, 0.0, 320.0, 300.0], size: (320, 300), scroll_tree: Some(tree) }], covers: Vec::new() };
        let frame = Frame { canvas, premultiplied: false, changed: &[SURFACE], repainted: &[], opaque: &[], ui_over_surfaces: &[], layer: None, surfaces: Some(&layout) };
        let mut out = Vec::new();
        kitty.plan_web(frame, &mut out)?;
        let first = if probe { kitty.draw_web_pass(frame, &mut out).unwrap() } else { None };
        kitty.draw_web(frame, &mut out).unwrap();
        first
    }

    #[test]
    fn a_see_through_corner_under_a_fixed_header_lies_over_nothing() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        for scroll in [0u32, 40] {
            let mut canvas = page_with_header(scroll);
            canvas.pixels[3] = 0;
            assert_eq!(draw_pinned(&mut kitty, &canvas, scroll, (0, 0, 320, 48), true), None);
        }
        assert!(!kitty.patches.web.as_ref().unwrap().clears_all_holes);
    }

    #[test]
    fn a_see_through_pixel_on_a_stuck_sidebar_makes_every_layer_clear_its_holes_once() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        let sidebar = (SIDEBAR.x as i32, SIDEBAR.y as i32, SIDEBAR.w, SIDEBAR.h);
        assert_eq!(draw_pinned(&mut kitty, &page_with_sidebar(0), 0, sidebar, true), None);
        let see_through = |scroll| {
            let mut canvas = page_with_sidebar(scroll);
            canvas.pixels[(((SIDEBAR.y + 10) * SURFACE.w + SIDEBAR.x + 10) * 4 + 3) as usize] = 90;
            canvas
        };
        assert!(!kitty.patches.web.as_ref().unwrap().clears_all_holes);
        draw_pinned(&mut kitty, &see_through(40), 40, sidebar, false);
        assert!(kitty.patches.web.as_ref().unwrap().clears_all_holes);
        let canvas = see_through(100);
        assert_eq!(draw_pinned(&mut kitty, &canvas, 100, sidebar, true), None, "it never trips again");
        let web = kitty.patches.web.as_ref().unwrap();
        assert_eq!(web.nodes[&5].layer.upload_cost(&canvas, -100, &[SIDEBAR]), 0);
        assert_eq!(web.nodes[&SCREEN].layer.upload_cost(&canvas, 0, &subtract(&[SURFACE], SIDEBAR)), 0);
    }

    const EDITOR: Rect = Rect { x: 60, y: 40, w: 240, h: 240 };

    fn page_with_editor(scroll: u32) -> Canvas {
        let mut canvas = Canvas::new(SURFACE.w, SURFACE.h);
        for y in 0..SURFACE.h {
            for x in 0..SURFACE.w {
                let inside = x >= EDITOR.x && x < EDITOR.x + EDITOR.w && y >= EDITOR.y && y < EDITOR.y + EDITOR.h;
                let line = (y + scroll).saturating_sub(EDITOR.y);
                let px = if inside { [line as u8, (line >> 8) as u8, (x % 9) as u8 * 25, 255] } else { [30, (y % 4) as u8 * 50, (x % 6) as u8 * 40, 255] };
                let at = ((y * SURFACE.w + x) * 4) as usize;
                canvas.pixels[at..at + 4].copy_from_slice(&px);
            }
        }
        canvas
    }

    #[test]
    fn a_layer_moved_by_its_transform_moves_like_a_scroller() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        let key = moved_key(36);
        for scroll in [0u32, 20, 50, 90] {
            let canvas = page_with_editor(scroll);
            let root = node(5, 2, 1, SURFACE, 0.0, true);
            let editor = pixel_core::surfaces::DrawnLayer {
                layer_id: 36,
                rect: (EDITOR.x as i32, EDITOR.y as i32, EDITOR.w, EDITOR.h),
                scroll_node_id: 2,
                contents_opaque: true,
                translation: Some((EDITOR.x as i32, EDITOR.y as i32 - scroll as i32)),
            };
            let tree = Arc::new(ScrollTree { nodes: vec![root], drawn_layers: vec![layer((0, 0, 320, 300), 2), editor] });
            let layout = SurfaceLayout { placements: vec![SurfacePlacement { surface: 1, rect: [0.0, 0.0, 320.0, 300.0], visible: [0.0, 0.0, 320.0, 300.0], size: (320, 300), scroll_tree: Some(tree) }], covers: Vec::new() };
            let frame = Frame { canvas: &canvas, premultiplied: false, changed: &[], repainted: &[], opaque: &[], ui_over_surfaces: &[], layer: None, surfaces: Some(&layout) };
            let mut out = Vec::new();
            assert!(kitty.plan_web(frame, &mut out).is_some());
            kitty.draw_web(frame, &mut out).unwrap();
            let web = kitty.patches.web.as_ref().unwrap();
            if scroll == 0 {
                assert!(!web.nodes.contains_key(&key), "a layer that has not moved stays part of the page");
                continue;
            }
            let moved = &web.nodes[&key];
            assert_eq!(moved.layer.area, EDITOR);
            assert_eq!(moved.origin, Some(i64::from(EDITOR.y) - i64::from(scroll)), "the region follows the layer's translation");
            assert_eq!(moved.layer.upload_cost(&canvas, moved.origin.unwrap(), &[]), 0);
            assert_eq!(web.nodes[&5].origin, Some(0), "the page itself does not move");
            assert_eq!(web.nodes[&5].layer.upload_cost(&canvas, 0, &[EDITOR]), 0);
        }
    }

    #[test]
    fn a_layer_that_only_rides_its_scroller_is_not_moved_on_its_own() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        for scroll in [0u32, 30, 70] {
            let canvas = page_with_header(scroll);
            let mut root = node(5, 2, 1, SURFACE, scroll as f32, true);
            root.to_screen = translate(0.0, -(scroll as f32) - 0.4);
            let block = pixel_core::surfaces::DrawnLayer {
                layer_id: 40,
                rect: (0, 100, 320, 150),
                scroll_node_id: 2,
                contents_opaque: true,
                translation: Some((0, 400 - scroll as i32)),
            };
            let tree = Arc::new(ScrollTree { nodes: vec![root], drawn_layers: vec![layer((0, 0, 320, 300), 2), block] });
            let layout = SurfaceLayout { placements: vec![SurfacePlacement { surface: 1, rect: [0.0, 0.0, 320.0, 300.0], visible: [0.0, 0.0, 320.0, 300.0], size: (320, 300), scroll_tree: Some(tree) }], covers: Vec::new() };
            let frame = Frame { canvas: &canvas, premultiplied: false, changed: &[], repainted: &[], opaque: &[], ui_over_surfaces: &[], layer: None, surfaces: Some(&layout) };
            let mut out = Vec::new();
            assert!(kitty.plan_web(frame, &mut out).is_some());
            kitty.draw_web(frame, &mut out).unwrap();
            let web = kitty.patches.web.as_ref().unwrap();
            assert!(!web.nodes.contains_key(&moved_key(40)), "the page layer already moves it at {scroll}");
        }
    }

    #[test]
    fn a_composited_scroller_that_draws_nothing_gets_no_layer() {
        let mut kitty = Kitty::blank(crate::Output::new(Box::new(io::sink()), None), crate::wrapper::Wrapper::None, None);
        for scroll in [0u32, 30, 60] {
            let canvas = page(0);
            let mut empty = node(7, 3, 2, CHILD, scroll as f32, false);
            empty.is_composited = true;
            let tree = Arc::new(ScrollTree { nodes: vec![node(5, 2, 1, SURFACE, 0.0, true), empty], drawn_layers: vec![layer((0, 0, 320, 300), 2)] });
            let layout = SurfaceLayout { placements: vec![SurfacePlacement { surface: 1, rect: [0.0, 0.0, 320.0, 300.0], visible: [0.0, 0.0, 320.0, 300.0], size: (320, 300), scroll_tree: Some(tree) }], covers: Vec::new() };
            let frame = Frame { canvas: &canvas, premultiplied: false, changed: &[], repainted: &[], opaque: &[], ui_over_surfaces: &[], layer: None, surfaces: Some(&layout) };
            let mut out = Vec::new();
            assert!(kitty.plan_web(frame, &mut out).is_some());
            kitty.draw_web(frame, &mut out).unwrap();
            assert!(!kitty.patches.web.as_ref().unwrap().nodes.contains_key(&7), "nothing it draws moves with it at {scroll}");
        }
    }
}

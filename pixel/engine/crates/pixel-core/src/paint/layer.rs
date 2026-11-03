use std::collections::HashSet;

use crate::canvas::{Canvas, Overlay, ScrollLayer};
use crate::style::{Color, Layout, Overflow, Paint, Position};
use crate::surfaces::Rect;
use crate::tree::{NodeId, PxRect, Tree};

const MIN_HEIGHT: f32 = 64.0;

pub struct LayerPlan {
    pub list: NodeId,
    pub area: Rect,
    pub origin_y: i64,
    drawn: Vec<Drawn>,
    skip: HashSet<NodeId>,
}

struct Drawn {
    id: NodeId,
    clip: Option<PxRect>,
    rects: Vec<Rect>,
    inside_list: bool,
}

pub struct LayerCanvases {
    content: Canvas,
    overlays: Canvas,
}

impl LayerCanvases {
    pub fn new(width: u32, height: u32) -> Self {
        Self { content: Canvas::new(width, height), overlays: Canvas::new(width, height) }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.content.width, self.content.height)
    }
}

impl LayerPlan {
    pub fn overlay_rects(&self) -> Vec<Rect> {
        merge(self.drawn.iter().flat_map(|d| d.rects.iter().copied()).collect())
    }
}

pub fn scroll_layer(tree: &Tree) -> Option<LayerPlan> {
    let size = |id: NodeId| tree.get(id).map_or(0.0, |n| n.visible.w * n.visible.h);
    let list = tree
        .scroll_nodes()
        .into_iter()
        .filter(|&id| tree.get(id).is_some_and(|n| n.style.layout == Layout::List && !n.hidden && !n.offscreen))
        .max_by(|&a, &b| size(a).total_cmp(&size(b)))?;
    let node = tree.get(list)?;
    if node.visible.h < MIN_HEIGHT || node.visible.w <= 0.0 {
        return None;
    }
    let area = inner_pixels(node.visible)?;
    let mut plan = LayerPlan {
        list,
        area,
        origin_y: (node.abs.y - node.scroll.shown()).round() as i64 + node.scroll.anchored,
        drawn: Vec::new(),
        skip: HashSet::new(),
    };
    let mut after = false;
    collect(tree, tree.root(), None, &mut after, &mut plan);
    Some(plan)
}

fn collect(tree: &Tree, id: NodeId, clip: Option<PxRect>, after: &mut bool, plan: &mut LayerPlan) {
    let Some(node) = tree.get(id) else { return };
    if node.hidden {
        return;
    }
    if *after {
        let mut rects = Vec::new();
        subtree_rects(tree, id, clip, &mut rects);
        let rects: Vec<Rect> = rects.into_iter().filter_map(|r| outer_pixels(r, plan.area)).collect();
        if !rects.is_empty() {
            plan.skip.insert(id);
            plan.drawn.push(Drawn { id, clip, rects, inside_list: false });
        }
        return;
    }
    let child_clip = if node.style.overflow != Overflow::Visible { Some(clip.map_or(node.abs, |c| c.intersect(node.abs))) } else { clip };
    if id == plan.list {
        stuck(tree, id, child_clip, plan);
        *after = true;
        return;
    }
    for child in tree.paint_children(id) {
        if shown(tree, child) {
            collect(tree, child, child_clip, after, plan);
        }
    }
}

fn shown(tree: &Tree, id: NodeId) -> bool {
    tree.get(id).is_some_and(|n| !n.offscreen && (n.slot.is_none() || n.slot_visible) && (n.mark.is_none() || n.mark_visible))
}

fn stuck(tree: &Tree, id: NodeId, clip: Option<PxRect>, plan: &mut LayerPlan) {
    for child in tree.paint_children(id) {
        let Some(node) = tree.get(child) else { continue };
        if node.hidden || node.offscreen {
            continue;
        }
        if node.style.position == Position::Sticky && node.stuck {
            let mut rects = Vec::new();
            subtree_rects(tree, child, clip, &mut rects);
            let rects: Vec<Rect> = rects.into_iter().filter_map(|r| outer_pixels(r, plan.area)).collect();
            if !rects.is_empty() {
                plan.skip.insert(child);
                plan.drawn.push(Drawn { id: child, clip, rects, inside_list: true });
            }
        } else {
            stuck(tree, child, clip, plan);
        }
    }
}

fn subtree_rects(tree: &Tree, id: NodeId, clip: Option<PxRect>, out: &mut Vec<PxRect>) {
    let Some(node) = tree.get(id) else { return };
    if node.hidden {
        return;
    }
    out.extend(painted(tree, id, clip));
    let child_clip = if node.style.overflow != Overflow::Visible { Some(clip.map_or(node.abs, |c| c.intersect(node.abs))) } else { clip };
    for child in tree.paint_children(id) {
        if shown(tree, child) {
            subtree_rects(tree, child, child_clip, out);
        }
    }
}

fn painted(tree: &Tree, id: NodeId, clip: Option<PxRect>) -> Vec<PxRect> {
    let Some(node) = tree.get(id) else { return Vec::new() };
    let rect = node.abs;
    let background = match &node.style.background {
        Some(Paint::Solid(color)) => color[3] > 0,
        Some(Paint::Gradient(_)) => true,
        None => false,
    };
    let content = background
        || node.style.hover_background.is_some()
        || node.surface.is_some()
        || node.text.is_some()
        || !node.spans.is_empty()
        || node.image.is_some()
        || node.shape.is_some()
        || node.input.is_some();
    let mut rects = Vec::new();
    if content || node.style.border.is_some() {
        rects.push(rect);
    }
    if let Some(bar) = tree.scrollbar_rects(id).filter(|_| tree.bar_opacity(id) > 0.0) {
        rects.push(bar.zone);
    }
    match clip {
        Some(clip) => rects.into_iter().map(|r| r.intersect(clip)).filter(|r| r.w > 0.0 && r.h > 0.0).collect(),
        None => rects,
    }
}

pub fn render_layer(
    tree: &Tree,
    plan: &LayerPlan,
    canvases: &mut LayerCanvases,
    fonts: &[crate::fonts::Font],
    cursor: Option<(f32, f32)>,
    clear: Color,
) -> ScrollLayer {
    let area = plan.area;
    let bar = tree.scrollbar_rects(plan.list).filter(|_| tree.bar_opacity(plan.list) > 0.0);
    let expanded = tree.get(plan.list).is_some_and(|n| n.bar.expand > 0.0);
    let mut rects = plan.overlay_rects();
    let thumb = bar.and_then(|b| {
        let x = b.thumb.x.floor();
        let y = b.thumb.y.round();
        let rect = Rect {
            x: x.max(0.0) as u32,
            y: y.max(0.0) as u32,
            w: ((b.thumb.x + b.thumb.w).ceil() - x).max(0.0) as u32,
            h: b.thumb.h.ceil().max(0.0) as u32,
        };
        let inside = rect.x >= area.x && rect.y >= area.y && rect.x + rect.w <= area.x + area.w && rect.y + rect.h <= area.y + area.h;
        (!expanded && inside && !rect.is_empty() && !rects.iter().any(|r| r.intersects(rect))).then_some((rect, (x, b.thumb.y)))
    });
    let bar_in_overlays = bar.is_some() && thumb.is_none();
    if bar_in_overlays && let Some(zone) = bar.and_then(|b| outer_pixels(b.zone, area)) {
        rects.push(zone);
        rects = merge(rects);
    }
    let skip = crate::paint::Skip { nodes: &plan.skip, bar_of: plan.list };
    let mut under = Vec::new();
    for rect in rects.iter().copied().chain(thumb.map(|(r, _)| r)) {
        let content = &mut canvases.content;
        content.push_clip(rect.x as f32, rect.y as f32, rect.w as f32, rect.h as f32);
        crate::paint::paint_skipping(tree, content, fonts, cursor, Some((rect, clear)), Some(&skip));
        content.pop_clip();
        under.push(content.raw_copy(rect));
    }
    let mut overlays = Vec::new();
    for rect in &rects {
        let canvas = &mut canvases.overlays;
        canvas.fill_rect(rect.x, rect.y, rect.w, rect.h, [0; 4]);
        canvas.push_clip(rect.x as f32, rect.y as f32, rect.w as f32, rect.h as f32);
        let (inside, after): (Vec<&Drawn>, Vec<&Drawn>) = plan.drawn.iter().partition(|d| d.inside_list);
        for drawn in inside {
            paint_drawn(tree, drawn, canvas, fonts, cursor);
        }
        if bar_in_overlays {
            crate::paint::paint_scrollbar(tree, plan.list, canvas);
        }
        for drawn in after {
            paint_drawn(tree, drawn, canvas, fonts, cursor);
        }
        canvas.pop_clip();
        overlays.push(Overlay { pixels: canvas.straight_copy(*rect), above: false });
    }
    if let Some((rect, (x, y))) = thumb {
        let mut canvas = Canvas::new(rect.w, rect.h);
        crate::paint::paint_thumb(tree, plan.list, &mut canvas, (-x, -y));
        let mut pixels = canvas.straight_copy(Rect::sized(rect.w, rect.h));
        pixels.rect = rect;
        overlays.push(Overlay { pixels, above: true });
    }
    ScrollLayer { area, origin_y: plan.origin_y, under, overlays }
}

fn paint_drawn(tree: &Tree, drawn: &Drawn, canvas: &mut Canvas, fonts: &[crate::fonts::Font], cursor: Option<(f32, f32)>) {
    if let Some(clip) = drawn.clip {
        canvas.push_clip(clip.x, clip.y, clip.w, clip.h);
    }
    crate::paint::paint_subtree(tree, drawn.id, canvas, fonts, cursor);
    if drawn.clip.is_some() {
        canvas.pop_clip();
    }
}

fn merge(mut rects: Vec<Rect>) -> Vec<Rect> {
    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                if touches(rects[i], rects[j]) {
                    let (a, b) = (rects[i], rects[j]);
                    let x = a.x.min(b.x);
                    let y = a.y.min(b.y);
                    let right = (a.x + a.w).max(b.x + b.w);
                    let bottom = (a.y + a.h).max(b.y + b.h);
                    rects[i] = Rect { x, y, w: right - x, h: bottom - y };
                    rects.swap_remove(j);
                    merged = true;
                    break 'outer;
                }
            }
        }
    }
    rects.sort_by_key(|r| (r.y, r.x));
    rects
}

fn touches(a: Rect, b: Rect) -> bool {
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

fn inner_pixels(r: PxRect) -> Option<Rect> {
    let (x, y) = (r.x.ceil().max(0.0), r.y.ceil().max(0.0));
    let (right, bottom) = ((r.x + r.w).floor(), (r.y + r.h).floor());
    (right > x && bottom > y).then(|| Rect { x: x as u32, y: y as u32, w: (right - x) as u32, h: (bottom - y) as u32 })
}

fn outer_pixels(r: PxRect, area: Rect) -> Option<Rect> {
    let x = r.x.floor().max(area.x as f32);
    let y = r.y.floor().max(area.y as f32);
    let right = (r.x + r.w).ceil().min((area.x + area.w) as f32);
    let bottom = (r.y + r.h).ceil().min((area.y + area.h) as f32);
    (right > x && bottom > y).then(|| Rect { x: x as u32, y: y as u32, w: (right - x) as u32, h: (bottom - y) as u32 })
}

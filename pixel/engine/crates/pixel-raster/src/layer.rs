use std::collections::HashSet;

use pixel_core::fonts::Font;
use pixel_core::scene::{Item, LayerKind, Op, Scroll};
use pixel_core::surfaces::Rect;
use pixel_core::{Color, PxRect};

use crate::canvas::{Canvas, Overlay, ScrollLayer};
use crate::draw::{Skip, paint_scene, paint_subtree};

const MIN_HEIGHT: f32 = 64.0;

pub struct LayerPlan<'a> {
    list: &'a Item,
    scroll: Scroll,
    pub area: Rect,
    pub origin_y: i64,
    drawn: Vec<Drawn<'a>>,
    skip: HashSet<u64>,
}

struct Drawn<'a> {
    item: &'a Item,
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

impl LayerPlan<'_> {
    pub(crate) fn overlay_rects(&self) -> Vec<Rect> {
        merge(self.drawn.iter().flat_map(|d| d.rects.iter().copied()).collect())
    }
}

pub fn scroll_layer(root: &Item) -> Option<LayerPlan<'_>> {
    let mut lists = Vec::new();
    find_lists(root, None, &mut lists);
    let (list, visible, scroll) = lists.into_iter().max_by(|a, b| (a.1.w * a.1.h).total_cmp(&(b.1.w * b.1.h)))?;
    if visible.h < MIN_HEIGHT || visible.w <= 0.0 {
        return None;
    }
    let area = inner_pixels(visible)?;
    let mut plan = LayerPlan {
        list,
        scroll,
        area,
        origin_y: (list.bounds.y - scroll.offset).round() as i64 + scroll.anchored,
        drawn: Vec::new(),
        skip: HashSet::new(),
    };
    let mut after = false;
    collect(root, None, &mut after, &mut plan);
    Some(plan)
}

fn find_lists<'a>(item: &'a Item, clip: Option<PxRect>, out: &mut Vec<(&'a Item, PxRect, Scroll)>) {
    if let Some(scroll) = item.scroll().filter(|s| s.list) {
        out.push((item, clip.map_or(item.bounds, |c| item.bounds.intersect(c)), *scroll));
    }
    let child_clip = child_clip(item, clip);
    for child in &item.children {
        find_lists(child, child_clip, out);
    }
}

fn child_clip(item: &Item, clip: Option<PxRect>) -> Option<PxRect> {
    if item.clips { Some(clip.map_or(item.bounds, |c| c.intersect(item.bounds))) } else { clip }
}

fn collect<'a>(item: &'a Item, clip: Option<PxRect>, after: &mut bool, plan: &mut LayerPlan<'a>) {
    if *after {
        let mut rects = Vec::new();
        subtree_rects(item, clip, &mut rects);
        let rects: Vec<Rect> = rects.into_iter().filter_map(|r| outer_pixels(r, plan.area)).collect();
        if !rects.is_empty() {
            plan.skip.insert(item.node);
            plan.drawn.push(Drawn { item, clip, rects, inside_list: false });
        }
        return;
    }
    let inner = child_clip(item, clip);
    if item.node == plan.list.node {
        stuck(item, inner, plan);
        *after = true;
        return;
    }
    for child in &item.children {
        collect(child, inner, after, plan);
    }
}

fn stuck<'a>(item: &'a Item, clip: Option<PxRect>, plan: &mut LayerPlan<'a>) {
    for child in &item.children {
        if matches!(child.layer.map(|l| l.kind), Some(LayerKind::Sticky { stuck: true })) {
            let mut rects = Vec::new();
            subtree_rects(child, clip, &mut rects);
            let rects: Vec<Rect> = rects.into_iter().filter_map(|r| outer_pixels(r, plan.area)).collect();
            if !rects.is_empty() {
                plan.skip.insert(child.node);
                plan.drawn.push(Drawn { item: child, clip, rects, inside_list: true });
            }
        } else {
            stuck(child, clip, plan);
        }
    }
}

fn subtree_rects(item: &Item, clip: Option<PxRect>, out: &mut Vec<PxRect>) {
    out.extend(painted(item, clip));
    let inner = child_clip(item, clip);
    for child in &item.children {
        subtree_rects(child, inner, out);
    }
}

fn painted(item: &Item, clip: Option<PxRect>) -> Vec<PxRect> {
    let mut rects = Vec::new();
    if item.fills.content || item.fills.hover || item.fills.border {
        rects.push(item.bounds);
    }
    if let Some(bar) = item.scroll().and_then(|s| s.bar).filter(|b| b.opacity > 0.0) {
        rects.push(bar.zone);
    }
    match clip {
        Some(clip) => rects.into_iter().map(|r| r.intersect(clip)).filter(|r| r.w > 0.0 && r.h > 0.0).collect(),
        None => rects,
    }
}

pub fn render_layer(root: &Item, plan: &LayerPlan<'_>, canvases: &mut LayerCanvases, fonts: &[Font], host_surfaces: bool, clear: Color) -> ScrollLayer {
    let area = plan.area;
    let bar = plan.scroll.bar.filter(|b| b.opacity > 0.0);
    let expanded = bar.is_some_and(|b| b.expand > 0.0);
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
    let skip = Skip { nodes: &plan.skip, bar_of: plan.list.node };
    let mut under = Vec::new();
    for rect in rects.iter().copied().chain(thumb.map(|(r, _)| r)) {
        let content = &mut canvases.content;
        content.push_clip(rect.x as f32, rect.y as f32, rect.w as f32, rect.h as f32);
        paint_scene(content, root, fonts, host_surfaces, Some((rect, clear)), Some(&skip));
        content.pop_clip();
        under.push(content.raw_copy(rect));
    }
    let mut overlays = Vec::new();
    for rect in &rects {
        let canvas = &mut canvases.overlays;
        canvas.fill_rect(rect.x, rect.y, rect.w, rect.h, [0; 4]);
        canvas.push_clip(rect.x as f32, rect.y as f32, rect.w as f32, rect.h as f32);
        let (inside, after): (Vec<&Drawn<'_>>, Vec<&Drawn<'_>>) = plan.drawn.iter().partition(|d| d.inside_list);
        for drawn in inside {
            paint_drawn(drawn, canvas, fonts, host_surfaces);
        }
        if bar_in_overlays {
            for op in &plan.list.after {
                if let Op::Scrollbar(bar) = op {
                    crate::draw::scrollbar(canvas, bar);
                }
            }
        }
        for drawn in after {
            paint_drawn(drawn, canvas, fonts, host_surfaces);
        }
        canvas.pop_clip();
        overlays.push(Overlay { pixels: canvas.straight_copy(*rect), above: false });
    }
    if let Some((rect, (x, y))) = thumb {
        let mut canvas = Canvas::new(rect.w, rect.h);
        let color = plan.list.after.iter().find_map(|op| match op {
            Op::Scrollbar(bar) => Some(bar.thumb),
            _ => None,
        });
        if let Some((r, color)) = color {
            canvas.fill_rounded_rect(r.x - x, r.y - y, r.w, r.h, [r.w / 2.0; 4], color);
        }
        let mut pixels = canvas.straight_copy(Rect::sized(rect.w, rect.h));
        pixels.rect = rect;
        overlays.push(Overlay { pixels, above: true });
    }
    ScrollLayer { area, origin_y: plan.origin_y, under, overlays }
}

fn paint_drawn(drawn: &Drawn<'_>, canvas: &mut Canvas, fonts: &[Font], host_surfaces: bool) {
    if let Some(clip) = drawn.clip {
        canvas.push_clip(clip.x, clip.y, clip.w, clip.h);
    }
    paint_subtree(canvas, drawn.item, fonts, host_surfaces);
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
    (right > x && bottom > y).then_some(Rect { x: x as u32, y: y as u32, w: (right - x) as u32, h: (bottom - y) as u32 })
}

fn outer_pixels(r: PxRect, area: Rect) -> Option<Rect> {
    let x = r.x.floor().max(area.x as f32);
    let y = r.y.floor().max(area.y as f32);
    let right = (r.x + r.w).ceil().min((area.x + area.w) as f32);
    let bottom = (r.y + r.h).ceil().min((area.y + area.h) as f32);
    (right > x && bottom > y).then_some(Rect { x: x as u32, y: y as u32, w: (right - x) as u32, h: (bottom - y) as u32 })
}

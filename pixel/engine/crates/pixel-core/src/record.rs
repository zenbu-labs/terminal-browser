use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::Arc;

use crate::fonts::Font;
use crate::scene::{BarState, Caret, Fills, Icon, Image, Item, LayerKind, Op, Scene, Scroll, Scrollbar, Surface, Text, TextStyle};
use crate::style::{Color, Layout, Overflow, Paint, Position};
use crate::text_input::{Mark, caret_char, caret_point, caret_width};
use crate::text_metrics::{measure_marked, measure_text};
use crate::tree::{NodeId, PaintedSelection, PxRect, SlotKind, TextSpan, Tree};
use crate::wrap::wrap_lines;

type Blocks = Vec<(NodeId, Vec<PxRect>, Color)>;

struct Recorder<'a> {
    tree: &'a Tree,
    fonts: &'a [Font],
    cursor: Option<(f32, f32)>,
    blocks: &'a Blocks,
    redo: Option<HashSet<NodeId>>,
    damage: Vec<PxRect>,
}

pub fn record_scene(tree: &Tree, fonts: &[Font]) -> Scene {
    assert!(!fonts.is_empty());
    crate::profiler::span("tree.scene", || {
        let blocks = tree.doc_selection_blocks(fonts);
        let mut recorder = Recorder { tree, fonts, cursor: tree.cursor(), blocks: &blocks, redo: None, damage: Vec::new() };
        Scene { root: recorder.item(tree.root(), None, None, None, None).unwrap_or_default() }
    })
}

// Records only the nodes that changed since `previous`, reusing everything else, and returns
// the areas whose pixels changed. No areas means everything has to be drawn again.
pub fn record_changes(tree: &mut Tree, fonts: &[Font], previous: &Scene, whole: bool) -> (Scene, Option<Vec<PxRect>>) {
    assert!(!fonts.is_empty());
    let repaint = tree.take_repaint();
    let ranges = tree.doc_selection_ranges();
    let blocks = tree.doc_selection_blocks(fonts);
    let painted = std::mem::replace(&mut tree.painted_selection, PaintedSelection { ranges, blocks });
    let tree = &*tree;
    if whole || repaint.all {
        return (record_scene(tree, fonts), None);
    }
    crate::profiler::span("tree.scene", || {
        let mut dirty = repaint.nodes;
        let now = &tree.painted_selection;
        let before: HashMap<NodeId, &Range<usize>> = painted.ranges.iter().map(|(id, range)| (*id, range)).collect();
        let after: HashMap<NodeId, &Range<usize>> = now.ranges.iter().map(|(id, range)| (*id, range)).collect();
        for id in before.keys().chain(after.keys()) {
            if before.get(id) != after.get(id) {
                dirty.insert(*id);
            }
        }
        for block in now.blocks.iter().chain(&painted.blocks) {
            if !now.blocks.contains(block) || !painted.blocks.contains(block) {
                subtree(tree, block.0, &mut dirty);
            }
        }
        crate::profiler::count("scene.dirty", || dirty.len() as u64);
        let mut recorder = Recorder {
            tree,
            fonts,
            cursor: tree.cursor(),
            blocks: &now.blocks,
            redo: Some(with_ancestors(tree, dirty)),
            damage: Vec::new(),
        };
        let root = recorder.item(tree.root(), None, Some(&previous.root), None, None).unwrap_or_default();
        (Scene { root }, Some(recorder.damage))
    })
}

fn subtree(tree: &Tree, id: NodeId, out: &mut HashSet<NodeId>) {
    out.insert(id);
    for &child in tree.children(id) {
        subtree(tree, child, out);
    }
}

fn with_ancestors(tree: &Tree, dirty: HashSet<NodeId>) -> HashSet<NodeId> {
    let mut out = HashSet::with_capacity(dirty.len() * 4);
    for id in dirty {
        let mut current = Some(id);
        while let Some(at) = current {
            if !out.insert(at) {
                break;
            }
            current = tree.parent(at);
        }
    }
    out
}

fn rect_of(x: f32, y: f32, w: f32, h: f32) -> PxRect {
    PxRect { x, y, w, h }
}

fn bands(out: &mut Vec<Op>, bands: &[PxRect], clip: PxRect, color: Color) {
    for band in bands {
        let band = band.intersect(clip);
        if band.w > 0.0 && band.h > 0.0 {
            out.push(Op::Selection { rect: band, color });
        }
    }
}

fn reach(ops: &[Op]) -> PxRect {
    ops.iter().filter_map(Op::reach).fold(PxRect::ZERO, PxRect::union)
}

fn inside(item: &Item, clip: Option<PxRect>) -> Option<PxRect> {
    if item.clips { Some(clip.map_or(item.bounds, |c| c.intersect(item.bounds))) } else { clip }
}

fn own_reach(item: &Item) -> PxRect {
    let inner = reach(&item.inner).union(reach(&item.after));
    reach(&item.ops).union(if item.clips { inner.intersect(item.bounds) } else { inner })
}

fn extent(item: &Item) -> PxRect {
    let inner = item.children.iter().map(|c| c.extent).fold(reach(&item.inner).union(reach(&item.after)), PxRect::union);
    reach(&item.ops).union(if item.clips { inner.intersect(item.bounds) } else { inner })
}

impl Recorder<'_> {
    fn damage(&mut self, rect: PxRect, clip: Option<PxRect>) {
        let rect = clip.map_or(rect, |c| rect.intersect(c));
        if !rect.is_empty() {
            self.damage.push(rect);
        }
    }

    fn item(&mut self, id: NodeId, enclosing: Option<usize>, old: Option<&Arc<Item>>, clip: Option<PxRect>, old_clip: Option<PxRect>) -> Option<Arc<Item>> {
        if let (Some(old), Some(redo)) = (old, &self.redo)
            && !redo.contains(&id)
        {
            return Some(old.clone());
        }
        let (mut item, enclosing) = self.own(id, enclosing)?;
        let child_clip = inside(&item, clip);
        let old_child_clip = old.map_or(old_clip, |old| inside(old, old_clip));
        let previous: HashMap<u64, (usize, &Arc<Item>)> =
            old.map(|old| old.children.iter().enumerate().map(|(i, c)| (c.node, (i, c))).collect()).unwrap_or_default();
        let mut kept = HashSet::new();
        let mut latest = 0;
        let tree = self.tree;
        for child in tree.paint_children(id) {
            if tree.get(child).is_some_and(|n| {
                n.offscreen || (n.slot.is_some() && !n.slot_visible) || (n.mark.is_some() && !n.mark_visible)
            }) {
                continue;
            }
            let before = previous.get(&child.to_bits()).copied();
            let Some(recorded) = self.item(child, enclosing, before.map(|(_, c)| c), child_clip, old_child_clip) else {
                continue;
            };
            match before {
                Some((index, was)) => {
                    if index < latest {
                        self.damage(was.extent, old_child_clip);
                        self.damage(recorded.extent, child_clip);
                    }
                    latest = latest.max(index);
                    kept.insert(recorded.node);
                }
                None if old.is_some() => self.damage(recorded.extent, child_clip),
                None => {}
            }
            item.children.push(recorded);
        }
        if let Some(bar) = scrollbar(tree, id) {
            item.after.push(Op::Scrollbar(bar));
        }
        item.extent = extent(&item);
        if let Some(old) = old {
            for gone in old.children.iter().filter(|c| !kept.contains(&c.node)) {
                self.damage(gone.extent, old_child_clip);
            }
            self.compare(old, &item, clip, old_clip);
        }
        Some(Arc::new(item))
    }

    fn compare(&mut self, old: &Item, new: &Item, clip: Option<PxRect>, old_clip: Option<PxRect>) {
        if old.clips != new.clips || clip != old_clip || (new.clips && old.bounds != new.bounds) {
            self.damage(own_reach(old), old_clip);
            self.damage(own_reach(new), clip);
            if old.clips {
                self.damage(old.bounds, old_clip);
            }
            if new.clips {
                self.damage(new.bounds, clip);
            }
            return;
        }
        let inner = inside(new, clip);
        self.compare_ops(&old.ops, &new.ops, clip);
        self.compare_ops(&old.inner, &new.inner, inner);
        self.compare_ops(&old.after, &new.after, inner);
    }

    fn compare_ops(&mut self, old: &[Op], new: &[Op], clip: Option<PxRect>) {
        let start = old.iter().zip(new).take_while(|(a, b)| a == b).count();
        let end = old[start..].iter().rev().zip(new[start..].iter().rev()).take_while(|(a, b)| a == b).count();
        let (old, new) = (&old[start..old.len() - end], &new[start..new.len() - end]);
        if old.len() == new.len() {
            for (a, b) in old.iter().zip(new).filter(|(a, b)| a != b) {
                match (a, b) {
                    (Op::Text(a), Op::Text(b)) => {
                        let rect = self.text_change(a, b);
                        self.damage(rect, clip);
                    }
                    _ => {
                        self.damage(a.reach().unwrap_or_default(), clip);
                        self.damage(b.reach().unwrap_or_default(), clip);
                    }
                }
            }
            return;
        }
        for op in old.iter().chain(new) {
            self.damage(op.reach().unwrap_or_default(), clip);
        }
    }

    fn text_change(&self, a: &Text, b: &Text) -> PxRect {
        let same_run = (a.x, a.top, a.px, a.ascent, a.font, a.face, a.color, a.style) == (b.x, b.top, b.px, b.ascent, b.font, b.face, b.color, b.style);
        if !same_run || !a.marks.is_empty() || !b.marks.is_empty() || a.style != TextStyle::Run {
            return a.reach().union(b.reach());
        }
        let common = a.text.char_indices().zip(b.text.chars()).take_while(|((_, x), y)| x == y).last().map_or(0, |((i, c), _)| i + c.len_utf8());
        let font = &self.fonts[a.face.min(self.fonts.len() - 1)];
        let from = a.x + measure_text(font, &a.text[..common], a.px) - a.px * 0.5;
        let to = (a.x + a.width).max(b.x + b.width) + a.px;
        PxRect { x: from, y: a.top - a.px * 0.5, w: to - from, h: a.ascent + a.px * 1.5 }
    }

    fn own(&self, id: NodeId, enclosing: Option<usize>) -> Option<(Item, Option<usize>)> {
        let tree = self.tree;
        let node = tree.get(id)?;
        if node.hidden {
            return None;
        }
        let rect = node.abs;
        let visible = node.visible;
        let hovered = self.cursor.is_some_and(|(x, y)| visible.contains(x, y));
        let mut item = Item {
            node: id.to_bits(),
            bounds: rect,
            clips: node.style.overflow != Overflow::Visible,
            opaque: node.style.opaque,
            radius: node.style.corner_radius,
            fills: fills(tree, id),
            surface: node.surface,
            layer: layer(tree, id),
            ..Item::default()
        };
        if let Some(shape) = &node.shape {
            if node.visible.w > 0.0 && node.visible.h > 0.0 {
                item.ops.push(Op::Icon(Icon { rect, path: shape.clone(), glyph: shape.glyph.clone() }));
            }
            return Some((item, enclosing));
        }

        let background = match (hovered, node.style.hover_background) {
            (true, Some(bg)) => Some(Paint::Solid(bg)),
            _ => node.style.background.clone(),
        };
        let radius = node.style.corner_radius;
        match (&background, thin(tree, id)) {
            (Some(Paint::Solid(bg)), Some(line)) => item.ops.push(Op::Rule { rect: line, color: *bg }),
            (Some(Paint::Solid(bg)), None) => item.ops.push(Op::Rect { rect, radius, color: *bg }),
            (Some(Paint::Gradient(gradient)), _) => item.ops.push(Op::Gradient { rect, radius, gradient: gradient.clone() }),
            (None, _) => {}
        }
        if let Some(border) = node.style.border {
            match border.uniform() {
                Some(side) => item.ops.push(Op::Border { rect, radius, width: side.width, color: side.color }),
                None => {
                    if let Some(s) = border.top {
                        item.ops.push(Op::Rule { rect: rect_of(rect.x, rect.y, rect.w, s.width), color: s.color });
                    }
                    if let Some(s) = border.bottom {
                        item.ops.push(Op::Rule { rect: rect_of(rect.x, rect.y + rect.h - s.width, rect.w, s.width), color: s.color });
                    }
                    if let Some(s) = border.left {
                        item.ops.push(Op::Rule { rect: rect_of(rect.x, rect.y, s.width, rect.h), color: s.color });
                    }
                    if let Some(s) = border.right {
                        item.ops.push(Op::Rule { rect: rect_of(rect.x + rect.w - s.width, rect.y, s.width, rect.h), color: s.color });
                    }
                }
            }
        }
        if let Some(surface) = node.surface {
            let empty = node.children.is_empty() && crate::surfaces::with(surface, |_| ()).is_none();
            item.ops.push(Op::Surface(Surface { rect, radius, surface, empty }));
        }
        if let Some(image) = &node.image {
            let broken_icon = !node.children.iter().any(|&child| tree.get(child).is_some_and(|n| n.slot == Some(SlotKind::Error)));
            item.ops.push(Op::Image(Image {
                rect,
                radius,
                src: image.src.clone(),
                equal_to: image.equal_to.clone(),
                status: if visible.w > 0.0 && visible.h > 0.0 {
                    crate::image_cache::drawn_status(&image.src, &image.equal_to, rect.w.round() as u32, rect.h.round() as u32)
                } else {
                    crate::image_cache::status(&image.src, &image.equal_to)
                },
                broken_icon,
                px: node.resolved.px,
                color: node.resolved.color,
                glyph: image.glyph.clone(),
            }));
        }
        if let Some(index) = enclosing
            && (background.is_some() || node.style.border.is_some())
        {
            let (_, outer, color) = &self.blocks[index];
            bands(&mut item.ops, outer, visible, *color);
        }

        let block = self.blocks.iter().position(|(container, _, _)| *container == id);
        if let Some(index) = block {
            let (_, own, color) = &self.blocks[index];
            bands(&mut item.inner, own, visible, *color);
        }
        let enclosing = block.or(enclosing);
        self.text(id, hovered, enclosing.is_some(), &mut item.inner);

        Some((item, enclosing))
    }

    fn text(&self, id: NodeId, hovered: bool, in_block: bool, out: &mut Vec<Op>) {
        let tree = self.tree;
        let fonts = self.fonts;
        let Some(node) = tree.get(id) else { return };
        let Some(text) = &node.text else { return };
        let rect = node.abs;
        let visible = node.visible;
        let clips_children = node.style.overflow != Overflow::Visible;
        let px = node.resolved.px;
        let font_index = node.resolved.font.min(fonts.len() - 1);
        let font = &fonts[font_index];
        let Some(line_metrics) = font.horizontal_line_metrics(px) else { return };
        let color = match (hovered, node.style.hover_color) {
            (true, Some(c)) => c,
            _ => node.resolved.color,
        };
        let padding = tree
            .taffy
            .layout(node.taffy)
            .map(|l| (l.padding.left + l.border.left, l.padding.top + l.border.top, l.padding.right + l.border.right))
            .unwrap_or((0.0, 0.0, 0.0));
        let scroll_x = node.input.as_ref().map_or(0.0, |state| state.input.scroll_x());
        let clips_text = node.input.is_some() && !node.style.wrap && !clips_children;
        if clips_text {
            out.push(Op::Clip(rect));
        }
        let base_x = rect.x + padding.0;
        let origin = (base_x - scroll_x, rect.y + padding.1 + node.text_offset_y);
        let wrap = node.style.wrap.then(|| (rect.w - padding.0 - padding.2).max(0.0) + crate::wrap::WRAP_SLACK);
        let marks = node.marks();
        let lines = wrap_lines(text, font, px, wrap, marks);
        let line_h = line_metrics.new_line_size;
        let ascent = line_metrics.ascent;
        let focused = tree.focus() == Some(id) && !tree.inert(id);
        let caret_line = node.input.as_ref().and_then(|state| {
            (state.gutter.is_some() || state.active_line.is_some()).then(|| {
                let cursor = state.input.cursor();
                crate::selection::line_start(text, cursor)..crate::selection::line_end(text, cursor)
            })
        });
        let shown = |i: usize| {
            let top = origin.1 + line_h * i as f32;
            !(top + 2.0 * line_h < visible.y || top - line_h > visible.y + visible.h)
        };
        if let Some(state) = &node.input
            && let (Some(active), Some(logical)) = (state.active_line, &caret_line)
            && focused
            && state.input.selection().is_none()
        {
            for (i, line) in lines.iter().enumerate() {
                if line.start > logical.end {
                    break;
                }
                if line.start < logical.start {
                    continue;
                }
                let top = origin.1 + line_h * i as f32;
                if top + line_h < visible.y || top > visible.y + visible.h {
                    continue;
                }
                out.push(Op::Rect { rect: rect_of(rect.x, top, rect.w, line_h), radius: [0.0; 4], color: active });
            }
        }
        if node.spans.iter().any(|s| s.background.is_some()) {
            for (i, line) in lines.iter().enumerate() {
                let top = origin.1 + line_h * i as f32;
                if top + 2.0 * line_h < visible.y {
                    continue;
                }
                if top - line_h > visible.y + visible.h {
                    break;
                }
                for span in &node.spans {
                    let Some(bg) = span.background else { continue };
                    let start = span.start.max(line.start);
                    let end = span.end.min(line.end);
                    if start >= end {
                        continue;
                    }
                    let (Some(prefix), Some(segment)) = (text.get(line.start..start), text.get(start..end)) else {
                        continue;
                    };
                    let x = origin.0 + measure_text(font, prefix, px);
                    let w = measure_text(font, segment, px);
                    out.push(Op::Rect { rect: rect_of(x, top, w, line_h), radius: [0.0; 4], color: bg });
                }
            }
        }
        let selection = match &node.input {
            Some(state) => state.input.selection().map(|s| (s, state.selection_color)),
            None if !in_block => tree.doc_selection_range(id).map(|s| (s, node.resolved.selection_color)),
            None => None,
        };
        if let Some((selection, color)) = selection {
            selection_rects(out, text, &lines, &selection, origin, font, px, line_h, visible, color, marks);
        }
        let run = |text: String, x: f32, top: f32, face: usize, width: f32, color: Color, style: TextStyle, marks: Vec<Mark>| {
            Op::Text(Text {
                text,
                font: font_index,
                face,
                px,
                x,
                top,
                ascent,
                width,
                color,
                bold: fonts[face].bold,
                italic: fonts[face].italic,
                style,
                marks,
            })
        };
        for (i, line) in lines.iter().enumerate() {
            let top = origin.1 + line_h * i as f32;
            if top + 2.0 * line_h < visible.y {
                continue;
            }
            if top - line_h > visible.y + visible.h {
                break;
            }
            if node.spans.is_empty() {
                let cut = (node.style.ellipsis && !node.style.wrap && marks.is_empty() && node.input.is_none())
                    .then(|| {
                        let room = (rect.w - padding.0 - padding.2).max(0.0);
                        crate::wrap::ellipsize(&text[line.clone()], font, px, room)
                    })
                    .flatten();
                let (shown_text, shown_marks) = match cut {
                    Some(cut) => (cut, Vec::new()),
                    None => (text[line.clone()].to_string(), rebased(marks, line.clone())),
                };
                let width = measure_marked(font, &shown_text, 0..shown_text.len(), px, &shown_marks);
                out.push(run(shown_text, origin.0, top, font_index, width, color, TextStyle::Run, shown_marks));
                continue;
            }
            let mut x = origin.0;
            for (range, span) in split_by_spans(line.clone(), &node.spans, color) {
                let Some(segment) = text.get(range) else { continue };
                let face = font.variant(span.bold, span.italic).min(fonts.len() - 1);
                let width = measure_text(font, segment, px);
                let style = TextStyle::Span { underline: span.underline, strikethrough: span.strikethrough };
                out.push(run(segment.to_string(), x, top, face, width, span.color, style, Vec::new()));
                x += width;
            }
        }
        if let Some(state) = &node.input
            && let Some(gutter) = state.gutter
        {
            let gutter_right = base_x - px * 0.75;
            let mut logical = 0usize;
            for (i, line) in lines.iter().enumerate() {
                let starts_logical = line.start == 0 || text.as_bytes().get(line.start - 1) == Some(&b'\n');
                if starts_logical && i > 0 {
                    logical += 1;
                }
                if !starts_logical {
                    continue;
                }
                let top = origin.1 + line_h * i as f32;
                if top + line_h < visible.y {
                    continue;
                }
                if top > visible.y + visible.h {
                    break;
                }
                let active = focused && caret_line.as_ref().is_some_and(|r| line.start >= r.start && line.start <= r.end);
                let label = (logical + 1).to_string();
                let w = measure_text(font, &label, px);
                let color = if active { gutter.active_color } else { gutter.color };
                out.push(run(label, gutter_right - w, top, font_index, w, color, TextStyle::Label, Vec::new()));
            }
        }
        let _ = shown;
        if let Some(state) = &node.input
            && state.input.selection().is_none()
            && tree.focus() == Some(id)
            && !tree.inert(id)
        {
            let cursor = state.input.cursor();
            let shape = state.caret_shape;
            let (x, y) = caret_point(shape, text, cursor, font, px, wrap, marks);
            out.push(Op::Caret(Caret {
                rect: rect_of(origin.0 + x, origin.1 + y, caret_width(shape, text, cursor, font, px, marks), line_h),
                shape,
                color: state.caret_color,
                under: caret_char(text, cursor),
                font: font_index,
                px,
                ascent,
            }));
        }
        if clips_text {
            out.push(Op::Unclip);
        }
    }
}

fn layer(tree: &Tree, id: NodeId) -> Option<LayerKind> {
    let node = tree.get(id)?;
    if node.style.overflow == Overflow::Scroll {
        let bar = tree.scrollbar_rects(id).zip(tree.scrollbar_style(id)).map(|(rects, style)| BarState {
            zone: rects.zone,
            thumb: rects.thumb,
            opacity: node.bar.opacity,
            expand: node.bar.expand,
            thumb_color: style.thumb_color,
            thumb_hover_color: style.thumb_hover_color,
        });
        Some(LayerKind::Scroll(Scroll {
            offset: node.scroll.shown(),
            extent: node.scroll_max + node.abs.h,
            anchored: node.scroll.anchored,
            list: node.style.layout == Layout::List,
            bar,
        }))
    } else if node.style.position == Position::Sticky {
        Some(LayerKind::Sticky { stuck: node.stuck })
    } else if node.surface.is_some() {
        Some(LayerKind::Surface)
    } else {
        None
    }
}

fn rebased(marks: &[Mark], line: Range<usize>) -> Vec<Mark> {
    marks
        .iter()
        .filter(|m| line.contains(&m.offset))
        .map(|m| Mark { offset: m.offset - line.start, ..m.clone() })
        .collect()
}

fn fills(tree: &Tree, id: NodeId) -> Fills {
    let Some(node) = tree.get(id) else { return Fills::default() };
    let content = match &node.style.background {
        Some(Paint::Solid(color)) => color[3] > 0,
        Some(Paint::Gradient(_)) => true,
        None => false,
    } || node.surface.is_some()
        || node.text.is_some()
        || !node.spans.is_empty()
        || node.image.is_some()
        || node.shape.is_some()
        || node.input.is_some();
    let side = |s: Option<crate::style::BorderSide>| s.filter(|s| s.width > 0.0 && s.color[3] > 0).map_or(0.0, |s| s.width);
    let sides = node.style.border.map_or([0.0; 4], |b| [side(b.top), side(b.right), side(b.bottom), side(b.left)]);
    let solid = matches!(node.style.background, Some(Paint::Solid(color)) if color[3] == 255);
    Fills { content, solid, hover: node.style.hover_background.is_some(), border: node.style.border.is_some(), sides }
}

fn thin(tree: &Tree, id: NodeId) -> Option<PxRect> {
    let node = tree.get(id)?;
    let (unit_x, unit_y) = tree.lattice();
    let mut line = node.abs;
    let mut narrowed = false;
    if let crate::style::Dimension::Px(h) = node.style.height
        && h > 0.0
        && h < unit_y / 2.0
    {
        line.y += (line.h - h) / 2.0;
        line.h = h;
        narrowed = true;
    }
    if let crate::style::Dimension::Px(w) = node.style.width
        && w > 0.0
        && w < unit_x / 2.0
    {
        line.x += (line.w - w) / 2.0;
        line.w = w;
        narrowed = true;
    }
    (narrowed && (unit_x, unit_y) != (1.0, 1.0)).then_some(line)
}

fn scrollbar(tree: &Tree, id: NodeId) -> Option<Scrollbar> {
    let node = tree.get(id)?;
    let opacity = node.bar.opacity;
    if opacity <= 0.0 {
        return None;
    }
    let rects = tree.scrollbar_rects(id)?;
    let bar = tree.scrollbar_style(id)?;
    let expand = node.bar.expand;
    let track = (expand > 0.0).then(|| (rects.track, fade(bar.track_color, opacity * expand)));
    let thumb = fade(lerp_color(bar.thumb_color, bar.thumb_hover_color, expand), opacity);
    Some(Scrollbar { track, thumb: (rects.thumb, thumb) })
}

pub fn fade(color: Color, factor: f32) -> Color {
    [color[0], color[1], color[2], (color[3] as f32 * factor.clamp(0.0, 1.0)) as u8]
}

pub fn lerp_color(from: Color, to: Color, t: f32) -> Color {
    let ch = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t) as u8;
    [ch(from[0], to[0]), ch(from[1], to[1]), ch(from[2], to[2]), ch(from[3], to[3])]
}

fn split_by_spans(line: Range<usize>, spans: &[TextSpan], fallback: Color) -> Vec<(Range<usize>, TextSpan)> {
    let plain = |color| TextSpan { color, ..TextSpan::default() };
    let mut out = Vec::new();
    let mut at = line.start;
    for span in spans {
        if at >= line.end {
            break;
        }
        let start = span.start.max(at);
        let end = span.end.min(line.end);
        if start >= end {
            continue;
        }
        if start > at {
            out.push((at..start, plain(fallback)));
        }
        out.push((start..end, *span));
        at = end;
    }
    if at < line.end {
        out.push((at..line.end, plain(fallback)));
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn selection_rects(
    out: &mut Vec<Op>,
    text: &str,
    lines: &[Range<usize>],
    selection: &Range<usize>,
    origin: (f32, f32),
    font: &Font,
    px: f32,
    line_h: f32,
    visible: PxRect,
    color: Color,
    marks: &[Mark],
) {
    let newline_w = measure_text(font, " ", px);
    for (i, line) in lines.iter().enumerate() {
        if line.start > selection.end {
            break;
        }
        let top = origin.1 + line_h * i as f32;
        if top > visible.y + visible.h {
            break;
        }
        let overlaps = selection.start <= line.end && selection.end > line.start;
        if overlaps && top + line_h >= visible.y {
            let from = selection.start.max(line.start);
            let to = selection.end.min(line.end);
            let x1 = measure_marked(font, text, line.start..from, px, marks);
            let mut x2 = measure_marked(font, text, line.start..to, px, marks);
            if selection.end > line.end && text[line.end..].starts_with('\n') {
                x2 += newline_w;
            }
            out.push(Op::Selection { rect: rect_of(origin.0 + x1, top, (x2 - x1).max(1.0), line_h), color });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: Color = [255, 0, 0, 255];
    const FALLBACK: Color = [9, 9, 9, 255];

    fn span(start: usize, end: usize) -> TextSpan {
        TextSpan { start, end, color: RED, ..TextSpan::default() }
    }

    fn colors(out: &[(Range<usize>, TextSpan)]) -> Vec<(Range<usize>, Color)> {
        out.iter().map(|(r, s)| (r.clone(), s.color)).collect()
    }

    #[test]
    fn spans_split_a_line_with_fallback_gaps() {
        let out = split_by_spans(0..10, &[], FALLBACK);
        assert_eq!(colors(&out), vec![(0..10, FALLBACK)]);
        let out = split_by_spans(0..10, &[span(2, 4), span(6, 8)], FALLBACK);
        assert_eq!(colors(&out), vec![(0..2, FALLBACK), (2..4, RED), (4..6, FALLBACK), (6..8, RED), (8..10, FALLBACK)]);
    }

    #[test]
    fn spans_clamp_to_the_line_and_ignore_outside_ranges() {
        let out = split_by_spans(5..10, &[span(0, 3), span(4, 7), span(9, 20)], FALLBACK);
        assert_eq!(colors(&out), vec![(5..7, RED), (7..9, FALLBACK), (9..10, RED)]);
    }

    #[test]
    fn overlapping_spans_keep_earlier_coverage() {
        let out = split_by_spans(0..10, &[span(0, 5), span(3, 8)], FALLBACK);
        assert_eq!(colors(&out), vec![(0..5, RED), (5..8, RED), (8..10, FALLBACK)]);
    }
}

use std::ops::Range;

use crate::fonts::Font;
use crate::scene::{
    BarState, Caret, Change, Fills, Icon, Image, Item, Layer, LayerKind, Op, Scene, Scroll, Scrollbar, Surface,
    Text, TextStyle,
};
use crate::style::{Color, Layout, Overflow, Paint, Position};
use crate::text_input::{Mark, caret_char, caret_point, caret_width};
use crate::text_metrics::{measure_marked, measure_text};
use crate::tree::{NodeId, PxRect, SlotKind, TextSpan, Tree};
use crate::wrap::wrap_lines;

struct Recorder<'a> {
    tree: &'a Tree,
    fonts: &'a [Font],
    cursor: Option<(f32, f32)>,
    blocks: Vec<(NodeId, Vec<PxRect>, Color)>,
    layers: u32,
}

pub fn record_scene(tree: &Tree, fonts: &[Font], cursor: Option<(f32, f32)>) -> Scene {
    assert!(!fonts.is_empty());
    crate::profiler::span("tree.scene", || {
        let mut recorder = Recorder { tree, fonts, cursor, blocks: tree.doc_selection_blocks(fonts), layers: 0 };
        let root = recorder.item(tree.root(), None).unwrap_or_default();
        Scene { root }
    })
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

impl Recorder<'_> {
    fn item(&mut self, id: NodeId, enclosing: Option<usize>) -> Option<Item> {
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
            ..Item::default()
        };
        item.layer = self.layer(id);

        if let Some(shape) = &node.shape {
            if node.visible.w > 0.0 && node.visible.h > 0.0 {
                item.ops.push(Op::Icon(Icon { rect, path: shape.clone(), glyph: shape.glyph.clone() }));
            }
            return Some(item);
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

        for child in tree.paint_children(id) {
            if tree.get(child).is_some_and(|n| {
                n.offscreen || (n.slot.is_some() && !n.slot_visible) || (n.mark.is_some() && !n.mark_visible)
            }) {
                continue;
            }
            if let Some(child) = self.item(child, enclosing) {
                item.children.push(child);
            }
        }
        if let Some(bar) = scrollbar(tree, id) {
            item.after.push(Op::Scrollbar(bar));
        }
        Some(item)
    }

    fn layer(&mut self, id: NodeId) -> Option<Layer> {
        let tree = self.tree;
        let node = tree.get(id)?;
        let kind = if node.style.overflow == Overflow::Scroll {
            let bar = tree.scrollbar_rects(id).zip(tree.scrollbar_style(id)).map(|(rects, style)| BarState {
                zone: rects.zone,
                thumb: rects.thumb,
                opacity: node.bar.opacity,
                expand: node.bar.expand,
                thumb_color: style.thumb_color,
                thumb_hover_color: style.thumb_hover_color,
            });
            LayerKind::Scroll(Scroll {
                offset: node.scroll.shown(),
                extent: node.scroll_max + node.abs.h,
                anchored: node.scroll.anchored,
                list: node.style.layout == Layout::List,
                bar,
            })
        } else if node.style.position == Position::Sticky {
            LayerKind::Sticky { stuck: node.stuck }
        } else if node.surface.is_some() {
            LayerKind::Surface
        } else {
            return None;
        };
        self.layers += 1;
        Some(Layer { z: self.layers, kind, change: Change::New })
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
                out.push(run(shown_text, origin.0, top, font_index, 0.0, color, TextStyle::Run, shown_marks));
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

pub fn mark_changes(previous: &Scene, next: &mut Scene) {
    let mut before = std::collections::HashMap::new();
    collect(&previous.root, &mut before);
    mark(&mut next.root, &before);
}

fn collect<'a>(item: &'a Item, out: &mut std::collections::HashMap<u64, &'a Item>) {
    if item.layer.is_some() {
        out.insert(item.node, item);
    }
    for child in &item.children {
        collect(child, out);
    }
}

fn mark(item: &mut Item, before: &std::collections::HashMap<u64, &Item>) {
    for child in &mut item.children {
        mark(child, before);
    }
    let Some(layer) = item.layer else { return };
    let change = match before.get(&item.node) {
        None => Change::New,
        Some(old) => {
            let offset = |i: &Item| i.scroll().map_or(0.0, |s| s.offset);
            let by = offset(item) - offset(old);
            if by == 0.0 {
                if same(old, item) { Change::None } else { Change::Content }
            } else if by.fract() == 0.0 && same_shifted(old, item, by) {
                Change::Offset { by: by as i64 }
            } else {
                Change::Content
            }
        }
    };
    item.layer = Some(Layer { change, ..layer });
}

fn same(a: &Item, b: &Item) -> bool {
    a.bounds == b.bounds && a.ops == b.ops && a.inner == b.inner && a.after == b.after && a.children.len() == b.children.len()
        && a.children.iter().zip(&b.children).all(|(x, y)| x.node == y.node && same(x, y))
}

fn same_shifted(old: &Item, new: &Item, by: f32) -> bool {
    if old.ops != new.ops {
        return false;
    }
    let mut inner = new.inner.clone();
    inner.iter_mut().for_each(|op| shift_op(op, by));
    if inner != old.inner {
        return false;
    }
    let now_seen = PxRect { y: new.bounds.y + by, ..new.bounds };
    let mut kept = old.children.iter().filter(|a| new.children.iter().any(|b| b.node == a.node));
    for child in &new.children {
        let mut moved = child.clone();
        shift(&mut moved, by);
        if old.children.iter().any(|a| a.node == child.node) {
            if !kept.next().is_some_and(|a| a.node == child.node && same(a, &moved)) {
                return false;
            }
        } else if overlaps(moved.bounds, old.bounds) {
            return false;
        }
    }
    old.children.iter().all(|a| new.children.iter().any(|b| b.node == a.node) || !overlaps(a.bounds, now_seen))
}

fn overlaps(a: PxRect, b: PxRect) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

fn shift(item: &mut Item, by: f32) {
    item.bounds.y += by;
    for op in item.ops.iter_mut().chain(item.inner.iter_mut()).chain(item.after.iter_mut()) {
        shift_op(op, by);
    }
    for child in &mut item.children {
        shift(child, by);
    }
}

fn shift_op(op: &mut Op, by: f32) {
    match op {
        Op::Rect { rect, .. } | Op::Gradient { rect, .. } | Op::Border { rect, .. } | Op::Rule { rect, .. } | Op::Selection { rect, .. } | Op::Clip(rect) => rect.y += by,
        Op::Text(text) => text.top += by,
        Op::Image(image) => image.rect.y += by,
        Op::Surface(surface) => surface.rect.y += by,
        Op::Icon(icon) => icon.rect.y += by,
        Op::Caret(caret) => caret.rect.y += by,
        Op::Scrollbar(bar) => {
            bar.thumb.0.y += by;
            if let Some(track) = &mut bar.track {
                track.0.y += by;
            }
        }
        Op::Unclip => {}
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

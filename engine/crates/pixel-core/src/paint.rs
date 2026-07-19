use std::ops::Range;
use std::time::Instant;

use crate::canvas::{Canvas, measure_marked, measure_text};
use crate::image_cache::ImageStatus;
use crate::style::{Color, Overflow};
use crate::text_input::{Mark, caret_width, offset_to_point};
use crate::tree::{NodeId, PxRect, SlotKind, TextSpan, Tree};
use crate::wrap::wrap_lines;

#[derive(Default)]
struct PaintStats {
    rects: f64,
    images: f64,
    wrap: f64,
    glyphs: f64,
    selection: f64,
    bars: f64,
    shapes: f64,
    nodes: u64,
    rect_count: u64,
    glyph_count: u64,
}

impl PaintStats {
    fn emit(self, start_ms: f64) {
        let mut at = start_ms;
        let buckets = [
            ("paint.rects", self.rects, Some(self.rect_count)),
            ("paint.images", self.images, None),
            ("paint.wrap", self.wrap, None),
            ("paint.glyphs", self.glyphs, Some(self.glyph_count)),
            ("paint.selection", self.selection, None),
            ("paint.scrollbars", self.bars, None),
            ("paint.shapes", self.shapes, None),
        ];
        for (name, dur, arg) in buckets {
            if dur <= 0.0 {
                continue;
            }
            crate::profiler::emit(name, at, dur, arg);
            at += dur;
        }
        crate::profiler::count("paint.nodes", self.nodes);
        crate::profiler::count("paint.glyphs", self.glyph_count);
    }
}

fn timed<T>(bucket: Option<&mut f64>, work: impl FnOnce() -> T) -> T {
    match bucket {
        None => work(),
        Some(bucket) => {
            let start = Instant::now();
            let result = work();
            *bucket += start.elapsed().as_secs_f64() * 1000.0;
            result
        }
    }
}

// todo: check why, and verify this statement "Requires `flush_layout` to have run first."
pub fn paint(
    tree: &Tree,
    canvas: &mut Canvas,
    fonts: &[fontdue::Font],
    cursor: Option<(f32, f32)>,
) {
    assert!(!fonts.is_empty());
    crate::profiler::span("tree.paint", || {
        let start_ms = crate::profiler::now_ms();
        let mut stats = start_ms.map(|_| PaintStats::default());
        let blocks = tree.doc_selection_blocks(fonts);
        paint_node(
            tree,
            tree.root(),
            canvas,
            fonts,
            cursor,
            &blocks,
            None,
            &mut stats,
        );
        if let (Some(stats), Some(start_ms)) = (stats, start_ms) {
            stats.emit(start_ms);
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn paint_node(
    tree: &Tree,
    id: NodeId,
    canvas: &mut Canvas,
    fonts: &[fontdue::Font],
    cursor: Option<(f32, f32)>,
    blocks: &[(NodeId, Vec<PxRect>, Color)],
    enclosing_block: Option<(&[PxRect], Color)>,
    stats: &mut Option<PaintStats>,
) {
    let Some(node) = tree.get(id) else {
        return;
    };
    if node.hidden {
        return;
    }
    if let Some(stats) = stats {
        stats.nodes += 1;
    }
    let rect = node.abs;
    let visible = node.visible;
    let hovered = cursor.is_some_and(|(x, y)| visible.contains(x, y));

    let background = match (hovered, node.style.hover_background) {
        (true, Some(bg)) => Some(bg),
        _ => node.style.background,
    };
    if background.is_some() || node.style.border.is_some() {
        if let Some(stats) = stats {
            stats.rect_count += background.is_some() as u64 + node.style.border.is_some() as u64;
        }
        timed(stats.as_mut().map(|s| &mut s.rects), || {
            if let Some(bg) = background {
                canvas.fill_rounded_rect(
                    rect.x,
                    rect.y,
                    rect.w,
                    rect.h,
                    node.style.corner_radius,
                    bg,
                );
            }
            if let Some(border) = node.style.border {
                match border.uniform() {
                    Some(side) => canvas.stroke_rounded_rect(
                        rect.x,
                        rect.y,
                        rect.w,
                        rect.h,
                        node.style.corner_radius,
                        side.width,
                        side.color,
                    ),
                    None => {
                        if let Some(s) = border.top {
                            canvas.fill_rounded_rect(rect.x, rect.y, rect.w, s.width, [0.0; 4], s.color);
                        }
                        if let Some(s) = border.bottom {
                            let y = rect.y + rect.h - s.width;
                            canvas.fill_rounded_rect(rect.x, y, rect.w, s.width, [0.0; 4], s.color);
                        }
                        if let Some(s) = border.left {
                            canvas.fill_rounded_rect(rect.x, rect.y, s.width, rect.h, [0.0; 4], s.color);
                        }
                        if let Some(s) = border.right {
                            let x = rect.x + rect.w - s.width;
                            canvas.fill_rounded_rect(x, rect.y, s.width, rect.h, [0.0; 4], s.color);
                        }
                    }
                }
            }
        });
    }
    if let Some(surface) = node.surface {
        timed(stats.as_mut().map(|s| &mut s.images), || {
            crate::surfaces::with(surface, |s| {
                canvas.blit_scaled_rgba_rounded(
                    rect.x,
                    rect.y,
                    rect.w,
                    rect.h,
                    &s.pixels,
                    s.width,
                    s.height,
                    node.style.corner_radius,
                );
            });
        });
    }
    if let Some(image) = &node.image {
        timed(stats.as_mut().map(|s| &mut s.images), || {
            match crate::image_cache::status(&image.src, &image.equal_to) {
                ImageStatus::Ready => {
                    crate::image_cache::with_scaled_image(
                        &image.src,
                        rect.w.round().max(0.0) as u32,
                        rect.h.round().max(0.0) as u32,
                        node.style.corner_radius,
                        &image.equal_to,
                        |pixmap| canvas.blit_image(rect.x, rect.y, pixmap),
                    );
                }
                ImageStatus::Failed => {
                    let has_error_slot = node.children.iter().any(|&child| {
                        tree.get(child)
                            .is_some_and(|n| n.slot == Some(SlotKind::Error))
                    });
                    if !has_error_slot {
                        paint_broken_image (canvas, rect, node.resolved.px, node.resolved.color);
                    }
                }
                /**
                 * the users pending ui can render here in place if they specified one in <Image/>
                 */
                ImageStatus::Pending => {}
            }
        });
    }

    if let Some((bands, color)) = enclosing_block
        && (background.is_some() || node.style.border.is_some())
    {
        timed(stats.as_mut().map(|s| &mut s.selection), || {
            fill_bands(canvas, bands, visible, color);
        });
    }

    // A scene always clips: its world content has no relation to the box's bounds.
    let clips_children = node.style.overflow != Overflow::Visible || node.scene.is_some();
    if clips_children {
        canvas.push_clip(rect.x, rect.y, rect.w, rect.h);
    }

    let block = blocks.iter().find(|(container, _, _)| *container == id);
    if let Some((_, bands, color)) = block {
        timed(stats.as_mut().map(|s| &mut s.selection), || {
            fill_bands(canvas, bands, visible, *color);
        });
    }
    let enclosing_block = block
        .map(|(_, bands, color)| (bands.as_slice(), *color))
        .or(enclosing_block);
    let in_block = enclosing_block.is_some();

    if let Some(text) = &node.text {
        let px = node.resolved.px;
        let font = &fonts[node.resolved.font.min(fonts.len() - 1)];
        if let Some(line_metrics) = font.horizontal_line_metrics(px) {
            let color = match (hovered, node.style.hover_color) {
                (true, Some(c)) => c,
                _ => node.resolved.color,
            };
            let padding = tree
                .taffy
                .layout(node.taffy)
                .map(|l| (l.padding.left, l.padding.top, l.padding.right))
                .unwrap_or((0.0, 0.0, 0.0));
            let origin = (rect.x + padding.0, rect.y + padding.1);
            let wrap = node
                .style
                .wrap
                .then(|| (rect.w - padding.0 - padding.2).max(0.0) + crate::wrap::WRAP_SLACK);
            let marks = node.marks();
            let lines = timed(stats.as_mut().map(|s| &mut s.wrap), || {
                wrap_lines(text, font, px, wrap, marks)
            });
            let line_h = line_metrics.new_line_size;
            let focused = tree.focus() == Some(id);
            let caret_line = node.input.as_ref().and_then(|state| {
                (state.gutter.is_some() || state.active_line.is_some()).then(|| {
                    let cursor = state.input.cursor();
                    crate::selection::line_start(text, cursor)
                        ..crate::selection::line_end(text, cursor)
                })
            });
            if let Some(state) = &node.input
                && let (Some(active), Some(logical)) = (state.active_line, &caret_line)
                && focused
                && state.input.selection().is_none()
            {
                timed(stats.as_mut().map(|s| &mut s.rects), || {
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
                        canvas.fill_rounded_rect(rect.x, top, rect.w, line_h, [0.0; 4], active);
                    }
                });
            }
            if node.spans.iter().any(|s| s.background.is_some()) {
                timed(stats.as_mut().map(|s| &mut s.rects), || {
                    for (i, line) in lines.iter().enumerate() {
                        let top = origin.1 + line_h * i as f32;
                        if top + 2.0 * line_h < visible.y {
                            continue;
                        }
                        if top - line_h > visible.y + visible.h {
                            break;
                        }
                        for span in &node.spans {
                            let Some(bg) = span.background else {
                                continue;
                            };
                            let start = span.start.max(line.start);
                            let end = span.end.min(line.end);
                            if start >= end {
                                continue;
                            }
                            let (Some(prefix), Some(segment)) =
                                (text.get(line.start..start), text.get(start..end))
                            else {
                                continue;
                            };
                            let x = origin.0 + measure_text(font, prefix, px);
                            let w = measure_text(font, segment, px);
                            canvas.fill_rounded_rect(x, top, w, line_h, [0.0; 4], bg);
                        }
                    }
                });
            }
            let selection = match &node.input {
                Some(state) => state.input.selection().map(|s| (s, state.selection_color)),
                None if !in_block => tree
                    .doc_selection_range(id)
                    .map(|s| (s, node.resolved.selection_color)),
                None => None,
            };
            if let Some((selection, color)) = selection {
                timed(stats.as_mut().map(|s| &mut s.selection), || {
                    paint_selection(
                        canvas, text, &lines, &selection, origin, font, px, line_h, visible,
                        color, marks,
                    )
                });
            }
            timed(stats.as_mut().map(|s| &mut s.glyphs), || {
                for (i, line) in lines.iter().enumerate() {
                    let top = origin.1 + line_h * i as f32;
                    if top + 2.0 * line_h < visible.y {
                        continue;
                    }
                    if top - line_h > visible.y + visible.h {
                        break;
                    }
                    let baseline = (top + line_metrics.ascent) as i32;
                    if node.spans.is_empty() {
                        canvas.draw_marked(
                            font,
                            text,
                            line.clone(),
                            origin.0 as i32,
                            baseline,
                            px,
                            color,
                            marks,
                        );
                        continue;
                    }
                    let mut x = origin.0;
                    for (range, span) in split_by_spans(line.clone(), &node.spans, color) {
                        let Some(segment) = text.get(range) else {
                            continue;
                        };
                        let shear = if span.italic { ITALIC_SHEAR } else { 0.0 };
                        canvas.draw_text_sheared(
                            font, segment, x as i32, baseline, px, span.color, shear,
                        );
                        if span.bold {
                            let offset = (px / 24.0).max(1.0) as i32;
                            canvas.draw_text_sheared(
                                font,
                                segment,
                                x as i32 + offset,
                                baseline,
                                px,
                                span.color,
                                shear,
                            );
                        }
                        let width = measure_text(font, segment, px);
                        let thickness = (px / 14.0).max(1.0);
                        if span.underline {
                            canvas.fill_rounded_rect(
                                x,
                                top + line_metrics.ascent + thickness,
                                width,
                                thickness,
                                [0.0; 4],
                                span.color,
                            );
                        }
                        if span.strikethrough {
                            canvas.fill_rounded_rect(
                                x,
                                top + line_metrics.ascent - px * 0.28,
                                width,
                                thickness,
                                [0.0; 4],
                                span.color,
                            );
                        }
                        x += width;
                    }
                }
            });
            if let Some(state) = &node.input
                && let Some(gutter) = state.gutter
            {
                timed(stats.as_mut().map(|s| &mut s.glyphs), || {
                    let gutter_right = origin.0 - px * 0.75;
                    let mut logical = 0usize;
                    for (i, line) in lines.iter().enumerate() {
                        let starts_logical = line.start == 0
                            || text.as_bytes().get(line.start - 1) == Some(&b'\n');
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
                        let active = focused
                            && caret_line
                                .as_ref()
                                .is_some_and(|r| line.start >= r.start && line.start <= r.end);
                        let label = (logical + 1).to_string();
                        let w = measure_text(font, &label, px);
                        canvas.draw_text(
                            font,
                            &label,
                            (gutter_right - w) as i32,
                            (top + line_metrics.ascent) as i32,
                            px,
                            if active { gutter.active_color } else { gutter.color },
                        );
                    }
                });
            }
            if let Some(stats) = stats.as_mut() {
                for (i, line) in lines.iter().enumerate() {
                    let top = origin.1 + line_h * i as f32;
                    if top + 2.0 * line_h < visible.y {
                        continue;
                    }
                    if top - line_h > visible.y + visible.h {
                        break;
                    }
                    stats.glyph_count += text[line.clone()].chars().count() as u64;
                }
            }
            if let Some(state) = &node.input
                && state.input.selection().is_none()
                && tree.focus() == Some(id)
            {
                let (x, y) = offset_to_point(text, state.input.cursor(), font, px, wrap, marks);
                canvas.fill_rounded_rect(
                    origin.0 + x,
                    origin.1 + y,
                    caret_width(px),
                    line_h,
                    [1.5; 4],
                    state.caret_color,
                );
            }
        }
    }

    for &child in &node.children {
        if tree.get(child).is_some_and(|n| {
            (n.slot.is_some() && !n.slot_visible) || (n.mark.is_some() && !n.mark_visible)
        }) {
            continue;
        }
        if tree.get(child).is_some_and(|n| n.shape.is_some()) {
            if let Some(camera) = node.scene {
                timed(stats.as_mut().map(|s| &mut s.shapes), || {
                    paint_shape(tree, child, canvas, fonts, camera, rect);
                });
            }
            continue;
        }
        paint_node(
            tree,
            child,
            canvas,
            fonts,
            cursor,
            blocks,
            enclosing_block,
            stats,
        );
    }
    timed(stats.as_mut().map(|s| &mut s.bars), || {
        paint_scrollbar(tree, id, canvas)
    });
    if clips_children {
        canvas.pop_clip();
    }
}


fn paint_shape(
    tree: &Tree,
    id: NodeId,
    canvas: &mut Canvas,
    fonts: &[fontdue::Font],
    camera: crate::scene::Camera,
    scene_rect: PxRect,
) {
    let Some(node) = tree.get(id) else {
        return;
    };
    if node.hidden || node.visible.w <= 0.0 || node.visible.h <= 0.0 {
        return;
    }
    let Some(props) = &node.shape else {
        return;
    };
    let origin = (scene_rect.x, scene_rect.y);
    match &props.shape {
        crate::scene::Shape::Text { x, y } => {
            let Some(text) = &node.text else {
                return;
            };
            let font = &fonts[node.resolved.font.min(fonts.len() - 1)];
            let px = node.resolved.px * camera.zoom;
            let Some(metrics) = font.horizontal_line_metrics(px) else {
                return;
            };
            let (sx, sy) = camera.to_screen(origin, *x, *y);
            let color = props.fill.unwrap_or(node.resolved.color);
            for (i, line) in text.split('\n').enumerate() {
                let baseline = sy + metrics.new_line_size * i as f32 + metrics.ascent;
                canvas.draw_text(font, line, sx as i32, baseline as i32, px, color);
            }
        }
        crate::scene::Shape::Image { x, y, w, h } => {
            let Some(image) = &node.image else {
                return;
            };
            if crate::image_cache::status(&image.src, &image.equal_to) != ImageStatus::Ready {
                return;
            }
            let (sx, sy) = camera.to_screen(origin, *x, *y);
            crate::image_cache::with_scaled_image(
                &image.src,
                (w * camera.zoom).round().max(1.0) as u32,
                (h * camera.zoom).round().max(1.0) as u32,
                [0.0; 4],
                &image.equal_to,
                |pixmap| canvas.blit_image(sx, sy, pixmap),
            );
        }
        shape => {
            let Some(path) = crate::scene::build_path(shape) else {
                return;
            };
            let Some(path) = path.transform(camera.transform(origin)) else {
                return;
            };
            if let Some(fill) = props.fill {
                canvas.fill_path(&path, fill);
            }
            if let Some(stroke) = &props.stroke {
                canvas.stroke_path(&path, stroke.color, crate::scene::skia_stroke(stroke, camera.zoom));
            }
        }
    }
}

/**
 * i wish we had an internal UI node that represented this
 */
fn paint_broken_image(canvas: &mut Canvas, rect: PxRect, px: f32, color: Color) {
    let side = (px * 1.5).min(rect.w * 0.6).min(rect.h * 0.6);
    if side < 4.0 {
        return;
    }
    let muted = [color[0], color[1], color[2], 90];
    let x = rect.x + (rect.w - side) / 2.0;
    let y = rect.y + (rect.h - side) / 2.0;
    let stroke = (side / 12.0).max(1.0);
    canvas.stroke_rounded_rect(x, y, side, side, [side * 0.18; 4], stroke, muted);
    let dot = side * 0.18;
    canvas.fill_rounded_rect(
        x + side * 0.3 - dot / 2.0,
        y + side * 0.34 - dot / 2.0,
        dot,
        dot,
        [dot; 4],
        muted,
    );
}

fn fill_bands(canvas: &mut Canvas, bands: &[PxRect], clip: PxRect, color: Color) {
    for band in bands {
        let band = band.intersect(clip);
        if band.w > 0.0 && band.h > 0.0 {
            canvas.fill_rounded_rect(band.x, band.y, band.w, band.h, [0.0; 4], color);
        }
    }
}

const ITALIC_SHEAR: f32 = 0.22;

fn split_by_spans(
    line: Range<usize>,
    spans: &[TextSpan],
    fallback: Color,
) -> Vec<(Range<usize>, TextSpan)> {
    let plain = |color| TextSpan {
        color,
        ..TextSpan::default()
    };
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

fn paint_scrollbar(tree: &Tree, id: NodeId, canvas: &mut Canvas) {
    let Some(node) = tree.get(id) else {
        return;
    };
    let opacity = node.bar.opacity;
    if opacity <= 0.0 {
        return;
    }
    let Some(rects) = tree.scrollbar_rects(id) else {
        return;
    };
    let Some(bar) = tree.scrollbar_style(id) else {
        return;
    };
    let expand = node.bar.expand;
    if expand > 0.0 {
        let track = fade(bar.track_color, opacity * expand);
        canvas.fill_rounded_rect(
            rects.track.x,
            rects.track.y,
            rects.track.w,
            rects.track.h,
            [rects.track.w / 2.0; 4],
            track,
        );
    }
    let thumb = fade(
        lerp_color(bar.thumb_color, bar.thumb_hover_color, expand),
        opacity,
    );
    canvas.fill_rounded_rect(
        rects.thumb.x,
        rects.thumb.y,
        rects.thumb.w,
        rects.thumb.h,
        [rects.thumb.w / 2.0; 4],
        thumb,
    );
}

fn fade(color: Color, factor: f32) -> Color {
    [
        color[0],
        color[1],
        color[2],
        (color[3] as f32 * factor.clamp(0.0, 1.0)) as u8,
    ]
}

fn lerp_color(from: Color, to: Color, t: f32) -> Color {
    let ch = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t) as u8;
    [
        ch(from[0], to[0]),
        ch(from[1], to[1]),
        ch(from[2], to[2]),
        ch(from[3], to[3]),
    ]
}

#[allow(clippy::too_many_arguments)]
fn paint_selection(
    canvas: &mut Canvas,
    text: &str,
    lines: &[Range<usize>],
    selection: &Range<usize>,
    origin: (f32, f32),
    font: &fontdue::Font,
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
            canvas.fill_rounded_rect(origin.0 + x1, top, (x2 - x1).max(1.0), line_h, [0.0; 4], color);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desc::Desc;
    use crate::style::{Dimension, Style};

    static FONT_BYTES: &[u8] =
        include_bytes!("../../../examples/typing/assets/JetBrainsMono-Regular.ttf");

    const RED: Color = [255, 0, 0, 255];
    const FALLBACK: Color = [9, 9, 9, 255];

    fn span(start: usize, end: usize) -> TextSpan {
        TextSpan {
            start,
            end,
            color: RED,
            ..TextSpan::default()
        }
    }

    fn colors(out: &[(Range<usize>, TextSpan)]) -> Vec<(Range<usize>, Color)> {
        out.iter().map(|(r, s)| (r.clone(), s.color)).collect()
    }

    #[test]
    fn no_spans_yields_the_whole_line_in_the_fallback_color() {
        let out = split_by_spans(0..10, &[], FALLBACK);
        assert_eq!(colors(&out), vec![(0..10, FALLBACK)]);
    }

    #[test]
    fn spans_split_a_line_with_fallback_gaps() {
        let out = split_by_spans(0..10, &[span(2, 4), span(6, 8)], FALLBACK);
        assert_eq!(
            colors(&out),
            vec![
                (0..2, FALLBACK),
                (2..4, RED),
                (4..6, FALLBACK),
                (6..8, RED),
                (8..10, FALLBACK),
            ]
        );
    }

    #[test]
    fn spans_clamp_to_the_line_and_ignore_outside_ranges() {
        let out = split_by_spans(5..10, &[span(0, 3), span(4, 7), span(9, 20)], FALLBACK);
        assert_eq!(
            colors(&out),
            vec![(5..7, RED), (7..9, FALLBACK), (9..10, RED)]
        );
    }

    #[test]
    fn overlapping_spans_keep_earlier_coverage() {
        let out = split_by_spans(0..10, &[span(0, 5), span(3, 8)], FALLBACK);
        assert_eq!(
            colors(&out),
            vec![(0..5, RED), (5..8, RED), (8..10, FALLBACK)]
        );
    }

    #[test]
    fn styled_spans_carry_their_flags_through_the_split() {
        let styled = TextSpan {
            bold: true,
            italic: true,
            underline: true,
            ..span(2, 4)
        };
        let out = split_by_spans(0..6, &[styled], FALLBACK);
        assert_eq!(out.len(), 3);
        assert!(!out[0].1.bold && !out[0].1.italic);
        assert_eq!(out[1].0, 2..4);
        assert!(out[1].1.bold && out[1].1.italic && out[1].1.underline);
        assert!(!out[2].1.bold && !out[2].1.underline);
    }

    #[test]
    fn image_nodes_measure_to_aspect_size_and_paint_pixels() {
        let font = fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap();
        let dir = std::env::temp_dir().join("pixel-paint-image-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("solid.png");
        image::RgbaImage::from_pixel(4, 2, image::Rgba([0, 200, 0, 255]))
            .save(&path)
            .unwrap();

        let mut tree = Tree::new((100.0, 100.0));
        tree.reconcile(Desc {
            style: Style {
                align_items: Some(crate::style::Align::Start),
                ..Style::default()
            },
            children: vec![Desc {
                style: Style {
                    width: Dimension::Px(40.0),
                    ..Style::default()
                },
                image: Some(crate::tree::ImageProps {
                    src: path.to_string_lossy().to_string(),
                    equal_to: Vec::new(),
                }),
                ..Desc::default()
            }],
            ..Desc::default()
        });
        tree.flush_layout(std::slice::from_ref(&font), 16.0);
        let node = tree.children(tree.root())[0];
        let rect = tree.rect(node).unwrap();
        assert_eq!(
            rect.h, 0.0,
            "without a placeholder the image occupies nothing until decoded"
        );

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !crate::image_cache::drain_completed().landed {
            assert!(std::time::Instant::now() < deadline, "decode never landed");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        tree.mark_layout();
        tree.flush_layout(std::slice::from_ref(&font), 16.0);
        let rect = tree.rect(node).unwrap();
        assert_eq!(
            (rect.w, rect.h),
            (40.0, 20.0),
            "height follows aspect once the pixels are ready"
        );
        let mut canvas = Canvas::new(100, 100);
        paint(&tree, &mut canvas, std::slice::from_ref(&font), None);
        let center = &canvas.pixels[((10 * 100 + 20) * 4) as usize..][..4];
        assert_eq!(center, &[0, 200, 0, 255]);
        let outside = &canvas.pixels[((50 * 100 + 50) * 4) as usize..][..4];
        assert_eq!(outside, &[0, 0, 0, 0]);
    }

    #[test]
    fn recording_breaks_paint_into_buckets() {
        let font = fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap();
        let mut tree = Tree::new((300.0, 100.0));
        tree.reconcile(Desc {
            children: vec![Desc {
                style: Style {
                    width: Dimension::Px(300.0),
                    background: Some([20, 20, 20, 255]),
                    ..Style::default()
                },
                text: Some("hello breakdown".into()),
                ..Desc::default()
            }],
            ..Desc::default()
        });
        tree.flush_layout(std::slice::from_ref(&font), 16.0);
        let mut canvas = Canvas::new(300, 100);

        crate::profiler::start();
        paint(&tree, &mut canvas, std::slice::from_ref(&font), None);
        let data = crate::profiler::stop().unwrap();
        let names: Vec<&str> = data.spans.iter().map(|s| s.name).collect();
        assert!(names.contains(&"tree.paint"));
        assert!(names.contains(&"paint.rects"));
        assert!(names.contains(&"paint.glyphs"));
        let paint_span = data.spans.iter().find(|s| s.name == "tree.paint").unwrap();
        let glyphs = data
            .spans
            .iter()
            .find(|s| s.name == "paint.glyphs")
            .unwrap();
        assert_eq!(glyphs.depth, paint_span.depth + 1);
        assert_eq!(glyphs.arg, Some("hello breakdown".chars().count() as u64));
        let counted = data
            .counters
            .iter()
            .find(|c| c.name == "paint.nodes")
            .unwrap();
        assert_eq!(counted.value, 2, "root and the text node");
    }
}

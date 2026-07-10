use std::ops::Range;
use std::time::Instant;

use crate::canvas::{Canvas, measure_text};
use crate::style::{Color, Overflow};
use crate::text_input::{caret_width, offset_to_point};
use crate::tree::{NodeId, PxRect, Tree};
use crate::wrap::wrap_lines;

/// Where paint time went, measured only while a profile is recording and
/// reported as child spans of tree.paint. The buckets are aggregates across
/// all nodes, laid out sequentially rather than at their true times.
#[derive(Default)]
struct PaintStats {
    rects: f64,
    wrap: f64,
    glyphs: f64,
    selection: f64,
    bars: f64,
    nodes: u64,
    rect_count: u64,
    glyph_count: u64,
}

impl PaintStats {
    fn emit(self, start_ms: f64) {
        let mut at = start_ms;
        let buckets = [
            ("paint.rects", self.rects, Some(self.rect_count)),
            ("paint.wrap", self.wrap, None),
            ("paint.glyphs", self.glyphs, Some(self.glyph_count)),
            ("paint.selection", self.selection, None),
            ("paint.scrollbars", self.bars, None),
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
        paint_node(tree, tree.root(), canvas, fonts, cursor, &mut stats);
        if let (Some(stats), Some(start_ms)) = (stats, start_ms) {
            stats.emit(start_ms);
        }
    });
}

fn paint_node(
    tree: &Tree,
    id: NodeId,
    canvas: &mut Canvas,
    fonts: &[fontdue::Font],
    cursor: Option<(f32, f32)>,
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
                canvas.stroke_rounded_rect(
                    rect.x,
                    rect.y,
                    rect.w,
                    rect.h,
                    node.style.corner_radius,
                    border.width,
                    border.color,
                );
            }
        });
    }

    let clips_children = node.style.overflow != Overflow::Visible;
    if clips_children {
        canvas.push_clip(rect.x, rect.y, rect.w, rect.h);
    }

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
            let lines = timed(stats.as_mut().map(|s| &mut s.wrap), || {
                wrap_lines(text, font, px, wrap)
            });
            let line_h = line_metrics.new_line_size;
            if let Some(state) = &node.input
                && let Some(selection) = state.input.selection()
            {
                timed(stats.as_mut().map(|s| &mut s.selection), || {
                    paint_selection(
                        canvas,
                        text,
                        &lines,
                        &selection,
                        origin,
                        font,
                        px,
                        line_h,
                        visible,
                        state.selection_color,
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
                    canvas.draw_text(
                        font,
                        &text[line.clone()],
                        origin.0 as i32,
                        (top + line_metrics.ascent) as i32,
                        px,
                        color,
                    );
                }
            });
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
                let (x, y) = offset_to_point(text, state.input.cursor(), font, px, wrap);
                canvas.fill_rounded_rect(
                    origin.0 + x,
                    origin.1 + y,
                    caret_width(px),
                    line_h,
                    1.5,
                    state.caret_color,
                );
            }
        }
    }

    for &child in &node.children {
        paint_node(tree, child, canvas, fonts, cursor, stats);
    }
    timed(stats.as_mut().map(|s| &mut s.bars), || {
        paint_scrollbar(tree, id, canvas)
    });
    if clips_children {
        canvas.pop_clip();
    }
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
            rects.track.w / 2.0,
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
        rects.thumb.w / 2.0,
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
            let x1 = measure_text(font, &text[line.start..from], px);
            let mut x2 = measure_text(font, &text[line.start..to], px);
            if selection.end > line.end && text[line.end..].starts_with('\n') {
                x2 += newline_w;
            }
            canvas.fill_rounded_rect(origin.0 + x1, top, (x2 - x1).max(1.0), line_h, 0.0, color);
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

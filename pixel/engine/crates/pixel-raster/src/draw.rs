use std::collections::HashSet;

use pixel_core::fonts::Font;
use pixel_core::image_cache::{ImageStatus, with_scaled_image};
use pixel_core::scene::{Caret, Icon, Image, Item, Op, Scrollbar, Surface, Text, TextStyle};
use pixel_core::{CaretShape, Color, PxRect, caret_thickness};

use crate::canvas::Canvas;

const ITALIC_SHEAR: f32 = 0.22;

pub(crate) struct Skip<'a> {
    pub nodes: &'a HashSet<u64>,
    pub bar_of: u64,
}

pub(crate) struct Painter<'a> {
    pub canvas: &'a mut Canvas,
    pub fonts: &'a [Font],
    pub host_surfaces: bool,
    pub occluders: Vec<(u64, u32)>,
}

pub(crate) fn paint_scene(
    canvas: &mut Canvas,
    root: &Item,
    fonts: &[Font],
    host_surfaces: bool,
    clear: Option<(pixel_core::surfaces::Rect, Color)>,
    skip: Option<&Skip<'_>>,
) {
    pixel_core::profiler::span("tree.paint", || {
        let mut occluders = Vec::new();
        crate::opaque::collect_surface_occluders(root, None, canvas, &mut occluders);
        if let Some((region, color)) = clear {
            let alpha = u32::from(color[3]);
            let color = [
                ((u32::from(color[0]) * alpha + 127) / 255) as u8,
                ((u32::from(color[1]) * alpha + 127) / 255) as u8,
                ((u32::from(color[2]) * alpha + 127) / 255) as u8,
                color[3],
            ];
            pixel_core::profiler::span("canvas.clear", || canvas.fill_rect(region.x, region.y, region.w, region.h, color));
        }
        let mut painter = Painter { canvas, fonts, host_surfaces, occluders };
        painter.item(root, skip);
        painter.canvas.clear_occluders();
        let (boxes, skipped, paths, clipped) = crate::canvas::take_canvas_stats();
        pixel_core::profiler::count("paint.boxes", || boxes);
        pixel_core::profiler::count("paint.boxes.skipped", || skipped);
        pixel_core::profiler::count("paint.paths", || paths);
        pixel_core::profiler::count("paint.paths.clipped", || clipped);
    });
}

pub(crate) fn paint_subtree(canvas: &mut Canvas, item: &Item, fonts: &[Font], host_surfaces: bool) {
    let mut painter = Painter { canvas, fonts, host_surfaces, occluders: Vec::new() };
    painter.item(item, None);
    painter.canvas.clear_occluders();
}

impl Painter<'_> {
    pub(crate) fn item(&mut self, item: &Item, skip: Option<&Skip<'_>>) {
        for op in &item.ops {
            if matches!(op, Op::Surface(_))
                && let Some(at) = self.occluders.iter().position(|(n, _)| *n == item.node)
            {
                let (_, token) = self.occluders.swap_remove(at);
                self.canvas.remove_occluder(token);
            }
            self.op(op);
        }
        if item.clips {
            let r = item.bounds;
            self.canvas.push_clip(r.x, r.y, r.w, r.h);
        }
        for op in &item.inner {
            self.op(op);
        }
        for child in &item.children {
            if skip.is_some_and(|s| s.nodes.contains(&child.node)) {
                continue;
            }
            self.item(child, skip);
        }
        if skip.is_none_or(|s| s.bar_of != item.node) {
            for op in &item.after {
                self.op(op);
            }
        }
        if item.clips {
            self.canvas.pop_clip();
        }
    }

    pub(crate) fn op(&mut self, op: &Op) {
        let canvas = &mut *self.canvas;
        match op {
            Op::Rect { rect, radius, color } => canvas.fill_rounded_rect(rect.x, rect.y, rect.w, rect.h, *radius, *color),
            Op::Rule { rect, color } | Op::Selection { rect, color } => {
                canvas.fill_rounded_rect(rect.x, rect.y, rect.w, rect.h, [0.0; 4], *color)
            }
            Op::Gradient { rect, radius, gradient } => canvas.fill_rounded_rect_gradient(rect.x, rect.y, rect.w, rect.h, *radius, gradient),
            Op::Border { rect, radius, width, color } => canvas.stroke_rounded_rect(rect.x, rect.y, rect.w, rect.h, *radius, *width, *color),
            Op::Text(text) => self.text(text),
            Op::Caret(caret) => self.caret(caret),
            Op::Surface(surface) => self.surface(surface),
            Op::Image(image) => self.image(image),
            Op::Icon(icon) => self.icon(icon),
            Op::Scrollbar(bar) => scrollbar(canvas, bar),
            Op::Clip(rect) => canvas.push_clip(rect.x, rect.y, rect.w, rect.h),
            Op::Unclip => canvas.pop_clip(),
        }
    }

    fn text(&mut self, t: &Text) {
        let font = &self.fonts[t.font.min(self.fonts.len() - 1)];
        let face = &self.fonts[t.face.min(self.fonts.len() - 1)];
        let baseline = (t.top + t.ascent) as i32;
        let shear = if face.synthetic_italic { ITALIC_SHEAR } else { 0.0 };
        let passes = std::iter::once(0).chain(face.synthetic_bold.then(|| (t.px / 24.0).max(1.0) as i32));
        match t.style {
            TextStyle::Label => self.canvas.draw_text(font, &t.text, t.x as i32, baseline, t.px, t.color),
            TextStyle::Run => {
                for dx in passes {
                    self.canvas.draw_marked_sheared(face, &t.text, 0..t.text.len(), t.x as i32 + dx, baseline, t.px, t.color, &t.marks, shear);
                }
            }
            TextStyle::Span { underline, strikethrough } => {
                for dx in passes {
                    self.canvas.draw_fitted(face, font, &t.text, t.x as i32 + dx, baseline, t.px, t.color, shear);
                }
                let thickness = (t.px / 14.0).max(1.0);
                if underline {
                    self.canvas.fill_rounded_rect(t.x, t.top + t.ascent + thickness, t.width, thickness, [0.0; 4], t.color);
                }
                if strikethrough {
                    self.canvas.fill_rounded_rect(t.x, t.top + t.ascent - t.px * 0.28, t.width, thickness, [0.0; 4], t.color);
                }
            }
        }
    }

    fn caret(&mut self, c: &Caret) {
        let r = c.rect;
        match c.shape {
            CaretShape::Bar => self.canvas.fill_rounded_rect(r.x, r.y, r.w, r.h, [1.5; 4], c.color),
            CaretShape::Underscore => {
                let thickness = caret_thickness(c.px) / 2.0;
                self.canvas.fill_rounded_rect(r.x, r.y + r.h - thickness, r.w, thickness, [0.0; 4], c.color)
            }
            CaretShape::Block => {
                self.canvas.fill_rounded_rect(r.x, r.y, r.w, r.h, [0.0; 4], c.color);
                if let Some(under) = c.under
                    && c.color[3] > 0
                {
                    let font = &self.fonts[c.font.min(self.fonts.len() - 1)];
                    self.canvas.draw_text(font, under.encode_utf8(&mut [0; 4]), r.x.round() as i32, (r.y + c.ascent) as i32, c.px, ink_on(c.color));
                }
            }
        }
    }

    fn surface(&mut self, s: &Surface) {
        let rect = s.rect;
        if self.host_surfaces && s.empty {
            let hole = pixel_core::surfaces::Rect::covering(rect);
            self.canvas.fill_rect(hole.x, hole.y, hole.w, hole.h, [0, 0, 0, 0]);
        }
        let canvas = &mut *self.canvas;
        pixel_core::profiler::span("paint.surface", || {
            pixel_core::surfaces::with(s.surface, |pixels| {
                let unscaled = (rect.w.round().max(0.0) as u32, rect.h.round().max(0.0) as u32) == (pixels.width, pixels.height);
                if unscaled {
                    canvas.blit_bgra_rounded_hint(rect.x, rect.y, &pixels.pixels, pixels.width, pixels.height, s.radius);
                } else {
                    let mut rgba = pixels.pixels.clone();
                    for px in rgba.chunks_exact_mut(4) {
                        px.swap(0, 2);
                    }
                    canvas.blit_scaled_rgba_rounded(rect.x, rect.y, rect.w, rect.h, &rgba, pixels.width, pixels.height, s.radius);
                }
            });
        });
    }

    fn image(&mut self, i: &Image) {
        let rect = i.rect;
        match i.status {
            ImageStatus::Ready => {
                let canvas = &mut *self.canvas;
                with_scaled_image(&i.src, rect.w.round().max(0.0) as u32, rect.h.round().max(0.0) as u32, i.radius, &i.equal_to, |pixmap| {
                    canvas.blit_image(rect.x, rect.y, pixmap)
                });
            }
            ImageStatus::Failed if i.broken_icon => broken_image(self.canvas, rect, i.px, i.color),
            ImageStatus::Failed | ImageStatus::Pending => {}
        }
    }

    fn icon(&mut self, icon: &Icon) {
        let rect = icon.rect;
        let props = &icon.path;
        let scale = match props.view_box {
            Some(view_box) if view_box > 0.0 => rect.w.min(rect.h) / view_box,
            _ => 1.0,
        };
        if scale <= 0.0 {
            return;
        }
        let Some(path) = pixel_core::build_path(&props.cmds) else { return };
        let to_screen = tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, rect.x, rect.y);
        let Some(path) = path.transform(to_screen) else { return };
        self.canvas.stroke_path(&path, props.stroke.color, pixel_core::skia_stroke(&props.stroke, scale));
    }
}

pub(crate) fn scrollbar(canvas: &mut Canvas, bar: &Scrollbar) {
    if let Some((track, color)) = bar.track {
        canvas.fill_rounded_rect(track.x, track.y, track.w, track.h, [track.w / 2.0; 4], color);
    }
    let (thumb, color) = bar.thumb;
    canvas.fill_rounded_rect(thumb.x, thumb.y, thumb.w, thumb.h, [thumb.w / 2.0; 4], color);
}

fn ink_on(color: Color) -> Color {
    let [r, g, b, a] = color;
    let luma = 0.299 * f32::from(r) + 0.587 * f32::from(g) + 0.114 * f32::from(b);
    if luma > 150.0 { [0, 0, 0, a] } else { [255, 255, 255, a] }
}

fn broken_image(canvas: &mut Canvas, rect: PxRect, px: f32, color: Color) {
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
    canvas.fill_rounded_rect(x + side * 0.3 - dot / 2.0, y + side * 0.34 - dot / 2.0, dot, dot, [dot; 4], muted);
}

use std::ops::Range;

use crate::canvas::Canvas;
use crate::fonts::Font;
use crate::image_cache::ImageStatus;
use crate::scene::{ImageState, RectKind, Scene, SceneOp, TextRun};
use crate::style::{Color, LinearGradient};
use crate::text_input::{CaretShape, Mark, caret_thickness};
use crate::tree::{ImageProps, PxRect};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum GlyphStyle {
    Marked,
    Fitted { underline: bool, strikethrough: bool },
    Plain,
}

pub(crate) struct Glyphs<'a> {
    pub font: &'a Font,
    pub face: &'a Font,
    pub text: &'a str,
    pub range: Range<usize>,
    pub x: f32,
    pub top: f32,
    pub ascent: f32,
    pub width: f32,
    pub px: f32,
    pub color: Color,
    pub marks: &'a [Mark],
    pub style: GlyphStyle,
}

pub(crate) struct CaretDraw<'a> {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub line_h: f32,
    pub ascent: f32,
    pub shape: CaretShape,
    pub color: Color,
    pub under: Option<char>,
    pub font: &'a Font,
    pub px: f32,
}

pub(crate) struct ImageDraw<'a> {
    pub rect: PxRect,
    pub radius: [f32; 4],
    pub image: &'a ImageProps,
    pub status: ImageStatus,
    pub broken_icon: bool,
    pub px: f32,
    pub color: Color,
}

pub(crate) trait Painter {
    fn clip_push(&mut self, rect: PxRect);
    fn clip_pop(&mut self);
    fn rect(&mut self, rect: PxRect, radius: [f32; 4], color: Color, kind: RectKind);
    fn gradient(&mut self, rect: PxRect, radius: [f32; 4], gradient: &LinearGradient);
    fn border(&mut self, rect: PxRect, radius: [f32; 4], width: f32, color: Color);
    fn glyphs(&mut self, glyphs: &Glyphs<'_>);
    fn caret(&mut self, caret: &CaretDraw<'_>);
    fn surface(&mut self, rect: PxRect, radius: [f32; 4], surface: u32, hole: bool);
    fn image(&mut self, image: &ImageDraw<'_>);
    fn shape(&mut self, rect: PxRect, props: &crate::shape::ShapeProps);
    fn remove_occluder(&mut self, _token: u32) {}
}

const ITALIC_SHEAR: f32 = 0.22;

fn bold_passes(font: &Font, px: f32) -> impl Iterator<Item = i32> {
    std::iter::once(0).chain(font.synthetic_bold.then(|| (px / 24.0).max(1.0) as i32))
}

impl Painter for Canvas {
    fn clip_push(&mut self, rect: PxRect) {
        self.push_clip(rect.x, rect.y, rect.w, rect.h);
    }

    fn clip_pop(&mut self) {
        self.pop_clip();
    }

    fn rect(&mut self, rect: PxRect, radius: [f32; 4], color: Color, _kind: RectKind) {
        self.fill_rounded_rect(rect.x, rect.y, rect.w, rect.h, radius, color);
    }

    fn gradient(&mut self, rect: PxRect, radius: [f32; 4], gradient: &LinearGradient) {
        self.fill_rounded_rect_gradient(rect.x, rect.y, rect.w, rect.h, radius, gradient);
    }

    fn border(&mut self, rect: PxRect, radius: [f32; 4], width: f32, color: Color) {
        self.stroke_rounded_rect(rect.x, rect.y, rect.w, rect.h, radius, width, color);
    }

    fn glyphs(&mut self, g: &Glyphs<'_>) {
        let baseline = (g.top + g.ascent) as i32;
        let shear = if g.face.synthetic_italic { ITALIC_SHEAR } else { 0.0 };
        match g.style {
            GlyphStyle::Plain => {
                self.draw_text(g.font, &g.text[g.range.clone()], g.x as i32, baseline, g.px, g.color);
            }
            GlyphStyle::Marked => {
                for dx in bold_passes(g.face, g.px) {
                    self.draw_marked_sheared(g.face, g.text, g.range.clone(), g.x as i32 + dx, baseline, g.px, g.color, g.marks, shear);
                }
            }
            GlyphStyle::Fitted { underline, strikethrough } => {
                let segment = &g.text[g.range.clone()];
                for dx in bold_passes(g.face, g.px) {
                    self.draw_fitted(g.face, g.font, segment, g.x as i32 + dx, baseline, g.px, g.color, shear);
                }
                let thickness = (g.px / 14.0).max(1.0);
                if underline {
                    self.fill_rounded_rect(g.x, g.top + g.ascent + thickness, g.width, thickness, [0.0; 4], g.color);
                }
                if strikethrough {
                    self.fill_rounded_rect(g.x, g.top + g.ascent - g.px * 0.28, g.width, thickness, [0.0; 4], g.color);
                }
            }
        }
    }

    fn caret(&mut self, c: &CaretDraw<'_>) {
        match c.shape {
            CaretShape::Bar => self.fill_rounded_rect(c.left, c.top, c.width, c.line_h, [1.5; 4], c.color),
            CaretShape::Underscore => {
                let thickness = caret_thickness(c.px) / 2.0;
                self.fill_rounded_rect(c.left, c.top + c.line_h - thickness, c.width, thickness, [0.0; 4], c.color)
            }
            CaretShape::Block => {
                self.fill_rounded_rect(c.left, c.top, c.width, c.line_h, [0.0; 4], c.color);
                if let Some(under) = c.under
                    && c.color[3] > 0
                {
                    self.draw_text(
                        c.font,
                        under.encode_utf8(&mut [0; 4]),
                        c.left.round() as i32,
                        (c.top + c.ascent) as i32,
                        c.px,
                        ink_on(c.color),
                    );
                }
            }
        }
    }

    fn surface(&mut self, rect: PxRect, radius: [f32; 4], surface: u32, hole: bool) {
        if hole {
            let hole = crate::surfaces::Rect::covering(rect);
            self.fill_rect(hole.x, hole.y, hole.w, hole.h, [0, 0, 0, 0]);
        }
        crate::surfaces::with(surface, |s| {
            let unscaled = (rect.w.round().max(0.0) as u32, rect.h.round().max(0.0) as u32) == (s.width, s.height);
            if unscaled {
                self.blit_bgra_rounded_hint(rect.x, rect.y, &s.pixels, s.width, s.height, radius);
            } else {
                let mut rgba = s.pixels.clone();
                for px in rgba.chunks_exact_mut(4) {
                    px.swap(0, 2);
                }
                self.blit_scaled_rgba_rounded(rect.x, rect.y, rect.w, rect.h, &rgba, s.width, s.height, radius);
            }
        });
    }

    fn image(&mut self, i: &ImageDraw<'_>) {
        let rect = i.rect;
        match i.status {
            ImageStatus::Ready => {
                crate::image_cache::with_scaled_image(
                    &i.image.src,
                    rect.w.round().max(0.0) as u32,
                    rect.h.round().max(0.0) as u32,
                    i.radius,
                    &i.image.equal_to,
                    |pixmap| self.blit_image(rect.x, rect.y, pixmap),
                );
            }
            ImageStatus::Failed if i.broken_icon => paint_broken_image(self, rect, i.px, i.color),
            ImageStatus::Failed | ImageStatus::Pending => {}
        }
    }

    fn shape(&mut self, rect: PxRect, props: &crate::shape::ShapeProps) {
        let scale = match props.view_box {
            Some(view_box) if view_box > 0.0 => rect.w.min(rect.h) / view_box,
            _ => 1.0,
        };
        if scale <= 0.0 {
            return;
        }
        let Some(path) = crate::shape::build_path(&props.cmds) else {
            return;
        };
        let to_screen = tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, rect.x, rect.y);
        let Some(path) = path.transform(to_screen) else {
            return;
        };
        self.stroke_path(&path, props.stroke.color, crate::shape::skia_stroke(&props.stroke, scale));
    }

    fn remove_occluder(&mut self, token: u32) {
        Canvas::remove_occluder(self, token);
    }
}

pub(crate) fn ink_on(color: Color) -> Color {
    let [r, g, b, a] = color;
    let luma = 0.299 * f32::from(r) + 0.587 * f32::from(g) + 0.114 * f32::from(b);
    if luma > 150.0 { [0, 0, 0, a] } else { [255, 255, 255, a] }
}

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
    canvas.fill_rounded_rect(x + side * 0.3 - dot / 2.0, y + side * 0.34 - dot / 2.0, dot, dot, [dot; 4], muted);
}

#[derive(Default)]
pub struct SceneRecorder {
    pub scene: Scene,
}

impl Painter for SceneRecorder {
    fn clip_push(&mut self, rect: PxRect) {
        self.scene.ops.push(SceneOp::PushClip(rect));
    }

    fn clip_pop(&mut self) {
        self.scene.ops.push(SceneOp::PopClip);
    }

    fn rect(&mut self, rect: PxRect, radius: [f32; 4], color: Color, kind: RectKind) {
        if color[3] > 0 {
            self.scene.ops.push(SceneOp::Rect { rect, radius, color, kind });
        }
    }

    fn gradient(&mut self, rect: PxRect, radius: [f32; 4], gradient: &LinearGradient) {
        self.scene.ops.push(SceneOp::Gradient { rect, radius, gradient: gradient.clone() });
    }

    fn border(&mut self, rect: PxRect, radius: [f32; 4], width: f32, color: Color) {
        if color[3] > 0 && width > 0.0 {
            self.scene.ops.push(SceneOp::Border { rect, radius, width, color });
        }
    }

    fn glyphs(&mut self, g: &Glyphs<'_>) {
        let (underline, strikethrough) = match g.style {
            GlyphStyle::Fitted { underline, strikethrough } => (underline, strikethrough),
            _ => (false, false),
        };
        let gaps = g
            .marks
            .iter()
            .filter(|m| g.range.contains(&m.offset))
            .map(|m| (m.offset - g.range.start, m.advance))
            .collect();
        self.scene.ops.push(SceneOp::Text(TextRun {
            text: g.text[g.range.clone()].to_string(),
            x: g.x,
            top: g.top,
            color: g.color,
            bold: g.face.bold,
            italic: g.face.italic,
            underline,
            strikethrough,
            gaps,
        }));
    }

    fn caret(&mut self, c: &CaretDraw<'_>) {
        self.scene.ops.push(SceneOp::Caret {
            rect: PxRect { x: c.left, y: c.top, w: c.width, h: c.line_h },
            shape: c.shape,
            color: c.color,
        });
    }

    fn surface(&mut self, rect: PxRect, _radius: [f32; 4], _surface: u32, _hole: bool) {
        self.scene.ops.push(SceneOp::Surface { rect });
    }

    fn image(&mut self, i: &ImageDraw<'_>) {
        let state = match i.status {
            ImageStatus::Ready => ImageState::Ready,
            ImageStatus::Pending => ImageState::Pending,
            ImageStatus::Failed => ImageState::Failed,
        };
        self.scene.ops.push(SceneOp::Image {
            rect: i.rect,
            src: i.image.src.clone(),
            equal_to: i.image.equal_to.clone(),
            state,
            fallback: i.image.fallback.clone(),
            color: i.color,
        });
    }

    fn shape(&mut self, rect: PxRect, props: &crate::shape::ShapeProps) {
        self.scene.ops.push(SceneOp::Shape { rect, color: props.stroke.color, fallback: props.fallback.clone() });
    }
}

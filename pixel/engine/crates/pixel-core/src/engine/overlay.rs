use super::{Engine, EngineEvent};
use crate::canvas::{Canvas, measure_text};
use crate::style::{Color, Edges};
use crate::tree::{NodeId, PxRect};

const CONTENT_FILL: Color = [111, 168, 220, 150];
const PADDING_FILL: Color = [147, 196, 125, 140];
const BORDER_FILL: Color = [255, 229, 153, 150];
const MARGIN_FILL: Color = [246, 178, 107, 150];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HighlightArea {
    #[default]
    All,
    Content,
    Padding,
    Border,
    Margin,
}

impl Engine {
    pub(super) fn finish_inspect(&mut self, local: (f32, f32), out: &mut Vec<EngineEvent>) {
        self.inspect_mode = false;
        let view = self.inspect_view;
        let node = self
            .inspect_hover
            .take()
            .or_else(|| self.comp.views[view].tree.hit_any(local.0, local.1));
        self.comp.dirty = true;
        let Some(node) = node else {
            return;
        };
        out.push(EngineEvent::Inspect {
            view,
            node,
            key: self.comp.views[view].tree.key_of(node).map(str::to_string),
            x: local.0,
            y: local.1,
        });
    }

    pub(super) fn draw_node_overlay(&mut self, view: usize, id: NodeId, area: HighlightArea, with_label: bool) {
        if !self.comp.is_active(view) {
            return;
        }
        let Some(v) = self.comp.views.get(view) else {
            return;
        };
        let Some(visible) = v.tree.visible_rect(id) else {
            return;
        };
        if visible.w <= 0.0 || visible.h <= 0.0 {
            return;
        }
        let Some(abs) = v.tree.rect(id) else {
            return;
        };
        let metrics = v.tree.box_metrics(id).unwrap_or_default();
        let key = v.tree.key_of(id).map(str::to_string);
        let clip = PxRect {
            x: v.origin_x as f32,
            y: 0.0,
            w: v.size.0 as f32,
            h: v.size.1 as f32,
        };
        let border_box = PxRect {
            x: abs.x + v.origin_x as f32,
            y: abs.y,
            w: abs.w,
            h: abs.h,
        };
        let padding_box = inset(border_box, metrics.border);
        let content_box = inset(padding_box, metrics.padding);
        let margin_box = outset(border_box, metrics.margin);
        let frame = &mut self.comp.frame;
        match area {
            HighlightArea::All => {
                fill_clipped(frame, content_box, clip, CONTENT_FILL);
                fill_ring(frame, padding_box, content_box, clip, PADDING_FILL);
                fill_ring(frame, border_box, padding_box, clip, BORDER_FILL);
                fill_ring(frame, margin_box, border_box, clip, MARGIN_FILL);
            }
            HighlightArea::Content => fill_clipped(frame, content_box, clip, CONTENT_FILL),
            HighlightArea::Padding => fill_ring(frame, padding_box, content_box, clip, PADDING_FILL),
            HighlightArea::Border => fill_ring(frame, border_box, padding_box, clip, BORDER_FILL),
            HighlightArea::Margin => fill_ring(frame, margin_box, border_box, clip, MARGIN_FILL),
        }
        if !with_label {
            return;
        }
        let px = self.base_px * 0.85;
        let label = match key {
            Some(key) => format!("{key}  {:.0} × {:.0}", abs.w, abs.h),
            None => format!("{:.0} × {:.0}", abs.w, abs.h),
        };
        let font = &self.fonts[0];
        let text_w = measure_text(font, &label, px);
        let line_h = crate::text_input::line_height(font, px);
        let pad = px * 0.4;
        let (w, h) = (text_w + pad * 2.0, line_h + pad);
        let lx = border_box.x.min(self.comp.window.0 as f32 - w).max(0.0);
        let mut ly = border_box.y + border_box.h + 4.0;
        if ly + h > self.comp.window.1 as f32 {
            ly = (border_box.y - h - 4.0).max(0.0);
        }
        self.comp.frame
            .fill_rounded_rect(lx, ly, w, h, [4.0; 4], [24, 26, 32, 245]);
        self.comp.frame
            .stroke_rounded_rect(lx, ly, w, h, [4.0; 4], 1.0, [72, 75, 86, 255]);
        if let Some(metrics) = font.horizontal_line_metrics(px) {
            self.comp.frame.draw_text(
                font,
                &label,
                (lx + pad) as i32,
                (ly + pad / 2.0 + metrics.ascent) as i32,
                px,
                [186, 210, 255, 255],
            );
        }
    }
}

fn inset(r: PxRect, e: Edges) -> PxRect {
    PxRect {
        x: r.x + e.left,
        y: r.y + e.top,
        w: (r.w - e.left - e.right).max(0.0),
        h: (r.h - e.top - e.bottom).max(0.0),
    }
}

fn outset(r: PxRect, e: Edges) -> PxRect {
    PxRect {
        x: r.x - e.left,
        y: r.y - e.top,
        w: r.w + e.left + e.right,
        h: r.h + e.top + e.bottom,
    }
}

fn fill_clipped(frame: &mut Canvas, rect: PxRect, clip: PxRect, color: Color) {
    let r = rect.intersect(clip);
    if r.w > 0.0 && r.h > 0.0 {
        frame.fill_rounded_rect(r.x, r.y, r.w, r.h, [0.0; 4], color);
    }
}

fn fill_ring(frame: &mut Canvas, outer: PxRect, inner: PxRect, clip: PxRect, color: Color) {
    let strips = [
        PxRect {
            x: outer.x,
            y: outer.y,
            w: outer.w,
            h: inner.y - outer.y,
        },
        PxRect {
            x: outer.x,
            y: inner.y + inner.h,
            w: outer.w,
            h: (outer.y + outer.h) - (inner.y + inner.h),
        },
        PxRect {
            x: outer.x,
            y: inner.y,
            w: inner.x - outer.x,
            h: inner.h,
        },
        PxRect {
            x: inner.x + inner.w,
            y: inner.y,
            w: (outer.x + outer.w) - (inner.x + inner.w),
            h: inner.h,
        },
    ];
    for strip in strips {
        fill_clipped(frame, strip, clip, color);
    }
}

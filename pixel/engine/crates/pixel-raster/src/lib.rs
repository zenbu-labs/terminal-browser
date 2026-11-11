mod canvas;
mod draw;
mod glyphs;
mod layer;
mod opaque;
#[cfg(test)]
mod tree_tests;

use pixel_core::Color;
use pixel_core::fonts::Font;
use pixel_core::scene::{Damage, Divider, Frame, Item};
use pixel_core::surfaces::{OpaqueArea, Rect, SurfaceCover, SurfaceLayout, SurfacePlacement};

pub use canvas::{Canvas, Overlay, Pixels, PixelFrame, ScrollLayer};
pub use layer::{LayerCanvases, render_layer, scroll_layer};
pub use opaque::{Opaque, opaque_areas, surface_covers};

const DIVIDER_BG: Color = [32, 33, 38, 255];
const DIVIDER_BG_ACTIVE: Color = [58, 96, 168, 255];
const DIVIDER_GRIP: Color = [118, 122, 132, 255];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RasterOptions {
    pub scroll_layer: bool,
    pub direct: bool,
    pub host_surfaces: bool,
}

#[derive(Default)]
struct ViewPixels {
    canvas: Canvas,
    opaque: Vec<OpaqueArea>,
    ui_over_surfaces: Vec<Rect>,
    layer: Option<ScrollLayer>,
    layer_canvases: Option<LayerCanvases>,
}

struct Painted {
    view: usize,
    parts: Vec<Rect>,
    whole: bool,
    surface_parts: Vec<Rect>,
}

#[derive(Default)]
pub struct Raster {
    views: Vec<ViewPixels>,
    frame: Canvas,
    changed: Vec<Rect>,
    repainted: Vec<Rect>,
    direct: Option<usize>,
    opaque: Vec<OpaqueArea>,
    ui_over_surfaces: Vec<Rect>,
    layer: Option<ScrollLayer>,
    surface_layout: Option<SurfaceLayout>,
    last_divider: Option<(u32, bool)>,
}

impl Raster {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn render(&mut self, frame: &Frame<'_>, options: RasterOptions) -> PixelFrame<'_> {
        let mut painted = Vec::new();
        for view in frame.views {
            if self.views.len() <= view.view {
                self.views.resize_with(view.view + 1, ViewPixels::default);
            }
            let (parts, whole, surface_parts) = match view.damage {
                Damage::None => continue,
                Damage::Whole { surfaces } => (vec![Rect::sized(view.size.0, view.size.1)], true, surfaces.to_vec()),
                Damage::Parts(parts) => (parts.to_vec(), false, Vec::new()),
            };
            if view.size.0 == 0 || view.size.1 == 0 {
                continue;
            }
            pixel_core::profiler::set_view(view.view as u32);
            let pixels = &mut self.views[view.view];
            if (pixels.canvas.width, pixels.canvas.height) != view.size {
                pixels.canvas = Canvas::new(view.size.0, view.size.1);
            }
            let root = &view.scene.root;
            pixel_core::profiler::count("paint.px", || parts.iter().map(|p| p.area()).sum());
            for part in &parts {
                pixels.canvas.push_clip(part.x as f32, part.y as f32, part.w as f32, part.h as f32);
                draw::paint_scene(&mut pixels.canvas, root, frame.fonts, options.host_surfaces, Some((*part, view.clear)), None);
                pixels.canvas.pop_clip();
            }
            let opaque = opaque_areas(root);
            pixels.opaque = opaque.areas;
            pixels.ui_over_surfaces = opaque.ui_over_surfaces;
            pixels.layer = options.scroll_layer.then(|| scroll_layer(root)).flatten().map(|plan| {
                pixel_core::profiler::span("paint.layer", || {
                    let canvases = pixels.layer_canvases.get_or_insert_with(|| LayerCanvases::new(view.size.0, view.size.1));
                    if canvases.size() != view.size {
                        *canvases = LayerCanvases::new(view.size.0, view.size.1);
                    }
                    render_layer(root, &plan, canvases, frame.fonts, options.host_surfaces, view.clear)
                })
            });
            painted.push(Painted { view: view.view, parts, whole, surface_parts });
        }
        pixel_core::profiler::set_view(0);
        let overlays = !frame.overlay.is_empty();
        pixel_core::profiler::span("compose", || {
            self.compose(frame, &painted, overlays || frame.relayout, options.direct);
            if overlays {
                let mut painter = draw::Painter { canvas: &mut self.frame, fonts: frame.fonts, host_surfaces: options.host_surfaces, occluders: Vec::new() };
                for op in frame.overlay {
                    painter.op(op);
                }
            }
        });
        if options.host_surfaces {
            self.place_surfaces(frame);
        }
        self.last()
    }

    pub fn last(&self) -> PixelFrame<'_> {
        PixelFrame {
            canvas: self.direct.map_or(&self.frame, |view| &self.views[view].canvas),
            premultiplied: self.direct.is_some(),
            changed: &self.changed,
            repainted: &self.repainted,
            opaque: &self.opaque,
            ui_over_surfaces: &self.ui_over_surfaces,
            layer: self.layer.as_ref(),
            surfaces: self.surface_layout.as_ref(),
        }
    }

    pub fn warm_glyphs(fonts: &[Font], until: std::time::Instant) {
        if canvas::glyphs_to_warm() {
            canvas::warm_glyphs(fonts, until);
        }
    }

    fn compose(&mut self, frame: &Frame<'_>, painted: &[Painted], whole_frame: bool, direct: bool) {
        let window = frame.window;
        let resized = (self.frame.width, self.frame.height) != window;
        if resized {
            self.frame = Canvas::new(window.0, window.1);
        }
        let everything = resized || whole_frame;
        let alone = match frame.views {
            [only] => only.origin_x == 0 && only.size == window && !everything && direct,
            _ => false,
        };
        self.direct = alone.then(|| frame.views[0].view);
        self.changed.clear();
        self.repainted.clear();
        let mut divider = None;
        if !alone {
            for view in frame.views {
                let size = view.size;
                let origin = view.origin_x;
                let straighten = view.clear[3] < 255;
                let Some(pixels) = self.views.get(view.view) else { continue };
                if everything {
                    blit(&mut self.frame, &pixels.canvas, origin, Rect::sized(size.0, size.1), straighten);
                    continue;
                }
                let Some(p) = painted.iter().find(|p| p.view == view.view) else {
                    continue;
                };
                pixel_core::profiler::count("compose.px", || p.parts.iter().map(|r| r.area()).sum());
                for part in &p.parts {
                    blit(&mut self.frame, &pixels.canvas, origin, *part, straighten);
                }
            }
            divider = frame.divider.and_then(|d| self.draw_divider(d));
        }
        if frame.divider.is_none() {
            self.last_divider = None;
        }
        self.collect_opaque(frame);
        let (width, height) = (self.frame.width, self.frame.height);
        if everything {
            self.repainted.push(Rect::sized(width, height));
            return;
        }
        for p in painted {
            let origin = frame.views.iter().find(|v| v.view == p.view).map_or(0, |v| v.origin_x);
            let moved = |part: &Rect| Rect { x: part.x + origin, ..*part }.clamped(width, height);
            if p.whole {
                let size = frame.views.iter().find(|v| v.view == p.view).map_or((0, 0), |v| v.size);
                self.repainted.push(moved(&Rect::sized(size.0, size.1)));
                self.changed.extend(p.surface_parts.iter().map(moved).filter(|r| !r.is_empty()));
            } else {
                self.changed.extend(p.parts.iter().map(moved).filter(|r| !r.is_empty()));
            }
        }
        self.changed.extend(divider);
    }

    fn collect_opaque(&mut self, frame: &Frame<'_>) {
        self.opaque.clear();
        self.ui_over_surfaces.clear();
        self.layer = match frame.views {
            [only] if self.direct == Some(only.view) => self.views.get(only.view).and_then(|v| v.layer.clone()),
            _ => None,
        };
        for view in frame.views {
            let Some(pixels) = self.views.get(view.view) else { continue };
            let origin = view.origin_x;
            for area in &pixels.opaque {
                let moved = Rect { x: area.rect.x + origin, ..area.rect }.clamped(self.frame.width, self.frame.height);
                if !moved.is_empty() {
                    self.opaque.push(OpaqueArea { surface: area.surface, rect: moved });
                }
            }
            for rect in &pixels.ui_over_surfaces {
                let moved = Rect { x: rect.x + origin, ..*rect }.clamped(self.frame.width, self.frame.height);
                if !moved.is_empty() {
                    self.ui_over_surfaces.push(moved);
                }
            }
        }
    }

    fn draw_divider(&mut self, divider: Divider) -> Option<Rect> {
        let Divider { x: dx, width, engaged } = divider;
        let bg = if engaged { DIVIDER_BG_ACTIVE } else { DIVIDER_BG };
        let height = self.frame.height;
        self.frame.fill_rect(dx, 0, width, height, bg);
        let cx = dx as f32 + width as f32 / 2.0;
        let cy = height as f32 / 2.0;
        for i in -1..=1i32 {
            self.frame.fill_rounded_rect(cx - 1.0, cy + (i as f32) * 7.0 - 1.0, 2.0, 2.0, [1.0; 4], DIVIDER_GRIP);
        }
        let changed = self.last_divider != Some((dx, engaged));
        self.last_divider = Some((dx, engaged));
        changed.then_some(Rect { x: dx, y: 0, w: width, h: height })
    }

    fn place_surfaces(&mut self, frame: &Frame<'_>) {
        let rect = |r: pixel_core::PxRect, origin: f32| [r.x + origin, r.y, r.w, r.h];
        let mut layout = SurfaceLayout::default();
        for view in frame.views {
            let origin = view.origin_x as f32;
            let mut found = Vec::new();
            surface_items(&view.scene.root, None, &mut found);
            if found.is_empty() {
                continue;
            }
            layout.placements.extend(found.iter().map(|(surface, abs, visible)| SurfacePlacement {
                surface: *surface,
                rect: rect(*abs, origin),
                visible: rect(*visible, origin),
            }));
            layout.covers.extend(surface_covers(&view.scene.root).into_iter().map(|(surface, r, opaque)| SurfaceCover { surface, rect: rect(r, origin), opaque }));
        }
        self.surface_layout = Some(layout);
    }
}

fn surface_items(item: &Item, clip: Option<pixel_core::PxRect>, out: &mut Vec<(u32, pixel_core::PxRect, pixel_core::PxRect)>) {
    if let Some(surface) = item.surface {
        out.push((surface, item.bounds, clip.map_or(item.bounds, |c| item.bounds.intersect(c))));
    }
    let inner = if item.clips { Some(clip.map_or(item.bounds, |c| c.intersect(item.bounds))) } else { clip };
    for child in &item.children {
        surface_items(child, inner, out);
    }
}

fn blit(dst: &mut Canvas, src: &Canvas, origin_x: u32, region: Rect, straighten: bool) {
    let region = region.clamped(src.width, src.height);
    let dst_x = origin_x + region.x;
    if region.is_empty() || dst_x >= dst.width || region.y >= dst.height {
        return;
    }
    let cols = (region.w.min(dst.width - dst_x)) as usize * 4;
    let rows = region.h.min(dst.height - region.y) as usize;
    let src_stride = src.width as usize * 4;
    let dst_stride = dst.width as usize * 4;
    let src_col = region.x as usize * 4;
    let dst_col = dst_x as usize * 4;
    let y0 = region.y as usize;
    let dst_rows = &mut dst.pixels[y0 * dst_stride..(y0 + rows) * dst_stride];
    pixel_core::parallel::row_bands(
        dst_rows,
        dst_stride,
        rows,
        cols / 4,
        1 << 20,
        |band, first, count| {
            for r in 0..count {
                let src_start = (y0 + first + r) * src_stride + src_col;
                let dst_start = r * dst_stride + dst_col;
                let row = &mut band[dst_start..dst_start + cols];
                row.copy_from_slice(&src.pixels[src_start..src_start + cols]);
                if straighten {
                    for px in row.chunks_exact_mut(4) {
                        let a = px[3];
                        if a != 0 && a != 255 {
                            for c in &mut px[..3] {
                                *c = ((u32::from(*c) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8;
                            }
                        }
                    }
                }
            }
        },
        |(), ()| (),
    );
}

#[cfg(test)]
mod tests {
    pub(crate) fn fonts() -> pixel_core::fonts::FontRegistry {
        let face = |bytes: &[u8]| fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).unwrap();
        pixel_core::fonts::FontRegistry::new(
            face(include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf")),
            face(include_bytes!("../../../assets/fonts/InterVariable.ttf")),
        )
    }
}

use pixel_core::CaretShape;
use pixel_core::scene::{ImageState, RectKind, SceneOp, TextRun, ViewScene};
use pixel_core::{LinearGradient, MARK_CHAR, PxRect};
use unicode_segmentation::UnicodeSegmentation;

use crate::color::{ColorTier, Palette, blend, distance};
use crate::grid::{BOLD, CellGrid, INVERSE, ITALIC, Rgb, STRIKETHROUGH, UNDERLINE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caret {
    pub x: u16,
    pub y: u16,
    pub shape: CaretShape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Area {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

impl Area {
    fn intersect(self, other: Area) -> Area {
        Area { x0: self.x0.max(other.x0), y0: self.y0.max(other.y0), x1: self.x1.min(other.x1), y1: self.y1.min(other.y1) }
    }

    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x0 && x < self.x1 && y >= self.y0 && y < self.y1
    }

    fn is_empty(&self) -> bool {
        self.x1 <= self.x0 || self.y1 <= self.y0
    }
}

// fixme: placeholder copy
const WEB_VIEW_LABEL: &str = "web view";
// fixme: placeholder copy
const IMAGE_LABEL: &str = "image";

const MONO_HIGHLIGHT_DISTANCE: u32 = 6000;

pub struct ScenePainter<'a> {
    grid: &'a mut CellGrid,
    palette: &'a Palette,
    cell: (f32, f32),
    origin: (i32, i32),
    clips: Vec<Area>,
    caret: Option<Caret>,
}

pub fn paint_view(grid: &mut CellGrid, palette: &Palette, cell: (f32, f32), view: &ViewScene<'_>) -> Option<Caret> {
    let origin = ((view.origin.0 as f32 / cell.0).round() as i32, (view.origin.1 as f32 / cell.1).round() as i32);
    let bounds = Area {
        x0: origin.0,
        y0: origin.1,
        x1: (origin.0 + (view.size.0 as f32 / cell.0).round() as i32).min(grid.width as i32),
        y1: (origin.1 + (view.size.1 as f32 / cell.1).round() as i32).min(grid.height as i32),
    };
    let mut painter = ScenePainter { grid, palette, cell, origin, clips: vec![bounds], caret: None };
    let clear = if view.clear[3] == 0 { [palette.background[0], palette.background[1], palette.background[2], 255] } else { view.clear };
    painter.fill(bounds, clear, false);
    let ops = &view.scene.ops;
    let mut bordered = None;
    for (i, op) in ops.iter().enumerate() {
        match (op, ops.get(i + 1)) {
            (SceneOp::Rect { rect, color, kind: RectKind::Fill, .. }, Some(SceneOp::Border { rect: border, .. })) if rect == border => {
                painter.inside_border(*rect, *color);
            }
            (SceneOp::PushClip(rect), _) if bordered == Some(*rect) => painter.clip_inside_border(*rect),
            _ => painter.op(op),
        }
        bordered = match op {
            SceneOp::Border { rect, .. } => Some(*rect),
            _ => None,
        };
    }
    painter.caret
}

pub fn finish(grid: &mut CellGrid, palette: &Palette) {
    let mut last_fg: Option<(Rgb, crate::color::CellColor)> = None;
    let mut last_bg: Option<(Rgb, crate::color::CellColor)> = None;
    for i in 0..grid.len() {
        let fg = grid.fg_rgb[i];
        grid.fg[i] = match last_fg {
            Some((rgb, color)) if rgb == fg => color,
            _ => {
                let color = palette.fg(fg);
                last_fg = Some((fg, color));
                color
            }
        };
        let bg = grid.bg_rgb[i];
        grid.bg[i] = match last_bg {
            Some((rgb, color)) if rgb == bg => color,
            _ => {
                let color = palette.bg(bg);
                last_bg = Some((bg, color));
                color
            }
        };
    }
}

impl ScenePainter<'_> {
    fn clip(&self) -> Area {
        *self.clips.last().expect("the view bounds are always on the clip stack")
    }

    fn col(&self, x: f32) -> i32 {
        (x / self.cell.0).round() as i32 + self.origin.0
    }

    fn row(&self, y: f32) -> i32 {
        (y / self.cell.1).round() as i32 + self.origin.1
    }

    fn area(&self, rect: PxRect) -> Area {
        Area { x0: self.col(rect.x), y0: self.row(rect.y), x1: self.col(rect.x + rect.w), y1: self.row(rect.y + rect.h) }
    }

    fn at(&self, x: i32, y: i32) -> Option<usize> {
        (x >= 0 && y >= 0 && x < self.grid.width as i32 && y < self.grid.height as i32)
            .then(|| self.grid.index(x as u16, y as u16))
    }

    fn op(&mut self, op: &SceneOp) {
        match op {
            SceneOp::PushClip(rect) => {
                let clip = self.clip().intersect(self.area(*rect));
                self.clips.push(clip);
            }
            SceneOp::PopClip => {
                if self.clips.len() > 1 {
                    self.clips.pop();
                }
            }
            SceneOp::Rect { rect, color, kind, .. } => self.rect(*rect, *color, *kind),
            SceneOp::Gradient { rect, gradient, .. } => self.gradient(*rect, gradient),
            SceneOp::Border { rect, radius, color, .. } => self.border(*rect, radius.iter().any(|r| *r > 0.0), *color),
            SceneOp::Text(run) => self.text(run),
            SceneOp::Caret { rect, shape, .. } => {
                let (x, y) = (self.col(rect.x), self.row(rect.y));
                if self.clip().contains(x, y) && self.at(x, y).is_some() {
                    self.caret = Some(Caret { x: x as u16, y: y as u16, shape: *shape });
                }
            }
            SceneOp::Shape { rect, color, fallback } => {
                if let Some(text) = fallback {
                    self.label(*rect, text, *color);
                }
            }
            SceneOp::Image { rect, src, equal_to, state, fallback, color } => match (fallback, state) {
                (Some(text), _) => self.label(*rect, text, *color),
                (None, ImageState::Ready) => self.image(*rect, src, equal_to),
                (None, _) => self.placeholder(*rect, IMAGE_LABEL, *color),
            },
            SceneOp::Surface { rect } => {
                let fg = self.palette.foreground;
                self.placeholder(*rect, WEB_VIEW_LABEL, [fg[0], fg[1], fg[2], 160]);
            }
        }
    }

    fn fill(&mut self, area: Area, color: [u8; 4], tint_glyphs: bool) {
        let area = area.intersect(self.clip());
        if area.is_empty() || color[3] == 0 {
            return;
        }
        for y in area.y0..area.y1 {
            for x in area.x0..area.x1 {
                let Some(i) = self.at(x, y) else { continue };
                if color[3] == 255 {
                    self.grid.blank(i);
                    self.grid.bg_rgb[i] = [color[0], color[1], color[2]];
                    self.grid.attrs[i] = 0;
                } else {
                    self.grid.bg_rgb[i] = blend(color, self.grid.bg_rgb[i]);
                    if tint_glyphs {
                        self.grid.fg_rgb[i] = blend(color, self.grid.fg_rgb[i]);
                    }
                }
            }
        }
    }

    // A box's border sits on its outermost cells, so those keep the background around the box and only the
    // inside takes the box's own.
    fn inside_border(&mut self, rect: PxRect, color: [u8; 4]) {
        let area = self.area(rect);
        let rows = area.y1 - area.y0;
        let inner = Area { x0: area.x0 + 1, x1: area.x1 - 1, y0: if rows > 1 { area.y0 + 1 } else { area.y0 }, y1: if rows > 1 { area.y1 - 1 } else { area.y1 } };
        if inner.is_empty() {
            self.rect(rect, color, RectKind::Fill);
        } else {
            self.fill(inner, color, true);
        }
    }

    // Content scrolled inside a bordered box stays off the border's cells.
    fn clip_inside_border(&mut self, rect: PxRect) {
        let area = self.area(rect);
        let inner = if area.y1 - area.y0 >= 3 {
            Area { x0: area.x0 + 1, y0: area.y0 + 1, x1: area.x1 - 1, y1: area.y1 - 1 }
        } else {
            area
        };
        let clip = self.clip().intersect(inner);
        self.clips.push(clip);
    }

    fn rect(&mut self, rect: PxRect, color: [u8; 4], kind: RectKind) {
        let area = self.area(rect);
        let wide = area.x1 > area.x0 && rect.w >= self.cell.0 * 0.5;
        let tall = area.y1 > area.y0 && rect.h >= self.cell.1 * 0.5;
        if wide && tall {
            self.fill(area, color, true);
            if kind == RectKind::Selection || self.mono_highlight(color) {
                self.mark_inverse(area);
            }
            return;
        }
        if kind == RectKind::Edge {
            if rect.w >= rect.h {
                let y = ((rect.y + rect.h / 2.0) / self.cell.1).floor() as i32 + self.origin.1;
                self.glyph_row(y, area.x0, area.x1.max(area.x0 + 1), '─', color);
            } else {
                let x = ((rect.x + rect.w / 2.0) / self.cell.0).floor() as i32 + self.origin.0;
                self.glyph_column(x, area.y0, area.y1.max(area.y0 + 1), '│', color);
            }
            return;
        }
        if kind == RectKind::Scrollbar && tall {
            let x = ((rect.x + rect.w / 2.0) / self.cell.0).floor() as i32 + self.origin.0;
            self.glyph_column(x, area.y0, area.y1, '▐', color);
            return;
        }
        let wide = wide || rect.w >= self.cell.0 * 0.5;
        let tall = tall || rect.h >= self.cell.1 * 0.5;
        if !wide && !tall && rect.w > 0.0 && rect.h > 0.0 {
            let x = ((rect.x + rect.w / 2.0) / self.cell.0).floor() as i32 + self.origin.0;
            let y = ((rect.y + rect.h / 2.0) / self.cell.1).floor() as i32 + self.origin.1;
            self.put_glyph(x, y, '■', color);
            return;
        }
        if wide && rect.h > 0.0 {
            let center = (rect.y + rect.h / 2.0) / self.cell.1;
            let glyph = edge_glyph(center.fract(), ['▔', '─', '▁']);
            self.glyph_row(center.floor() as i32 + self.origin.1, area.x0, area.x1, glyph, color);
        } else if tall && rect.w > 0.0 {
            let center = (rect.x + rect.w / 2.0) / self.cell.0;
            let glyph = edge_glyph(center.fract(), ['▏', '│', '▕']);
            self.glyph_column(center.floor() as i32 + self.origin.0, area.y0, area.y1, glyph, color);
        }
    }

    fn mono_highlight(&self, color: [u8; 4]) -> bool {
        self.palette.tier == ColorTier::Mono
            && color[3] > 128
            && distance([color[0], color[1], color[2]], self.palette.background) > MONO_HIGHLIGHT_DISTANCE
    }

    fn mark_inverse(&mut self, area: Area) {
        if self.palette.tier != ColorTier::Mono {
            return;
        }
        let area = area.intersect(self.clip());
        for y in area.y0..area.y1 {
            for x in area.x0..area.x1 {
                if let Some(i) = self.at(x, y) {
                    self.grid.attrs[i] |= INVERSE;
                }
            }
        }
    }

    fn put_glyph(&mut self, x: i32, y: i32, glyph: char, color: [u8; 4]) {
        if !self.clip().contains(x, y) {
            return;
        }
        let Some(i) = self.at(x, y) else { return };
        let mut buf = [0u8; 4];
        self.grid.fg_rgb[i] = blend(color, self.grid.bg_rgb[i]);
        self.grid.attrs[i] &= INVERSE;
        self.grid.put(i, glyph.encode_utf8(&mut buf), 1);
    }

    fn glyph_row(&mut self, y: i32, x0: i32, x1: i32, glyph: char, color: [u8; 4]) {
        for x in x0..x1 {
            self.put_glyph(x, y, glyph, color);
        }
    }

    fn glyph_column(&mut self, x: i32, y0: i32, y1: i32, glyph: char, color: [u8; 4]) {
        for y in y0..y1 {
            self.put_glyph(x, y, glyph, color);
        }
    }

    fn gradient(&mut self, rect: PxRect, gradient: &LinearGradient) {
        let area = self.area(rect).intersect(self.clip());
        if area.is_empty() || gradient.stops.is_empty() {
            return;
        }
        let (dx, dy) = (gradient.to.0 - gradient.from.0, gradient.to.1 - gradient.from.1);
        let length = dx * dx + dy * dy;
        for y in area.y0..area.y1 {
            for x in area.x0..area.x1 {
                let fx = (((x - self.origin.0) as f32 + 0.5) * self.cell.0 - rect.x) / rect.w.max(1.0);
                let fy = (((y - self.origin.1) as f32 + 0.5) * self.cell.1 - rect.y) / rect.h.max(1.0);
                let t = if length > 0.0 { ((fx - gradient.from.0) * dx + (fy - gradient.from.1) * dy) / length } else { 0.0 };
                let color = sample(&gradient.stops, t.clamp(0.0, 1.0));
                self.fill(Area { x0: x, y0: y, x1: x + 1, y1: y + 1 }, color, true);
            }
        }
    }

    fn border(&mut self, rect: PxRect, rounded: bool, color: [u8; 4]) {
        let a = self.area(rect);
        let (w, h) = (a.x1 - a.x0, a.y1 - a.y0);
        if w <= 0 || h <= 0 {
            return;
        }
        if h < 3 {
            if w >= 2 {
                self.glyph_column(a.x0, a.y0, a.y1, '▕', color);
                self.glyph_column(a.x1 - 1, a.y0, a.y1, '▏', color);
            }
            return;
        }
        if w == 1 {
            self.glyph_column(a.x0, a.y0, a.y1, '│', color);
            return;
        }
        let [tl, tr, bl, br] = if rounded { ['╭', '╮', '╰', '╯'] } else { ['┌', '┐', '└', '┘'] };
        self.glyph_row(a.y0, a.x0 + 1, a.x1 - 1, '─', color);
        self.glyph_row(a.y1 - 1, a.x0 + 1, a.x1 - 1, '─', color);
        self.glyph_column(a.x0, a.y0 + 1, a.y1 - 1, '│', color);
        self.glyph_column(a.x1 - 1, a.y0 + 1, a.y1 - 1, '│', color);
        self.put_glyph(a.x0, a.y0, tl, color);
        self.put_glyph(a.x1 - 1, a.y0, tr, color);
        self.put_glyph(a.x0, a.y1 - 1, bl, color);
        self.put_glyph(a.x1 - 1, a.y1 - 1, br, color);
    }

    fn text(&mut self, run: &TextRun) {
        let y = self.row(run.top);
        let clip = self.clip();
        if y < clip.y0 || y >= clip.y1 {
            return;
        }
        let mut attrs = 0;
        if run.bold {
            attrs |= BOLD;
        }
        if run.italic {
            attrs |= ITALIC;
        }
        if run.underline {
            attrs |= UNDERLINE;
        }
        if run.strikethrough {
            attrs |= STRIKETHROUGH;
        }
        let decorated = attrs & (UNDERLINE | STRIKETHROUGH) != 0;
        let mut pen = run.x;
        for (offset, cluster) in run.text.grapheme_indices(true) {
            if cluster.starts_with(MARK_CHAR) {
                pen += run.gaps.iter().find(|(at, _)| *at == offset).map_or(0.0, |(_, advance)| *advance);
                continue;
            }
            let width = cluster.chars().map(crate::device::columns).sum::<usize>();
            let x = self.col(pen);
            pen += width as f32 * self.cell.0;
            if width == 0 {
                continue;
            }
            let blank = cluster.chars().all(|c| c == ' ' || c == '\t' || c.is_control());
            if blank && !decorated {
                continue;
            }
            if x < clip.x0 || x + width as i32 > clip.x1 {
                continue;
            }
            let Some(i) = self.at(x, y) else { continue };
            if x + width as i32 > self.grid.width as i32 {
                continue;
            }
            self.grid.fg_rgb[i] = blend(run.color, self.grid.bg_rgb[i]);
            self.grid.attrs[i] = attrs | (self.grid.attrs[i] & INVERSE);
            if blank {
                self.grid.put(i, " ", 1);
            } else {
                self.grid.put(i, cluster, width);
            }
        }
    }

    fn label(&mut self, rect: PxRect, text: &str, color: [u8; 4]) {
        let width: usize = text.chars().map(crate::device::columns).sum();
        let cx = (rect.x + rect.w / 2.0) / self.cell.0 - width as f32 / 2.0;
        let x = cx.round() as i32;
        let y = ((rect.y + rect.h / 2.0) / self.cell.1).floor();
        self.text(&TextRun {
            text: text.to_string(),
            x: x as f32 * self.cell.0,
            top: y * self.cell.1,
            color,
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            gaps: Vec::new(),
        });
    }

    fn placeholder(&mut self, rect: PxRect, text: &str, color: [u8; 4]) {
        let area = self.area(rect);
        if area.x1 - area.x0 >= 2 && area.y1 - area.y0 >= 2 {
            self.border(rect, true, color);
        }
        if (area.x1 - area.x0) as usize >= text.len() + 2 {
            self.label(rect, text, color);
        }
    }

    fn image(&mut self, rect: PxRect, src: &str, equal_to: &[String]) {
        let area = self.area(rect);
        let (cols, rows) = (area.x1 - area.x0, area.y1 - area.y0);
        if cols <= 0 || rows <= 0 {
            return;
        }
        let Some(rgba) = pixel_core::scaled_rgba(src, equal_to, cols as u32, rows as u32 * 2) else {
            return;
        };
        let clip = self.clip();
        for row in 0..rows {
            for col in 0..cols {
                let (x, y) = (area.x0 + col, area.y0 + row);
                if !clip.contains(x, y) {
                    continue;
                }
                let Some(i) = self.at(x, y) else { continue };
                let pixel = |py: i32| {
                    let at = ((py * cols + col) * 4) as usize;
                    [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]
                };
                let under = self.grid.bg_rgb[i];
                let over = |p: [u8; 4]| {
                    let inv = 255 - p[3] as u32;
                    let mix = |s: u8, d: u8| (s as u32 + d as u32 * inv / 255).min(255) as u8;
                    [mix(p[0], under[0]), mix(p[1], under[1]), mix(p[2], under[2])]
                };
                let (top, bottom) = (over(pixel(row * 2)), over(pixel(row * 2 + 1)));
                self.grid.fg_rgb[i] = top;
                self.grid.bg_rgb[i] = bottom;
                self.grid.attrs[i] = 0;
                self.grid.put(i, "▀", 1);
            }
        }
    }
}

fn edge_glyph(fraction: f32, glyphs: [char; 3]) -> char {
    if fraction < 0.3 {
        glyphs[0]
    } else if fraction > 0.7 {
        glyphs[2]
    } else {
        glyphs[1]
    }
}

fn sample(stops: &[(f32, [u8; 4])], t: f32) -> [u8; 4] {
    let first = stops[0];
    if t <= first.0 {
        return first.1;
    }
    for pair in stops.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if t <= b.0 {
            let span = (b.0 - a.0).max(f32::EPSILON);
            let f = (t - a.0) / span;
            let mix = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * f).round() as u8;
            return [mix(a.1[0], b.1[0]), mix(a.1[1], b.1[1]), mix(a.1[2], b.1[2]), mix(a.1[3], b.1[3])];
        }
    }
    stops[stops.len() - 1].1
}

use crate::text_input::{MARK_CHAR, Mark, mark_advance_at};

type GlyphKey = (usize, char, u32);
type GlyphCache = std::collections::HashMap<GlyphKey, (fontdue::Metrics, Vec<u8>)>;
std::thread_local! {
    static GLYPH_CACHE: std::cell::RefCell<GlyphCache> = std::cell::RefCell::new(GlyphCache::new());
    static ADVANCE_CACHE: std::cell::RefCell<std::collections::HashMap<GlyphKey, f32>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static LAST_RESAMPLE: std::cell::Cell<Option<(u32, u32, u32, u32)>> =
        const { std::cell::Cell::new(None) };
}

fn corner_insets(radius: [f32; 4], row: i64, height: i64) -> (i64, i64) {
    if radius == [0.0; 4] {
        return (0, 0);
    }
    let dy_top = row as f32 + 0.5;
    let dy_bottom = (height - 1 - row) as f32 + 0.5;
    let inset = |r: f32, dy: f32| -> i64 {
        if r <= 0.0 || dy >= r {
            0
        } else {
            let reach = r - dy;
            (r - (r * r - reach * reach).sqrt()).ceil() as i64
        }
    };
    (
        inset(radius[0], dy_top).max(inset(radius[3], dy_bottom)),
        inset(radius[1], dy_top).max(inset(radius[2], dy_bottom)),
    )
}

#[derive(Default)]
pub(crate) struct CanvasStats {
    pub boxes: std::cell::Cell<u64>,
    pub boxes_clipped_out: std::cell::Cell<u64>,
    pub paths: std::cell::Cell<u64>,
    pub paths_clipped: std::cell::Cell<u64>,
}

std::thread_local! {
    static STATS: CanvasStats = CanvasStats::default();
}

fn tally(pick: impl Fn(&CanvasStats) -> &std::cell::Cell<u64>) {
    STATS.with(|s| {
        let cell = pick(s);
        cell.set(cell.get() + 1);
    });
}

pub(crate) fn take_canvas_stats() -> (u64, u64, u64, u64) {
    STATS.with(|s| {
        (
            s.boxes.take(),
            s.boxes_clipped_out.take(),
            s.paths.take(),
            s.paths_clipped.take(),
        )
    })
}

fn subtract_rect(
    (fx1, fy1, fx2, fy2): (u32, u32, u32, u32),
    (hx1, hy1, hx2, hy2): (u32, u32, u32, u32),
    out: &mut Vec<(u32, u32, u32, u32)>,
) {
    if hx2 <= fx1 || hx1 >= fx2 || hy2 <= fy1 || hy1 >= fy2 {
        out.push((fx1, fy1, fx2, fy2));
        return;
    }
    if fy1 < hy1 {
        out.push((fx1, fy1, fx2, hy1));
    }
    if hy2 < fy2 {
        out.push((fx1, hy2, fx2, fy2));
    }
    let my1 = fy1.max(hy1);
    let my2 = fy2.min(hy2);
    if fx1 < hx1 {
        out.push((fx1, my1, hx1, my2));
    }
    if hx2 < fx2 {
        out.push((hx2, my1, fx2, my2));
    }
}

fn solid_paint(color: [u8; 4]) -> tiny_skia::Paint<'static> {
    let mut paint = tiny_skia::Paint::default();
    paint.set_color_rgba8(color[0], color[1], color[2], color[3]);
    paint.anti_alias = true;
    paint
}

fn blend_pixel(dst: &mut [u8], src: &[u8], alpha: u8) {
    let inv = 255 - u32::from(alpha);
    for (d, &s) in dst.iter_mut().zip(src) {
        *d = (u32::from(s) + (u32::from(*d) * inv + 127) / 255).min(255) as u8;
    }
}

fn blend_row(dst: &mut [u8], src: &[u8]) {
    if src.chunks_exact(4).all(|s| s[3] == 255) {
        dst.copy_from_slice(src);
        return;
    }
    for (dst, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
        match s[3] {
            255 => dst.copy_from_slice(s),
            0 => {}
            alpha => blend_pixel(dst, s, alpha),
        }
    }
}

pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    clip_stack: Vec<(u32, u32, u32, u32)>,
    occluders: Vec<(u32, (f32, f32, f32, f32))>,
    next_occluder: u32,
    scratch: Vec<u8>,
}

impl Canvas {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; (width * height * 4) as usize],
            clip_stack: Vec::new(),
            occluders: Vec::new(),
            next_occluder: 0,
            scratch: Vec::new(),
        }
    }

    pub fn from_rgba(pixels: Vec<u8>, width: u32, height: u32) -> Self {
        debug_assert_eq!(pixels.len(), (width * height * 4) as usize);
        Self {
            width,
            height,
            pixels,
            clip_stack: Vec::new(),
            occluders: Vec::new(),
            next_occluder: 0,
            scratch: Vec::new(),
        }
    }

    pub fn push_clip(&mut self, x: f32, y: f32, w: f32, h: f32) {
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        let x1 = (x.round().max(0.0) as u32).clamp(cx1, cx2);
        let y1 = (y.round().max(0.0) as u32).clamp(cy1, cy2);
        let x2 = ((x + w).round().max(0.0) as u32).clamp(x1, cx2);
        let y2 = ((y + h).round().max(0.0) as u32).clamp(y1, cy2);
        self.clip_stack.push((x1, y1, x2, y2));
    }

    pub fn pop_clip(&mut self) {
        self.clip_stack.pop();
    }

    pub fn add_occluder(&mut self, x: f32, y: f32, w: f32, h: f32) -> u32 {
        let token = self.next_occluder;
        self.next_occluder += 1;
        self.occluders.push((token, (x, y, w, h)));
        token
    }

    pub fn remove_occluder(&mut self, token: u32) {
        self.occluders.retain(|(t, _)| *t != token);
    }

    pub fn clear_occluders(&mut self) {
        self.occluders.clear();
    }

    fn occluded(&self, x: f32, y: f32, w: f32, h: f32) -> bool {
        let inside = self
            .occluders
            .iter()
            .any(|&(_, (ox, oy, ow, oh))| x >= ox && y >= oy && x + w <= ox + ow && y + h <= oy + oh);
        if inside {
            tally(|s| &s.boxes_clipped_out);
        }
        inside
    }

    fn clip_bounds(&self) -> (u32, u32, u32, u32) {
        self.clip_stack
            .last()
            .copied()
            .unwrap_or((0, 0, self.width, self.height))
    }

    // weird impl, but its a fast way to fill an array to a given color without allocating memory beforehand
    pub fn fill(&mut self, color: [u8; 4]) {
        if self.pixels.is_empty() {
            return;
        }
        self.pixels[..4].copy_from_slice(&color);
        let mut filled = 4;
        while filled < self.pixels.len() {
            let (done, rest) = self.pixels.split_at_mut(filled);
            let n = done.len().min(rest.len());
            rest[..n].copy_from_slice(&done[..n]);
            filled += n;
        }
    }

    pub fn fill_rect(&mut self, x: u32, y: u32, w: u32, h: u32, color: [u8; 4]) {
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        let x1 = x.clamp(cx1, cx2);
        let y1 = y.clamp(cy1, cy2);
        let x2 = x.saturating_add(w).clamp(x1, cx2);
        let y2 = y.saturating_add(h).clamp(y1, cy2);
        if x2 <= x1 || y2 <= y1 {
            return;
        }
   
        let mut fragments = vec![(x1, y1, x2, y2)];
        if !self.occluders.is_empty() {
            let mut split = Vec::new();
            for &(_, (ox, oy, ow, oh)) in &self.occluders {
                let hole = (
                    ox.ceil().max(0.0) as u32,
                    oy.ceil().max(0.0) as u32,
                    (ox + ow).floor().max(0.0) as u32,
                    (oy + oh).floor().max(0.0) as u32,
                );
                for fragment in fragments.drain(..) {
                    subtract_rect(fragment, hole, &mut split);
                }
                std::mem::swap(&mut fragments, &mut split);
            }
            if fragments != [(x1, y1, x2, y2)] {
                tally(|s| &s.boxes_clipped_out);
            }
        }
        for (fx1, fy1, fx2, fy2) in fragments {
            self.fill_rows(fx1, fy1, fx2, fy2, color);
        }
    }

    fn fill_rows(&mut self, x1: u32, y1: u32, x2: u32, y2: u32, color: [u8; 4]) {
        let first = ((y1 * self.width + x1) * 4) as usize;
        let row_len = ((x2 - x1) * 4) as usize;
        for px in self.pixels[first..first + row_len].chunks_exact_mut(4) {
            px.copy_from_slice(&color);
        }
        let template = self.pixels[first..first + row_len].to_vec();
        for row in y1 + 1..y2 {
            let start = ((row * self.width + x1) * 4) as usize;
            self.pixels[start..start + row_len].copy_from_slice(&template);
        }
    }

    pub fn draw_text(
        &mut self,
        font: &fontdue::Font,
        text: &str,
        x: i32,
        baseline: i32,
        px: f32,
        color: [u8; 4],
    ) {
        self.draw_text_sheared(font, text, x, baseline, px, color, 0.0);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn draw_text_sheared(
        &mut self,
        font: &fontdue::Font,
        text: &str,
        x: i32,
        baseline: i32,
        px: f32,
        color: [u8; 4],
        shear: f32,
    ) {
        self.draw_marked_sheared(
            font,
            text,
            0..text.len(),
            x,
            baseline,
            px,
            color,
            &[],
            shear,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn draw_marked(
        &mut self,
        font: &fontdue::Font,
        text: &str,
        range: std::ops::Range<usize>,
        x: i32,
        baseline: i32,
        px: f32,
        color: [u8; 4],
        marks: &[Mark],
    ) {
        self.draw_marked_sheared(font, text, range, x, baseline, px, color, marks, 0.0);
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn draw_marked_sheared(
        &mut self,
        font: &fontdue::Font,
        text: &str,
        range: std::ops::Range<usize>,
        x: i32,
        baseline: i32,
        px: f32,
        color: [u8; 4],
        marks: &[Mark],
        shear: f32,
    ) {
        let mut pen_x = x as f32;
        GLYPH_CACHE.with_borrow_mut(|cache| {
            for (i, ch) in text[range.clone()].char_indices() {
                if ch == MARK_CHAR {
                    pen_x += mark_advance_at(marks, range.start + i);
                    continue;
                }
                let (metrics, coverage) = cache
                    .entry((font.file_hash(), ch, px.to_bits()))
                    .or_insert_with(|| font.rasterize(ch, px));
                let glyph_x = pen_x.round() as i32 + metrics.xmin;
                // ymin is the bottom edge's offset from the baseline (positive = up),
                // so the bitmap's top row sits at baseline - height - ymin.
                let glyph_y = baseline - metrics.height as i32 - metrics.ymin;
                self.blend_mask(
                    glyph_x,
                    glyph_y,
                    metrics.width,
                    metrics.height,
                    coverage,
                    color,
                    baseline,
                    shear,
                );
                pen_x += metrics.advance_width;
            }
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn blend_mask(
        &mut self,
        x: i32,
        y: i32,
        w: usize,
        h: usize,
        mask: &[u8],
        color: [u8; 4],
        baseline: i32,
        shear: f32,
    ) {
        if shear == 0.0 {
            self.blend_rows(x, y, w, h, mask, color);
            return;
        }
        let mut sheared = vec![0u8; w + 1];
        for row in 0..h {
            let py = y + row as i32;
            let offset = (baseline - py) as f32 * shear;
            let whole = offset.floor();
            let frac = offset - whole;
            for (i, out) in sheared.iter_mut().enumerate() {
                let right = if i < w {
                    f32::from(mask[row * w + i]) * (1.0 - frac)
                } else {
                    0.0
                };
                let left = if i > 0 {
                    f32::from(mask[row * w + i - 1]) * frac
                } else {
                    0.0
                };
                *out = (right + left).round() as u8;
            }
            self.blend_rows(x + whole as i32, py, w + 1, 1, &sheared, color);
        }
    }

    fn blend_rows(&mut self, x: i32, y: i32, w: usize, h: usize, mask: &[u8], color: [u8; 4]) {
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        for row in 0..h {
            let py = y + row as i32;
            if py < cy1 as i32 || py >= cy2 as i32 {
                continue;
            }
            for col in 0..w {
                let px = x + col as i32;
                if px < cx1 as i32 || px >= cx2 as i32 {
                    continue;
                }
                let coverage = u32::from(mask[row * w + col]);
                if coverage == 0 {
                    continue;
                }
                let i = ((py as u32 * self.width + px as u32) * 4) as usize;
                for (dst, &src) in self.pixels[i..i + 4].iter_mut().zip(&color) {
                    *dst = ((u32::from(*dst) * (255 - coverage) + u32::from(src) * coverage) / 255)
                        as u8;
                }
            }
        }
    }
}

impl Canvas {
    fn clipped_out(&self, x: f32, y: f32, w: f32, h: f32) -> bool {
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        tally(|s| &s.boxes);
        let out = x + w <= cx1 as f32 || y + h <= cy1 as f32 || x >= cx2 as f32 || y >= cy2 as f32;
        if out {
            tally(|s| &s.boxes_clipped_out);
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn fill_large_rounded_rect(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: [f32; 4],
        max_radius: f32,
        color: [u8; 4],
    ) -> bool {
        let strip = (max_radius.ceil() * 2.0).max(2.0);
        let whole_pixels = [x, y, w, h].iter().all(|v| (v - v.round()).abs() < 0.01);
        if color[3] != 255 || !whole_pixels || w * h < 65536.0 {
            return false;
        }
        if h < strip * 2.0 + 2.0 {
           
            if w < strip * 2.0 + 2.0 {
                return false;
            }
            if let Some(path) =
                rounded_rect_path(x, y, strip, h, [radius[0], 0.0, 0.0, radius[3]])
            {
                self.paint_path(&path, color, None);
            }
            if let Some(path) =
                rounded_rect_path(x + w - strip, y, strip, h, [0.0, radius[1], radius[2], 0.0])
            {
                self.paint_path(&path, color, None);
            }
            let mx1 = (x + strip).round().max(0.0) as u32;
            let mx2 = (x + w - strip).round().max(0.0) as u32;
            self.fill_rect(
                mx1,
                y.round().max(0.0) as u32,
                mx2.saturating_sub(mx1),
                h.round().max(0.0) as u32,
                color,
            );
            return true;
        }
        let top = y + strip;
        let bottom = y + h - strip;
      
        let corner = strip.min(w / 2.0);
        if let Some(path) = rounded_rect_path(x, y, corner * 2.0, strip, [radius[0], 0.0, 0.0, 0.0])
        {
            self.paint_path(&path, color, None);
        }
        if let Some(path) = rounded_rect_path(
            x + w - corner * 2.0,
            y,
            corner * 2.0,
            strip,
            [0.0, radius[1], 0.0, 0.0],
        ) {
            self.paint_path(&path, color, None);
        }
        if let Some(path) = rounded_rect_path(
            x + w - corner * 2.0,
            bottom,
            corner * 2.0,
            strip,
            [0.0, 0.0, radius[2], 0.0],
        ) {
            self.paint_path(&path, color, None);
        }
        if let Some(path) =
            rounded_rect_path(x, bottom, corner * 2.0, strip, [0.0, 0.0, 0.0, radius[3]])
        {
            self.paint_path(&path, color, None);
        }
        let x1 = x.round().max(0.0) as u32;
        let x2 = (x + w).round().max(0.0) as u32;
        let cx1 = (x + corner * 2.0).round().max(0.0) as u32;
        let cx2 = (x + w - corner * 2.0).round().max(0.0) as u32;
        if cx2 > cx1 {
            let strip_px = strip.round().max(0.0) as u32;
            self.fill_rect(cx1, y.round().max(0.0) as u32, cx2 - cx1, strip_px, color);
            self.fill_rect(cx1, bottom.round().max(0.0) as u32, cx2 - cx1, strip_px, color);
        }
        self.fill_rect(
            x1,
            top.round().max(0.0) as u32,
            x2.saturating_sub(x1),
            (bottom - top).round().max(0.0) as u32,
            color,
        );
        true
    }

    pub fn fill_rounded_rect(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: [f32; 4],
        color: [u8; 4],
    ) {
        if w <= 0.0 || h <= 0.0 || self.clipped_out(x, y, w, h) || self.occluded(x, y, w, h) {
            return;
        }
        let max_radius = radius.iter().fold(0.0f32, |a, &r| a.max(r));
        if self.fill_large_rounded_rect(x, y, w, h, radius, max_radius, color) {
            return;
        }
        if max_radius.min(w / 2.0).min(h / 2.0) < 0.5 && color[3] == 255 {
            let x1 = x.round().max(0.0) as u32;
            let y1 = y.round().max(0.0) as u32;
            let x2 = (x + w).round().max(0.0) as u32;
            let y2 = (y + h).round().max(0.0) as u32;
            self.fill_rect(x1, y1, x2.saturating_sub(x1), y2.saturating_sub(y1), color);
            return;
        }
        if let Some(path) = rounded_rect_path(x, y, w, h, radius) {
            self.paint_path(&path, color, None);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stroke_rounded_rect(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: [f32; 4],
        width: f32,
        color: [u8; 4],
    ) {
        if self.clipped_out(x - width, y - width, w + width * 2.0, h + width * 2.0) {
            return;
        }
 
        let corner = radius
            .iter()
            .fold(width * 2.0, |a, &r| a.max(r + width))
            .ceil()
            + 1.0;
        if w * h >= 65536.0 && w > corner * 2.0 + 2.0 && h > corner * 2.0 + 2.0 {
            let inset = width / 2.0;
            let stroke_radius = radius.map(|r| (r - inset).max(0.0));
            let clips: [(f32, f32, f32, f32); 4] = [
                (x, y, corner, corner),
                (x + w - corner, y, corner, corner),
                (x + w - corner, y + h - corner, corner, corner),
                (x, y + h - corner, corner, corner),
            ];
            if let Some(path) = rounded_rect_path(
                x + inset,
                y + inset,
                w - width,
                h - width,
                stroke_radius,
            ) {
                for (cx, cy, cw, ch) in clips {
                    self.push_clip(cx, cy, cw, ch);
                    self.paint_path(&path, color, Some(width));
                    self.pop_clip();
                }
            }
            let edge = width.max(1.0);
            self.blend_fill(x + corner, y, w - corner * 2.0, edge, color);
            self.blend_fill(x + corner, y + h - edge, w - corner * 2.0, edge, color);
            self.blend_fill(x, y + corner, edge, h - corner * 2.0, color);
            self.blend_fill(x + w - edge, y + corner, edge, h - corner * 2.0, color);
            return;
        }
        let inset = width / 2.0;
        if let Some(path) = rounded_rect_path(
            x + inset,
            y + inset,
            w - width,
            h - width,
            radius.map(|r| (r - inset).max(0.0)),
        ) {
            self.paint_path(&path, color, Some(width));
        }
    }

    pub fn fill_rounded_rect_gradient(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: [f32; 4],
        gradient: &crate::style::LinearGradient,
    ) {
        if w <= 0.0 || h <= 0.0 || gradient.stops.is_empty() {
            return;
        }
        if self.clipped_out(x, y, w, h) || self.occluded(x, y, w, h) {
            return;
        }
        let point = |(fx, fy): (f32, f32)| tiny_skia::Point::from_xy(x + fx * w, y + fy * h);
        let stops = gradient
            .stops
            .iter()
            .map(|&(at, c)| {
                tiny_skia::GradientStop::new(
                    at.clamp(0.0, 1.0),
                    tiny_skia::Color::from_rgba8(c[0], c[1], c[2], c[3]),
                )
            })
            .collect();
        let Some(shader) = tiny_skia::LinearGradient::new(
            point(gradient.from),
            point(gradient.to),
            stops,
            tiny_skia::SpreadMode::Pad,
            tiny_skia::Transform::identity(),
        ) else {
            return;
        };
        let Some(path) = rounded_rect_path(x, y, w, h, radius) else {
            return;
        };
        let mut paint = tiny_skia::Paint::default();
        paint.shader = shader;
        paint.anti_alias = true;
        self.paint_path_with(&path, paint, None);
    }

    fn blend_fill(&mut self, x: f32, y: f32, w: f32, h: f32, color: [u8; 4]) {
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let x1 = x.round().max(0.0) as u32;
        let y1 = y.round().max(0.0) as u32;
        let x2 = (x + w).round().max(0.0) as u32;
        let y2 = (y + h).round().max(0.0) as u32;
        if color[3] == 255 {
            self.fill_rect(x1, y1, x2.saturating_sub(x1), y2.saturating_sub(y1), color);
            return;
        }
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        let x1 = x1.clamp(cx1, cx2);
        let y1 = y1.clamp(cy1, cy2);
        let x2 = x2.clamp(x1, cx2);
        let y2 = y2.clamp(y1, cy2);
        if x2 <= x1 || y2 <= y1 || color[3] == 0 {
            return;
        }
        for row in y1..y2 {
            let start = ((row * self.width + x1) * 4) as usize;
            let len = ((x2 - x1) * 4) as usize;
            for px in self.pixels[start..start + len].chunks_exact_mut(4) {
                blend_pixel(px, &color, color[3]);
            }
        }
    }
    pub fn blit_image(&mut self, x: f32, y: f32, image: tiny_skia::PixmapRef<'_>) {
        self.blit_image_rounded(x, y, image, [0.0; 4]);
    }

    pub fn blit_image_rounded(
        &mut self,
        x: f32,
        y: f32,
        image: tiny_skia::PixmapRef<'_>,
        radius: [f32; 4],
    ) {
        self.blit_image_rounded_hint(x, y, image, radius, false);
    }

    pub fn blit_image_rounded_hint(
        &mut self,
        x: f32,
        y: f32,
        image: tiny_skia::PixmapRef<'_>,
        radius: [f32; 4],
        opaque: bool,
    ) {
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        let x0 = x.round() as i64;
        let y0 = y.round() as i64;
        let x1 = x0.max(cx1 as i64);
        let y1 = y0.max(cy1 as i64);
        let x2 = (x0 + i64::from(image.width())).min(cx2 as i64);
        let y2 = (y0 + i64::from(image.height())).min(cy2 as i64);
        if x2 <= x1 || y2 <= y1 {
            return;
        }
        let src = image.data();
        let src_stride = image.width() as usize * 4;
        let src_w = i64::from(image.width());
        let height = i64::from(image.height());
        let dst_stride = self.width as usize * 4;
        let rows = (y2 - y1) as usize;
        let run_rows = |dst_rows: &mut [u8], first_row: i64, count: usize| {
            for r in 0..count {
                let row = first_row + r as i64;
                let (inset_l, inset_r) = corner_insets(radius, row - y0, height);
                let rx1 = x1.max(x0 + inset_l);
                let rx2 = x2.min(x0 + src_w - inset_r);
                if rx2 <= rx1 {
                    continue;
                }
                let col0 = (rx1 - x0) as usize * 4;
                let col1 = (rx2 - x0) as usize * 4;
                let src_off = (row - y0) as usize * src_stride;
                let src_row = &src[src_off + col0..src_off + col1];
                let dst_off = r * dst_stride + rx1 as usize * 4;
                let dst_row = &mut dst_rows[dst_off..dst_off + src_row.len()];
                if opaque {
                    dst_row.copy_from_slice(src_row);
                } else {
                    blend_row(dst_row, src_row);
                }
            }
        };
        let dst_from = y1 as usize * dst_stride;
        let dst_region = &mut self.pixels[dst_from..y2 as usize * dst_stride];
        crate::parallel::row_bands(
            dst_region,
            dst_stride,
            rows,
            1 << 20,
            |band, first, count| run_rows(band, y1 + first as i64, count),
            |(), ()| (),
        );
    }

    pub fn blit_opaque_rgba(&mut self, x: f32, y: f32, src: &[u8], src_w: u32, src_h: u32) {
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        let x0 = x.round() as i64;
        let y0 = y.round() as i64;
        let x1 = x0.max(cx1 as i64);
        let y1 = y0.max(cy1 as i64);
        let x2 = (x0 + i64::from(src_w)).min(cx2 as i64);
        let y2 = (y0 + i64::from(src_h)).min(cy2 as i64);
        if x2 <= x1 || y2 <= y1 {
            return;
        }
        let src_stride = src_w as usize * 4;
        let dst_stride = self.width as usize * 4;
        let bytes = (x2 - x1) as usize * 4;
        let col0 = (x1 - x0) as usize * 4;
        for row in y1..y2 {
            let src_off = (row - y0) as usize * src_stride + col0;
            let dst_off = row as usize * dst_stride + x1 as usize * 4;
            self.pixels[dst_off..dst_off + bytes].copy_from_slice(&src[src_off..src_off + bytes]);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn blit_scaled_rgba(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        src: &[u8],
        src_w: u32,
        src_h: u32,
    ) {
        self.blit_scaled_rgba_rounded(x, y, w, h, src, src_w, src_h, [0.0; 4]);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn blit_scaled_rgba_rounded_hint(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        src: &[u8],
        src_w: u32,
        src_h: u32,
        radius: [f32; 4],
    ) {
        let dst_w = w.round().max(0.0) as u32;
        let dst_h = h.round().max(0.0) as u32;
        if (dst_w, dst_h) == (src_w, src_h)
            && src_w > 0
            && src.len() >= src_w as usize * src_h as usize * 4
        {
            if let Some(image) = tiny_skia::PixmapRef::from_bytes(src, src_w, src_h) {
                self.blit_image_rounded_hint(x, y, image, radius, true);
            }
            return;
        }
        self.blit_scaled_rgba_rounded(x, y, w, h, src, src_w, src_h, radius);
    }
    #[allow(clippy::too_many_arguments)]
    pub fn blit_scaled_rgba_rounded(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        src: &[u8],
        src_w: u32,
        src_h: u32,
        radius: [f32; 4],
    ) {
        if src_w == 0 || src_h == 0 || src.len() < src_w as usize * src_h as usize * 4 {
            return;
        }
        let dst_w = w.round().max(0.0) as u32;
        let dst_h = h.round().max(0.0) as u32;
        if dst_w == 0 || dst_h == 0 {
            return;
        }
        if (dst_w, dst_h) == (src_w, src_h) {
            if let Some(image) = tiny_skia::PixmapRef::from_bytes(src, src_w, src_h) {
                self.blit_image_rounded(x, y, image, radius);
            }
            return;
        }
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        let x0 = x.round() as i64;
        let y0 = y.round() as i64;
        let x1 = x0.max(cx1 as i64);
        let y1 = y0.max(cy1 as i64);
        let x2 = (x0 + i64::from(dst_w)).min(cx2 as i64);
        let y2 = (y0 + i64::from(dst_h)).min(cy2 as i64);
        if x2 <= x1 || y2 <= y1 {
            return;
        }
        crate::profiler::count("surface.resampled", 1);
        LAST_RESAMPLE.with(|last| {
            let sizes = (src_w, src_h, dst_w, dst_h);
            if last.get() != Some(sizes) {
                last.set(Some(sizes));
                crate::logging::warn(
                    "paint",
                    format!("resampling surface {src_w}x{src_h} into {dst_w}x{dst_h}"),
                );
            }
        });
        let src_stride = src_w as usize * 4;
        let dst_stride = self.width as usize * 4;
        let weight = |i: i64, origin: i64, dst_extent: u32, max: u32| {
            let pos = (((i - origin) as f32 + 0.5) * max as f32 / dst_extent as f32 - 0.5)
                .clamp(0.0, (max - 1) as f32);
            let lo = pos as usize;
            (lo, ((pos - lo as f32) * 256.0) as u32)
        };
        let columns: Vec<(usize, u32)> = (x1..x2)
            .map(|col| {
                let (lo, f) = weight(col, x0, dst_w, src_w);
                (lo * 4, f)
            })
            .collect();
        let row_bytes = columns.len() * 4;
        let hsample = |src_row: &[u8], out: &mut [u8]| {
            for (&(at, f), dst) in columns.iter().zip(out.chunks_exact_mut(4)) {
                let a = &src_row[at..at + 4];
                let b = if at + 8 <= src_row.len() {
                    &src_row[at + 4..at + 8]
                } else {
                    a
                };
                for c in 0..4 {
                    dst[c] = ((u32::from(a[c]) * (256 - f) + u32::from(b[c]) * f + 128) >> 8) as u8;
                }
            }
        };
        let mut top = (usize::MAX, vec![0u8; row_bytes]);
        let mut bottom = (usize::MAX, vec![0u8; row_bytes]);
        for row in y1..y2 {
            let (inset_l, inset_r) = corner_insets(radius, row - y0, i64::from(dst_h));
            let rx1 = x1.max(x0 + inset_l);
            let rx2 = x2.min(x0 + i64::from(dst_w) - inset_r);
            if rx2 <= rx1 {
                continue;
            }
            let (sy0, fy) = weight(row, y0, dst_h, src_h);
            let sy1 = (sy0 + 1).min(src_h as usize - 1);
            if top.0 != sy0 {
                if bottom.0 == sy0 {
                    std::mem::swap(&mut top, &mut bottom);
                } else {
                    hsample(&src[sy0 * src_stride..][..src_stride], &mut top.1);
                    top.0 = sy0;
                }
            }
            if fy != 0 && bottom.0 != sy1 {
                hsample(&src[sy1 * src_stride..][..src_stride], &mut bottom.1);
                bottom.0 = sy1;
            }
            let dst_off = row as usize * dst_stride + rx1 as usize * 4;
            let dst_row = &mut self.pixels[dst_off..dst_off + (rx2 - rx1) as usize * 4];
            let from = (rx1 - x1) as usize * 4;
            for ((dst, a), b) in dst_row
                .chunks_exact_mut(4)
                .zip(top.1[from..].chunks_exact(4))
                .zip(bottom.1[from..].chunks_exact(4))
            {
                let mut s = [0u8; 4];
                for c in 0..4 {
                    s[c] = ((u32::from(a[c]) * (256 - fy) + u32::from(b[c]) * fy + 128) >> 8) as u8;
                }
                match s[3] {
                    255 => dst.copy_from_slice(&s),
                    0 => {}
                    sa => blend_pixel(dst, &s, sa),
                }
            }
        }
    }

    pub fn stroke_path(
        &mut self,
        path: &tiny_skia::Path,
        color: [u8; 4],
        stroke: tiny_skia::Stroke,
    ) {
        self.paint_path_stroked(path, color, Some(stroke));
    }

    pub fn fill_path(&mut self, path: &tiny_skia::Path, color: [u8; 4]) {
        self.paint_path(path, color, None);
    }

    fn paint_path(&mut self, path: &tiny_skia::Path, color: [u8; 4], stroke_width: Option<f32>) {
        self.paint_path_stroked(
            path,
            color,
            stroke_width.map(|width| tiny_skia::Stroke {
                width,
                ..tiny_skia::Stroke::default()
            }),
        );
    }

    fn paint_path_stroked(
        &mut self,
        path: &tiny_skia::Path,
        color: [u8; 4],
        stroke: Option<tiny_skia::Stroke>,
    ) {
        self.paint_path_with(path, solid_paint(color), stroke);
    }

    fn paint_path_with(
        &mut self,
        path: &tiny_skia::Path,
        paint: tiny_skia::Paint<'static>,
        stroke: Option<tiny_skia::Stroke>,
    ) {
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        if cx1 == cx2 || cy1 == cy2 {
            return;
        }
        let pad = stroke.as_ref().map_or(0.0, |s| s.width) / 2.0 + 1.0;
        let bounds = path.bounds();
        if bounds.right() + pad <= cx1 as f32
            || bounds.bottom() + pad <= cy1 as f32
            || bounds.left() - pad >= cx2 as f32
            || bounds.top() - pad >= cy2 as f32
        {
            return;
        }
        tally(|s| &s.paths);
        let unclipped = (cx1, cy1, cx2, cy2) == (0, 0, self.width, self.height);
        let inside = unclipped
            || (bounds.left() - pad >= cx1 as f32
                && bounds.top() - pad >= cy1 as f32
                && bounds.right() + pad <= cx2 as f32
                && bounds.bottom() + pad <= cy2 as f32);
        if !inside {
            tally(|s| &s.paths_clipped);
            self.paint_path_clipped(path, paint, stroke, (cx1, cy1, cx2, cy2), pad);
            return;
        }
        let Some(mut pixmap) =
            tiny_skia::PixmapMut::from_bytes(&mut self.pixels, self.width, self.height)
        else {
            return;
        };
        match stroke {
            None => pixmap.fill_path(
                path,
                &paint,
                tiny_skia::FillRule::Winding,
                tiny_skia::Transform::identity(),
                None,
            ),
            Some(stroke) => pixmap.stroke_path(
                path,
                &paint,
                &stroke,
                tiny_skia::Transform::identity(),
                None,
            ),
        }
    }

    fn paint_path_clipped(
        &mut self,
        path: &tiny_skia::Path,
        paint: tiny_skia::Paint<'static>,
        stroke: Option<tiny_skia::Stroke>,
        clip: (u32, u32, u32, u32),
        pad: f32,
    ) {
        let bounds = path.bounds();
        let (cx1, cy1, cx2, cy2) = clip;
        let x1 = ((bounds.left() - pad).floor().max(0.0) as u32).max(cx1);
        let y1 = ((bounds.top() - pad).floor().max(0.0) as u32).max(cy1);
        let x2 = ((bounds.right() + pad).ceil().max(0.0) as u32).min(cx2);
        let y2 = ((bounds.bottom() + pad).ceil().max(0.0) as u32).min(cy2);
        if x2 <= x1 || y2 <= y1 {
            return;
        }
        let (w, h) = (x2 - x1, y2 - y1);
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.clear();
        scratch.resize(w as usize * h as usize * 4, 0);
        if let Some(mut pixmap) = tiny_skia::PixmapMut::from_bytes(&mut scratch, w, h) {
            let shift = tiny_skia::Transform::from_translate(-(x1 as f32), -(y1 as f32));
            match stroke {
                None => pixmap.fill_path(path, &paint, tiny_skia::FillRule::Winding, shift, None),
                Some(stroke) => pixmap.stroke_path(path, &paint, &stroke, shift, None),
            }
            let row_bytes = w as usize * 4;
            for row in 0..h as usize {
                let dst = ((y1 as usize + row) * self.width as usize + x1 as usize) * 4;
                blend_row(
                    &mut self.pixels[dst..dst + row_bytes],
                    &scratch[row * row_bytes..][..row_bytes],
                );
            }
        }
        self.scratch = scratch;
    }
}

pub(crate) fn rounded_rect_path(
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    radius: [f32; 4],
) -> Option<tiny_skia::Path> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let mut r = radius.map(|r| r.max(0.0).min(w / 2.0).min(h / 2.0));
    for v in &mut r {
        if *v < 0.5 {
            *v = 0.0;
        }
    }
    let [tl, tr, br, bl] = r;
    if r == [0.0; 4] {
        return Some(tiny_skia::PathBuilder::from_rect(
            tiny_skia::Rect::from_xywh(x, y, w, h)?,
        ));
    }
    const K: f32 = 0.552_284_8; // circle approximation
    let mut pb = tiny_skia::PathBuilder::new();
    pb.move_to(x + tl, y);
    pb.line_to(x + w - tr, y);
    if tr > 0.0 {
        let k = tr * (1.0 - K);
        pb.cubic_to(x + w - k, y, x + w, y + k, x + w, y + tr);
    }
    pb.line_to(x + w, y + h - br);
    if br > 0.0 {
        let k = br * (1.0 - K);
        pb.cubic_to(x + w, y + h - k, x + w - k, y + h, x + w - br, y + h);
    }
    pb.line_to(x + bl, y + h);
    if bl > 0.0 {
        let k = bl * (1.0 - K);
        pb.cubic_to(x + k, y + h, x, y + h - k, x, y + h - bl);
    }
    pb.line_to(x, y + tl);
    if tl > 0.0 {
        let k = tl * (1.0 - K);
        pb.cubic_to(x, y + k, x + k, y, x + tl, y);
    }
    pb.close();
    pb.finish()
}

pub fn measure_text(font: &fontdue::Font, text: &str, px: f32) -> f32 {
    measure_marked(font, text, 0..text.len(), px, &[])
}

pub(crate) fn measure_marked(
    font: &fontdue::Font,
    text: &str,
    range: std::ops::Range<usize>,
    px: f32,
    marks: &[Mark],
) -> f32 {
    ADVANCE_CACHE.with_borrow_mut(|cache| {
        text[range.clone()]
            .char_indices()
            .map(|(i, ch)| {
                if ch == MARK_CHAR {
                    return mark_advance_at(marks, range.start + i);
                }
                *cache
                    .entry((font.file_hash(), ch, px.to_bits()))
                    .or_insert_with(|| font.metrics(ch, px).advance_width)
            })
            .sum()
    })
}

pub(crate) fn char_advance(
    font: &fontdue::Font,
    ch: char,
    offset: usize,
    px: f32,
    marks: &[Mark],
) -> f32 {
    if ch == MARK_CHAR {
        return mark_advance_at(marks, offset);
    }
    ADVANCE_CACHE.with_borrow_mut(|cache| {
        *cache
            .entry((font.file_hash(), ch, px.to_bits()))
            .or_insert_with(|| font.metrics(ch, px).advance_width)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_inside_an_occluder_are_skipped_until_it_is_withdrawn() {
        let mut canvas = Canvas::new(10, 10);
        canvas.fill([0, 0, 0, 255]);
        let token = canvas.add_occluder(2.0, 2.0, 6.0, 6.0);

        canvas.fill_rounded_rect(3.0, 3.0, 2.0, 2.0, [0.0; 4], [255, 0, 0, 255]);
        assert_eq!(canvas.pixels[(3 * 10 + 3) * 4], 0, "fill inside the occluder must be skipped");

        canvas.fill_rounded_rect(0.0, 0.0, 2.0, 2.0, [0.0; 4], [255, 0, 0, 255]);
        assert_eq!(canvas.pixels[0], 255, "fill outside the occluder must paint");

        canvas.fill_rounded_rect(1.0, 1.0, 4.0, 4.0, [0.0; 4], [0, 255, 0, 255]);
        assert_eq!(
            canvas.pixels[(1 * 10 + 1) * 4 + 1],
            255,
            "fill straddling the occluder edge must paint"
        );

        canvas.remove_occluder(token);
        canvas.fill_rounded_rect(3.0, 3.0, 2.0, 2.0, [0.0; 4], [0, 0, 255, 255]);
        assert_eq!(
            canvas.pixels[((3 * 10 + 3) * 4) + 2],
            255,
            "after withdrawal the same fill must paint, as a modal above the surface would"
        );
    }

    #[test]
    fn a_fill_straddling_an_occluder_paints_only_the_uncovered_bands() {
        let mut canvas = Canvas::new(10, 10);
        canvas.fill([0, 0, 0, 255]);
        canvas.add_occluder(2.0, 2.0, 6.0, 6.0);
        canvas.fill_rect(0, 0, 10, 10, [255, 0, 0, 255]);

        assert_eq!(canvas.pixels[0], 255, "outside the occluder the fill paints");
        assert_eq!(canvas.pixels[(9 * 10 + 9) * 4], 255, "all four bands paint");
        assert_eq!(
            canvas.pixels[(5 * 10 + 5) * 4],
            0,
            "under the occluder nothing paints"
        );
        assert_eq!(canvas.pixels[(2 * 10 + 1) * 4], 255, "the band edge is exact");
        assert_eq!(canvas.pixels[(2 * 10 + 2) * 4], 0, "the hole edge is exact");
    }

    #[test]
    fn scaled_blit_interpolates_instead_of_dropping_pixels() {
        let mut canvas = Canvas::new(3, 1);
        canvas.fill([0, 0, 0, 255]);
        let src: Vec<u8> = [[0u8, 0, 0, 255], [255, 255, 255, 255]].concat();
        canvas.blit_scaled_rgba(0.0, 0.0, 3.0, 1.0, &src, 2, 1);
        let middle = canvas.pixels[4];
        assert!(
            middle > 60 && middle < 200,
            "upscale midpoint should be a blend, got {middle}"
        );

        let mut down = Canvas::new(3, 1);
        down.fill([0, 0, 0, 255]);
        let ramp: Vec<u8> = (0..4).flat_map(|i| [i * 80, i * 80, i * 80, 255]).collect();
        down.blit_scaled_rgba(0.0, 0.0, 3.0, 1.0, &ramp, 4, 1);
        assert!(
            down.pixels[0] < down.pixels[4] && down.pixels[4] < down.pixels[8],
            "downscale must keep the gradient, got {:?}",
            [down.pixels[0], down.pixels[4], down.pixels[8]]
        );
    }

    #[test]
    fn fill_rect_clamps_to_bounds() {
        let mut canvas = Canvas::new(4, 4);
        canvas.fill_rect(2, 2, 100, 100, [1, 2, 3, 4]);
        assert_eq!(&canvas.pixels[((3 * 4 + 3) * 4) as usize..], &[1, 2, 3, 4]);
        assert_eq!(&canvas.pixels[0..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn blend_mask_full_coverage_replaces_half_blends() {
        let mut canvas = Canvas::new(2, 1);
        canvas.fill([0, 0, 0, 255]);
        canvas.blend_mask(0, 0, 2, 1, &[255, 128], [200, 100, 50, 255], 0, 0.0);
        assert_eq!(&canvas.pixels[0..4], &[200, 100, 50, 255]);
        let half = &canvas.pixels[4..8];
        assert_eq!(half[0], (200 * 128 / 255) as u8);
        assert_eq!(half[3], 255);
    }

    #[test]
    fn clip_restricts_all_drawing_and_pops_back_off() {
        let mut canvas = Canvas::new(4, 1);
        canvas.push_clip(1.0, 0.0, 2.0, 1.0);
        canvas.fill_rect(0, 0, 4, 1, [7, 7, 7, 255]);
        canvas.blend_mask(0, 0, 4, 1, &[255; 4], [9, 9, 9, 255], 0, 0.0);
        assert_eq!(
            &canvas.pixels[0..4],
            &[0, 0, 0, 0],
            "left of clip untouched"
        );
        assert_eq!(&canvas.pixels[4..8], &[9, 9, 9, 255]);
        assert_eq!(
            &canvas.pixels[12..16],
            &[0, 0, 0, 0],
            "right of clip untouched"
        );

        canvas.pop_clip();
        canvas.fill_rect(0, 0, 4, 1, [7, 7, 7, 255]);
        assert_eq!(&canvas.pixels[0..4], &[7, 7, 7, 255]);
    }

    #[test]
    fn nested_clips_intersect() {
        let mut canvas = Canvas::new(4, 1);
        canvas.push_clip(0.0, 0.0, 3.0, 1.0);
        canvas.push_clip(2.0, 0.0, 2.0, 1.0);
        canvas.fill_rect(0, 0, 4, 1, [7, 7, 7, 255]);
        assert_eq!(&canvas.pixels[4..8], &[0, 0, 0, 0]);
        assert_eq!(&canvas.pixels[8..12], &[7, 7, 7, 255]);
        assert_eq!(&canvas.pixels[12..16], &[0, 0, 0, 0]);
    }

    #[test]
    fn clip_masks_path_painting() {
        let mut canvas = Canvas::new(4, 4);
        canvas.push_clip(0.0, 0.0, 2.0, 4.0);
        canvas.fill_rounded_rect(0.0, 0.0, 4.0, 4.0, [0.0; 4], [8, 8, 8, 255]);
        assert_eq!(&canvas.pixels[0..4], &[8, 8, 8, 255]);
        assert_eq!(
            &canvas.pixels[8..12],
            &[0, 0, 0, 0],
            "beyond clip untouched"
        );
    }

    #[test]
    fn rounded_path_crossing_the_clip_edge_is_clipped() {
        let mut canvas = Canvas::new(16, 8);
        canvas.push_clip(0.0, 0.0, 8.0, 8.0);
        canvas.fill_rounded_rect(0.0, 0.0, 16.0, 8.0, [2.0; 4], [8, 8, 8, 255]);
        let px = |x: u32, y: u32| &canvas.pixels[((y * 16 + x) * 4) as usize..][..4];
        assert_eq!(px(4, 4), &[8, 8, 8, 255], "inside clip painted");
        assert_eq!(px(12, 4), &[0, 0, 0, 0], "beyond clip untouched");
    }

    #[test]
    fn rounded_path_inside_the_clip_still_paints() {
        let mut canvas = Canvas::new(16, 8);
        canvas.push_clip(0.0, 0.0, 16.0, 8.0);
        canvas.fill_rounded_rect(4.0, 2.0, 8.0, 4.0, [1.5; 4], [8, 8, 8, 255]);
        let px = |x: u32, y: u32| &canvas.pixels[((y * 16 + x) * 4) as usize..][..4];
        assert_eq!(px(8, 4), &[8, 8, 8, 255], "painted");
        assert_eq!(px(1, 4), &[0, 0, 0, 0], "outside the rect untouched");
    }

    #[test]
    fn repainting_under_the_same_clip_stays_clipped() {
        let mut canvas = Canvas::new(16, 8);
        canvas.push_clip(0.0, 0.0, 8.0, 8.0);
        canvas.fill_rounded_rect(0.0, 0.0, 16.0, 8.0, [2.0; 4], [8, 8, 8, 255]);
        canvas.pop_clip();
        canvas.push_clip(0.0, 0.0, 8.0, 8.0);
        canvas.fill_rounded_rect(0.0, 0.0, 16.0, 8.0, [2.0; 4], [5, 5, 5, 255]);
        let px = |x: u32, y: u32| &canvas.pixels[((y * 16 + x) * 4) as usize..][..4];
        assert_eq!(px(4, 4), &[5, 5, 5, 255], "second fill clipped the same");
        assert_eq!(px(12, 4), &[0, 0, 0, 0], "beyond clip still untouched");
    }

    #[test]
    fn per_corner_radius_rounds_only_bottom_corners() {
        let mut canvas = Canvas::new(12, 12);

        canvas.fill_rounded_rect(0.0, 0.0, 12.0, 12.0, [0.0, 0.0, 6.0, 6.0], [9, 9, 9, 255]);
        let px = |x: u32, y: u32| &canvas.pixels[((y * 12 + x) * 4) as usize..][..4];
        assert_eq!(px(0, 0), &[9, 9, 9, 255], "top-left square");
        assert_eq!(px(11, 0), &[9, 9, 9, 255], "top-right square");
        assert_eq!(px(0, 11), &[0, 0, 0, 0], "bottom-left rounded away");
        assert_eq!(px(11, 11), &[0, 0, 0, 0], "bottom-right rounded away");
    }

    #[test]
    fn blit_image_copies_opaque_blends_alpha_and_respects_clip() {
        let mut source = tiny_skia::Pixmap::new(3, 1).unwrap();
        source.pixels_mut()[0] = tiny_skia::ColorU8::from_rgba(200, 0, 0, 255).premultiply();
        source.pixels_mut()[1] = tiny_skia::ColorU8::from_rgba(0, 200, 0, 128).premultiply();
        source.pixels_mut()[2] = tiny_skia::ColorU8::from_rgba(0, 0, 200, 255).premultiply();

        let mut canvas = Canvas::new(4, 1);
        canvas.fill([0, 0, 100, 255]);
        canvas.push_clip(0.0, 0.0, 3.0, 1.0);
        canvas.blit_image(1.0, 0.0, source.as_ref());
        canvas.pop_clip();

        assert_eq!(&canvas.pixels[0..4], &[0, 0, 100, 255], "left untouched");
        assert_eq!(&canvas.pixels[4..8], &[200, 0, 0, 255], "opaque copied");
        let blended = &canvas.pixels[8..12];
        assert!(blended[1] > 90, "semi-transparent green blended in");
        assert!(blended[2] > 40, "background blue survives under alpha");
        assert_eq!(
            &canvas.pixels[12..16],
            &[0, 0, 100, 255],
            "clip stops the last source pixel"
        );
    }

    #[test]
    fn blend_mask_clips_out_of_bounds_positions() {
        let mut canvas = Canvas::new(2, 2);
        canvas.blend_mask(-1, -1, 3, 3, &[255; 9], [10, 20, 30, 255], 0, 0.0);
        assert_eq!(&canvas.pixels[0..4], &[10, 20, 30, 255]);
    }

    #[test]
    fn gradient_fill_fades_along_its_axis_and_respects_the_silhouette() {
        let mut canvas = Canvas::new(100, 100);
        canvas.fill([255, 255, 255, 255]);
        let gradient = crate::style::LinearGradient {
            from: (0.0, 0.0),
            to: (1.0, 0.0),
            stops: vec![(0.0, [93, 156, 255, 200]), (1.0, [93, 156, 255, 0])],
        };
        canvas.fill_rounded_rect_gradient(10.0, 10.0, 60.0, 60.0, [12.0; 4], &gradient);
        // over white, the red channel dips where the blue lands
        let red = |x: u32, y: u32| canvas.pixels[((y * 100 + x) * 4) as usize];
        assert!(red(11, 40) < 200, "start edge barely tinted: {}", red(11, 40));
        assert!(red(11, 40) < red(30, 40), "{} !< {}", red(11, 40), red(30, 40));
        assert!(red(30, 40) < red(60, 40), "{} !< {}", red(30, 40), red(60, 40));
        assert_eq!(red(80, 40), 255, "painted outside the rect");
        assert_eq!(red(11, 11), 255, "painted outside the rounded corner");
    }
}

use crate::text_input::{MARK_CHAR, Mark, mark_advance_at};

type GlyphKey = (usize, char, u32);
type GlyphCache = std::collections::HashMap<GlyphKey, (fontdue::Metrics, Vec<u8>)>;
std::thread_local! {
    static GLYPH_CACHE: std::cell::RefCell<GlyphCache> = std::cell::RefCell::new(GlyphCache::new());
    static ADVANCE_CACHE: std::cell::RefCell<std::collections::HashMap<GlyphKey, f32>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

// Horizontal span to skip on a row so a blit stays inside rounded corners.
// radius order matches css: [top-left, top-right, bottom-right, bottom-left].
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

pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    clip_stack: Vec<(u32, u32, u32, u32)>,
    clip_mask: Option<(tiny_skia::Mask, (u32, u32, u32, u32))>,
}

impl Canvas {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; (width * height * 4) as usize],
            clip_stack: Vec::new(),
            clip_mask: None,
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

    // Slants glyphs by shifting each pixel row right proportionally to its
    // height above the baseline — a synthetic oblique, since we only load
    // regular font faces.
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
        self.draw_marked_sheared(font, text, 0..text.len(), x, baseline, px, color, &[], shear);
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
        // Distribute each row's coverage across the two pixels its fractional
        // offset lands on, so the slant is anti-aliased instead of stepped.
        let mut sheared = vec![0u8; w + 1];
        for row in 0..h {
            let py = y + row as i32;
            let offset = (baseline - py) as f32 * shear;
            let whole = offset.floor();
            let frac = offset - whole;
            for (i, out) in sheared.iter_mut().enumerate() {
                let right = if i < w { f32::from(mask[row * w + i]) * (1.0 - frac) } else { 0.0 };
                let left = if i > 0 { f32::from(mask[row * w + i - 1]) * frac } else { 0.0 };
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
    pub fn fill_rounded_rect(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: [f32; 4],
        color: [u8; 4],
    ) {
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let max_radius = radius.iter().fold(0.0f32, |a, &r| a.max(r));
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
    pub fn blit_image(&mut self, x: f32, y: f32, image: tiny_skia::PixmapRef<'_>) {
        self.blit_image_rounded(x, y, image, [0.0; 4]);
    }

    // Rounding costs one sqrt per corner row and nothing at radius zero: rows
    // just copy a shorter span near the corners, pixels are never transformed.
    pub fn blit_image_rounded(
        &mut self,
        x: f32,
        y: f32,
        image: tiny_skia::PixmapRef<'_>,
        radius: [f32; 4],
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
        let height = i64::from(image.height());
        for row in y1..y2 {
            let (inset_l, inset_r) = corner_insets(radius, row - y0, height);
            let rx1 = x1.max(x0 + inset_l);
            let rx2 = x2.min(x0 + i64::from(image.width()) - inset_r);
            if rx2 <= rx1 {
                continue;
            }
            let col0 = (rx1 - x0) as usize * 4;
            let col1 = (rx2 - x0) as usize * 4;
            let src_off = (row - y0) as usize * src_stride;
            let src_row = &src[src_off + col0..src_off + col1];
            let dst_off = ((row as u32 * self.width + rx1 as u32) * 4) as usize;
            let dst_row = &mut self.pixels[dst_off..dst_off + src_row.len()];
            for (dst, s) in dst_row.chunks_exact_mut(4).zip(src_row.chunks_exact(4)) {
                match s[3] {
                    255 => dst.copy_from_slice(s),
                    0 => {}
                    sa => {
                        let inv = 255 - u32::from(sa);
                        for (d, &sv) in dst.iter_mut().zip(s) {
                            *d = (u32::from(sv) + (u32::from(*d) * inv + 127) / 255).min(255) as u8;
                        }
                    }
                }
            }
        }
    }

    // Blits straight-alpha RGBA pixels into the destination rect, scaling
    // bilinearly when the sizes differ (e.g. a surface rendered at a reduced
    // resolution shown full size). Corner radii clip by shrinking row spans.
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
        let scale_x = src_w as f32 / dst_w as f32;
        let scale_y = src_h as f32 / dst_h as f32;
        let src_stride = src_w as usize * 4;
        let sample_axis = |i: i64, origin: i64, scale: f32, max: u32| {
            let center = ((i - origin) as f32 + 0.5) * scale - 0.5;
            let clamped = center.clamp(0.0, (max - 1) as f32);
            let lo = clamped.floor() as usize;
            (lo, (lo + 1).min(max as usize - 1), clamped - lo as f32)
        };
        // the x sample coordinates are identical for every row: build them once
        // instead of per pixel (this loop runs on multi-megapixel surfaces)
        let columns: Vec<(usize, usize, f32)> = (x1..x2)
            .map(|col| sample_axis(col, x0, scale_x, src_w))
            .collect();
        let stride = self.width as usize * 4;
        let region = &mut self.pixels[y1 as usize * stride..y2 as usize * stride];
        let paint_row = |row: i64, row_pixels: &mut [u8]| {
            let (inset_l, inset_r) = corner_insets(radius, row - y0, i64::from(dst_h));
            let rx1 = x1.max(x0 + inset_l);
            let rx2 = x2.min(x0 + i64::from(dst_w) - inset_r);
            if rx2 <= rx1 {
                return;
            }
            let (sy0, sy1, fy) = sample_axis(row, y0, scale_y, src_h);
            let dst_row =
                &mut row_pixels[rx1 as usize * 4..rx1 as usize * 4 + ((rx2 - rx1) as usize) * 4];
            let cols = &columns[(rx1 - x1) as usize..(rx2 - x1) as usize];
            for (&(sx0, sx1, fx), dst) in cols.iter().zip(dst_row.chunks_exact_mut(4)) {
                let texel = |sy: usize, sx: usize| &src[sy * src_stride + sx * 4..][..4];
                let (tl, tr) = (texel(sy0, sx0), texel(sy0, sx1));
                let (bl, br) = (texel(sy1, sx0), texel(sy1, sx1));
                let mut sample = [0u8; 4];
                for c in 0..4 {
                    let top = tl[c] as f32 + (tr[c] as f32 - tl[c] as f32) * fx;
                    let bottom = bl[c] as f32 + (br[c] as f32 - bl[c] as f32) * fx;
                    sample[c] = (top + (bottom - top) * fy).round() as u8;
                }
                match sample[3] {
                    255 => dst.copy_from_slice(&sample),
                    0 => {}
                    sa => {
                        let inv = 255 - u32::from(sa);
                        for (d, &sv) in dst.iter_mut().zip(&sample) {
                            *d = (u32::from(sv) + (u32::from(*d) * inv + 127) / 255).min(255) as u8;
                        }
                    }
                }
            }
        };
        let rows = y2 - y1;
        let area = rows * (x2 - x1);
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8))
            .unwrap_or(1);
        if area < 262_144 || threads < 2 {
            for (i, row_pixels) in region.chunks_exact_mut(stride).enumerate() {
                paint_row(y1 + i as i64, row_pixels);
            }
            return;
        }
        // rows are disjoint slices of the canvas, so bands can paint in parallel
        let band_rows = (rows as usize).div_ceil(threads);
        std::thread::scope(|scope| {
            for (band, band_pixels) in region.chunks_mut(band_rows * stride).enumerate() {
                let paint_row = &paint_row;
                scope.spawn(move || {
                    let first = y1 + (band * band_rows) as i64;
                    for (i, row_pixels) in band_pixels.chunks_exact_mut(stride).enumerate() {
                        paint_row(first + i as i64, row_pixels);
                    }
                });
            }
        });
    }

    pub(crate) fn fill_path(&mut self, path: &tiny_skia::Path, color: [u8; 4]) {
        self.paint_path(path, color, None);
    }

    pub(crate) fn stroke_path(
        &mut self,
        path: &tiny_skia::Path,
        color: [u8; 4],
        stroke: tiny_skia::Stroke,
    ) {
        self.paint_path_stroked(path, color, Some(stroke));
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
        let (cx1, cy1, cx2, cy2) = self.clip_bounds();
        if cx1 == cx2 || cy1 == cy2 {
            return;
        }
        let pad = stroke.as_ref().map_or(0.0, |s| s.width) / 2.0 + 1.0;
        let bounds = path.bounds();
        let inside = self.clip_stack.is_empty()
            || (bounds.left() - pad >= cx1 as f32
                && bounds.top() - pad >= cy1 as f32
                && bounds.right() + pad <= cx2 as f32
                && bounds.bottom() + pad <= cy2 as f32);
        let mask = if inside {
            None
        } else {
            self.ensure_clip_mask();
            self.clip_mask.as_ref().map(|(mask, _)| mask)
        };
        let Some(mut pixmap) =
            tiny_skia::PixmapMut::from_bytes(&mut self.pixels, self.width, self.height)
        else {
            return;
        };
        let mut paint = tiny_skia::Paint::default();
        paint.set_color_rgba8(color[0], color[1], color[2], color[3]);
        paint.anti_alias = true;
        match stroke {
            None => pixmap.fill_path(
                path,
                &paint,
                tiny_skia::FillRule::Winding,
                tiny_skia::Transform::identity(),
                mask,
            ),
            Some(stroke) => pixmap.stroke_path(
                path,
                &paint,
                &stroke,
                tiny_skia::Transform::identity(),
                mask,
            ),
        }
    }

    // tiny-skia has no scissor rect, so rect clips become a full-canvas
    // alpha mask, rebuilt only when a path is drawn under different bounds.
    fn ensure_clip_mask(&mut self) {
        let bounds = self.clip_bounds();
        if self
            .clip_mask
            .as_ref()
            .is_some_and(|(_, built_for)| *built_for == bounds)
        {
            return;
        }
        self.clip_mask = None;
        let (x1, y1, x2, y2) = bounds;
        let Some(mut mask) = tiny_skia::Mask::new(self.width, self.height) else {
            return;
        };
        let Some(rect) = tiny_skia::Rect::from_ltrb(x1 as f32, y1 as f32, x2 as f32, y2 as f32)
        else {
            return;
        };
        mask.fill_path(
            &tiny_skia::PathBuilder::from_rect(rect),
            tiny_skia::FillRule::Winding,
            false,
            tiny_skia::Transform::identity(),
        );
        self.clip_mask = Some((mask, bounds));
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
    fn rounded_path_inside_the_clip_skips_the_mask_but_still_paints() {
        let mut canvas = Canvas::new(16, 8);
        canvas.push_clip(0.0, 0.0, 16.0, 8.0);
        canvas.fill_rounded_rect(4.0, 2.0, 8.0, 4.0, [1.5; 4], [8, 8, 8, 255]);
        assert!(canvas.clip_mask.is_none(), "fully-inside path builds no mask");
        let px = |x: u32, y: u32| &canvas.pixels[((y * 16 + x) * 4) as usize..][..4];
        assert_eq!(px(8, 4), &[8, 8, 8, 255], "painted");
        assert_eq!(px(1, 4), &[0, 0, 0, 0], "outside the rect untouched");
    }

    #[test]
    fn clip_mask_survives_pop_push_of_the_same_bounds() {
        let mut canvas = Canvas::new(16, 8);
        canvas.push_clip(0.0, 0.0, 8.0, 8.0);
        canvas.fill_rounded_rect(0.0, 0.0, 16.0, 8.0, [2.0; 4], [8, 8, 8, 255]);
        assert!(canvas.clip_mask.is_some());
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
        canvas.fill_rounded_rect(
            0.0,
            0.0,
            12.0,
            12.0,
            [0.0, 0.0, 6.0, 6.0],
            [9, 9, 9, 255],
        );
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
}


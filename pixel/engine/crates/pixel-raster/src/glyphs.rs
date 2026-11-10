use pixel_core::system_fonts::{Face, face_for};

pub(crate) struct Glyph {
    pub(crate) metrics: fontdue::Metrics,
    pub(crate) pixels: Vec<u8>,
    pub(crate) color: bool,
}

pub(crate) fn rasterize(ch: char, px: f32) -> Option<Glyph> {
    let face = face_for(ch)?;
    let id = face.glyph_index(ch)?;
    let advance =
        f32::from(face.glyph_hor_advance(id).unwrap_or(0)) * px / f32::from(face.units_per_em());
    color_glyph(face, id, px, advance).or_else(|| outline_glyph(face, id, px, advance))
}

fn outline_glyph(face: &Face, id: ttf_parser::GlyphId, px: f32, advance: f32) -> Option<Glyph> {
    let scale = px / f32::from(face.units_per_em());
    let empty = Glyph {
        metrics: fontdue::Metrics {
            advance_width: advance,
            ..Default::default()
        },
        pixels: Vec::new(),
        color: false,
    };
    let Some(bounds) = face.glyph_bounding_box(id) else {
        return Some(empty);
    };
    let left = (f32::from(bounds.x_min) * scale).floor();
    let bottom = (f32::from(bounds.y_min) * scale).floor();
    let right = (f32::from(bounds.x_max) * scale).ceil();
    let top = (f32::from(bounds.y_max) * scale).ceil();
    let (width, height) = ((right - left) as u32, (top - bottom) as u32);
    let mut pen = Pen {
        path: tiny_skia::PathBuilder::new(),
        scale,
        left,
        top,
    };
    face.outline_glyph(id, &mut pen)?;
    let (Some(path), Some(mut pixmap)) = (pen.path.finish(), tiny_skia::Pixmap::new(width, height))
    else {
        return Some(empty);
    };
    pixmap.fill_path(
        &path,
        &tiny_skia::Paint::default(),
        tiny_skia::FillRule::Winding,
        tiny_skia::Transform::identity(),
        None,
    );
    Some(Glyph {
        metrics: fontdue::Metrics {
            xmin: left as i32,
            ymin: bottom as i32,
            width: width as usize,
            height: height as usize,
            advance_width: advance,
            ..Default::default()
        },
        pixels: pixmap.pixels().iter().map(|p| p.alpha()).collect(),
        color: false,
    })
}

struct Pen {
    path: tiny_skia::PathBuilder,
    scale: f32,
    left: f32,
    top: f32,
}

impl Pen {
    fn at(&self, x: f32, y: f32) -> (f32, f32) {
        (x * self.scale - self.left, self.top - y * self.scale)
    }
}

impl ttf_parser::OutlineBuilder for Pen {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.path.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.path.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let ((x1, y1), (x, y)) = (self.at(x1, y1), self.at(x, y));
        self.path.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let ((x1, y1), (x2, y2), (x, y)) = (self.at(x1, y1), self.at(x2, y2), self.at(x, y));
        self.path.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.path.close();
    }
}

fn color_glyph(face: &Face, id: ttf_parser::GlyphId, px: f32, advance: f32) -> Option<Glyph> {
    let image = face.glyph_raster_image(id, px.ceil() as u16)?;
    if image.format != ttf_parser::RasterImageFormat::PNG || image.pixels_per_em == 0 {
        return None;
    }
    let decoded = image::load_from_memory_with_format(image.data, image::ImageFormat::Png)
        .ok()?
        .to_rgba8();
    let scale = px / f32::from(image.pixels_per_em);
    let width = ((decoded.width() as f32 * scale).round() as u32).max(1);
    let height = ((decoded.height() as f32 * scale).round() as u32).max(1);
    let resized = image::imageops::resize(
        &decoded,
        width,
        height,
        image::imageops::FilterType::Triangle,
    );
    let mut pixels = resized.into_raw();
    for pixel in pixels.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        for channel in &mut pixel[..3] {
            *channel = ((u32::from(*channel) * alpha + 127) / 255) as u8;
        }
    }
    Some(Glyph {
        metrics: fontdue::Metrics {
            xmin: (f32::from(image.x) * scale).round() as i32,
            ymin: (f32::from(image.y) * scale).round() as i32,
            width: width as usize,
            height: height as usize,
            advance_width: advance,
            ..Default::default()
        },
        pixels,
        color: true,
    })
}


#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn finds_system_fonts_for_scripts_the_bundled_fonts_lack() {
        for ch in ['٩', 'ᗜ', 'و', 'ไ', '漢', '한', 'ಠ'] {
            let glyph = rasterize(ch, 24.0).unwrap_or_else(|| panic!("no system font for {ch}"));
            assert!(
                !glyph.color && glyph.pixels.iter().any(|&a| a > 0),
                "{ch} rendered blank"
            );
        }
    }

    #[test]
    fn emoji_come_back_as_colour_bitmaps() {
        let glyph = rasterize('🙂', 24.0).unwrap();
        assert!(glyph.color);
        assert_eq!(
            glyph.pixels.len(),
            glyph.metrics.width * glyph.metrics.height * 4
        );
        assert!(glyph.metrics.width >= 18 && glyph.metrics.width <= 32);
    }
}

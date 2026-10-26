use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type Face = ttf_parser::Face<'static>;

pub(crate) struct Glyph {
    pub(crate) metrics: fontdue::Metrics,
    pub(crate) pixels: Vec<u8>,
    pub(crate) color: bool,
}

#[derive(Clone)]
enum FaceIn {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Index(u32),
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    PostScriptName(String),
}

#[derive(Default)]
struct Store {
    files: HashMap<PathBuf, Option<&'static [u8]>>,
    faces: HashMap<(PathBuf, u32), &'static Face>,
    by_char: HashMap<char, Option<&'static Face>>,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn face_for(ch: char) -> Option<&'static Face> {
    let mut guard = STORE.lock().unwrap();
    let store = guard.get_or_insert_with(Store::default);
    if let Some(found) = store.by_char.get(&ch) {
        return *found;
    }
    let found = candidates(ch)
        .filter_map(|(path, which)| store.load(&path, which, ch))
        .find(|face| face.glyph_index(ch).is_some() && drawable(face));
    store.by_char.insert(ch, found);
    found
}

impl Store {
    fn load(&mut self, path: &Path, which: FaceIn, ch: char) -> Option<&'static Face> {
        let data = *self
            .files
            .entry(path.to_path_buf())
            .or_insert_with(|| map_file(path))
            .as_ref()?;
        let count = ttf_parser::fonts_in_collection(data).unwrap_or(1);
        let face_where = |test: &dyn Fn(&Face) -> bool| {
            (0..count).find(|&i| ttf_parser::Face::parse(data, i).is_ok_and(|face| test(&face)))
        };
        let index = match which {
            FaceIn::Index(index) => index,
            FaceIn::PostScriptName(_) if count == 1 => 0,
            // Variable fonts report a named instance such as PingFangSC-Regular, which no face in
            // the file is called, so take the first face that has the character instead.
            FaceIn::PostScriptName(name) => {
                face_where(&|face| postscript_name(face).as_deref() == Some(name.as_str()))
                    .or_else(|| face_where(&|face| face.glyph_index(ch).is_some()))?
            }
        };
        if let Some(face) = self.faces.get(&(path.to_path_buf(), index)) {
            return Some(face);
        }
        let face: &'static Face = Box::leak(Box::new(ttf_parser::Face::parse(data, index).ok()?));
        self.faces.insert((path.to_path_buf(), index), face);
        Some(face)
    }
}

fn drawable(face: &Face) -> bool {
    let tables = face.tables();
    tables.glyf.is_some()
        || tables.cff.is_some()
        || tables.cff2.is_some()
        || tables.sbix.is_some()
        || tables.cbdt.is_some()
}

fn postscript_name(face: &Face) -> Option<String> {
    face.names()
        .into_iter()
        .filter(|name| name.name_id == ttf_parser::name_id::POST_SCRIPT_NAME)
        .find_map(|name| {
            name.to_string()
                .or_else(|| String::from_utf8(name.name.to_vec()).ok())
        })
}

// Font files stay mapped for the life of the process; the system shares their pages
// with every other app, so even large emoji and CJK collections cost little memory.
#[allow(unsafe_code)]
fn map_file(path: &Path) -> Option<&'static [u8]> {
    let file = std::fs::File::open(path).ok()?;
    let len = usize::try_from(file.metadata().ok()?.len()).ok()?;
    if len == 0 {
        return None;
    }
    // SAFETY: a fresh read-only private mapping of an open file; system font files are not rewritten in place.
    let ptr = unsafe {
        rustix::mm::mmap(
            std::ptr::null_mut(),
            len,
            rustix::mm::ProtFlags::READ,
            rustix::mm::MapFlags::PRIVATE,
            &file,
            0,
        )
    }
    .ok()?;
    // SAFETY: the mapping is `len` bytes long and is never unmapped.
    Some(unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len) })
}

pub(crate) fn advance(ch: char, px: f32) -> Option<f32> {
    let face = face_for(ch)?;
    let id = face.glyph_index(ch)?;
    Some(f32::from(face.glyph_hor_advance(id).unwrap_or(0)) * px / f32::from(face.units_per_em()))
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

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod core_text {
    use super::FaceIn;
    use std::ffi::c_void;
    use std::os::unix::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    type Ref = *const c_void;

    #[repr(C)]
    struct CFRange {
        location: isize,
        length: isize,
    }

    #[link(name = "CoreText", kind = "framework")]
    unsafe extern "C" {
        static kCTFontURLAttribute: Ref;
        static kCTFontNameAttribute: Ref;
        fn CTFontCreateWithName(name: Ref, size: f64, matrix: Ref) -> Ref;
        fn CTFontCreateForString(current: Ref, string: Ref, range: CFRange) -> Ref;
        fn CTFontDescriptorCopyAttribute(descriptor: Ref, attribute: Ref) -> Ref;
        fn CTFontCopyDefaultCascadeListForLanguages(font: Ref, languages: Ref) -> Ref;
        fn CTFontCopyAttribute(font: Ref, attribute: Ref) -> Ref;
        fn CTFontCopyPostScriptName(font: Ref) -> Ref;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFArrayGetCount(array: Ref) -> isize;
        fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
        fn CFStringCreateWithBytes(
            alloc: Ref,
            bytes: *const u8,
            len: isize,
            encoding: u32,
            external: u8,
        ) -> Ref;
        fn CFStringGetCString(string: Ref, buf: *mut u8, size: isize, encoding: u32) -> u8;
        fn CFURLGetFileSystemRepresentation(url: Ref, resolve: u8, buf: *mut u8, size: isize)
        -> u8;
        fn CFRelease(object: Ref);
    }

    const UTF8: u32 = 0x0800_0100;

    struct Owned(Ref);

    impl Owned {
        fn new(object: Ref) -> Option<Self> {
            (!object.is_null()).then(|| Self(object))
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: Owned only wraps non-null objects from Create or Copy calls, released once here.
            unsafe { CFRelease(self.0) }
        }
    }

    fn cf_string(text: &str) -> Option<Owned> {
        // SAFETY: the bytes are valid UTF-8 for the given length.
        Owned::new(unsafe {
            CFStringCreateWithBytes(
                std::ptr::null(),
                text.as_ptr(),
                text.len() as isize,
                UTF8,
                0,
            )
        })
    }

    fn base_font() -> Option<Owned> {
        let name = cf_string("Menlo")?;
        // SAFETY: name is a live string.
        Owned::new(unsafe { CTFontCreateWithName(name.0, 16.0, std::ptr::null()) })
    }

    fn font_location(font: &Owned) -> Option<(PathBuf, FaceIn)> {
        // SAFETY: font is a live font object.
        let url = Owned::new(unsafe { CTFontCopyAttribute(font.0, kCTFontURLAttribute) })?;
        // SAFETY: font is a live font object.
        let name = Owned::new(unsafe { CTFontCopyPostScriptName(font.0) })?;
        location(&url, &name)
    }

    fn descriptor_location(descriptor: Ref) -> Option<(PathBuf, FaceIn)> {
        // SAFETY: descriptor is a live font descriptor.
        let url =
            Owned::new(unsafe { CTFontDescriptorCopyAttribute(descriptor, kCTFontURLAttribute) })?;
        // SAFETY: descriptor is a live font descriptor.
        let name =
            Owned::new(unsafe { CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) })?;
        location(&url, &name)
    }

    fn location(url: &Owned, name: &Owned) -> Option<(PathBuf, FaceIn)> {
        let mut path = [0u8; 1024];
        let mut postscript = [0u8; 256];
        // SAFETY: the buffers outlive the calls and their lengths are passed alongside them.
        let copied = unsafe {
            CFURLGetFileSystemRepresentation(url.0, 1, path.as_mut_ptr(), path.len() as isize) != 0
                && CFStringGetCString(
                    name.0,
                    postscript.as_mut_ptr(),
                    postscript.len() as isize,
                    UTF8,
                ) != 0
        };
        if !copied {
            return None;
        }
        let path = std::ffi::CStr::from_bytes_until_nul(&path).ok()?;
        let postscript = std::ffi::CStr::from_bytes_until_nul(&postscript)
            .ok()?
            .to_str()
            .ok()?;
        (postscript != "LastResort").then(|| {
            (
                PathBuf::from(std::ffi::OsStr::from_bytes(path.to_bytes())),
                FaceIn::PostScriptName(postscript.to_string()),
            )
        })
    }

    fn font_for(ch: char) -> Option<(PathBuf, FaceIn)> {
        let base = base_font()?;
        let mut utf8 = [0u8; 4];
        let text = cf_string(ch.encode_utf8(&mut utf8))?;
        let range = CFRange {
            location: 0,
            length: ch.len_utf16() as isize,
        };
        // SAFETY: base and text are live, and the range covers exactly the string.
        font_location(&Owned::new(unsafe {
            CTFontCreateForString(base.0, text.0, range)
        })?)
    }

    fn cascade() -> &'static [(PathBuf, FaceIn)] {
        static CASCADE: OnceLock<Vec<(PathBuf, FaceIn)>> = OnceLock::new();
        CASCADE.get_or_init(|| {
            let Some(base) = base_font() else {
                return Vec::new();
            };
            // SAFETY: base is a live font; a null language list means the user's preferred languages.
            let Some(list) = Owned::new(unsafe {
                CTFontCopyDefaultCascadeListForLanguages(base.0, std::ptr::null())
            }) else {
                return Vec::new();
            };
            // SAFETY: list is a live array of font descriptors, read within its bounds.
            (0..unsafe { CFArrayGetCount(list.0) })
                // SAFETY: i is within the array, and the descriptor stays alive while list does.
                .filter_map(|i| descriptor_location(unsafe { CFArrayGetValueAtIndex(list.0, i) }))
                .collect()
        })
    }

    pub(super) fn candidates(ch: char) -> impl Iterator<Item = (PathBuf, FaceIn)> {
        font_for(ch).into_iter().chain(cascade().iter().cloned())
    }
}

#[cfg(target_os = "macos")]
use core_text::candidates;

#[cfg(target_os = "linux")]
fn candidates(ch: char) -> impl Iterator<Item = (PathBuf, FaceIn)> {
    fontconfig_match(ch).into_iter()
}

#[cfg(target_os = "linux")]
fn fontconfig_match(ch: char) -> Option<(PathBuf, FaceIn)> {
    let output = std::process::Command::new("fc-match")
        .arg("--format=%{file}\n%{index}")
        .arg(format!("monospace:charset={:x}", ch as u32))
        .output()
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let (path, index) = text.split_once('\n')?;
    Some((
        PathBuf::from(path),
        FaceIn::Index(index.trim().parse().ok()?),
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn candidates(_: char) -> std::iter::Empty<(PathBuf, FaceIn)> {
    std::iter::empty()
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

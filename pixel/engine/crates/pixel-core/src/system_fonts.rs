use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub type Face = ttf_parser::Face<'static>;

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

pub fn face_for(ch: char) -> Option<&'static Face> {
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

pub fn advance(ch: char, px: f32) -> Option<f32> {
    let face = face_for(ch)?;
    let id = face.glyph_index(ch)?;
    Some(f32::from(face.glyph_hor_advance(id).unwrap_or(0)) * px / f32::from(face.units_per_em()))
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


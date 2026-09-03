use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PasteSource {
    Clipboard,
    Osc,
    File,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PastedImage {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub source: PasteSource,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) fn temp_path(ext: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("pixel-attachments");
    let _ = std::fs::create_dir_all(&dir);
    let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("paste-{}-{n}.{ext}", std::process::id()))
}

fn dims(path: &Path) -> Option<(u32, u32)> {
    image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

fn from_file(path: &Path, source: PasteSource) -> Option<PastedImage> {
    let (width, height) = dims(path)?;
    Some(PastedImage {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
        source,
    })
}

pub(crate) enum WorkerPaste {
    File(PastedImage),
    Bitmap {
        pasted: PastedImage,
        rgba: image::RgbaImage,
    },
}

pub(crate) fn read_for_worker() -> Option<WorkerPaste> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    if let Ok(files) = clipboard.get().file_list()
        && let Some(pasted) = files.iter().find_map(|f| from_file(f, PasteSource::Clipboard))
    {
        return Some(WorkerPaste::File(pasted));
    }
    let img = clipboard.get_image().ok()?;
    let rgba = image::RgbaImage::from_raw(
        img.width as u32,
        img.height as u32,
        img.bytes.into_owned(),
    )?;
    let (width, height) = rgba.dimensions();
    let pasted = PastedImage {
        path: temp_path("png").to_string_lossy().into_owned(),
        width,
        height,
        source: PasteSource::Clipboard,
    };
    Some(WorkerPaste::Bitmap { pasted, rgba })
}

pub fn image_path_from_paste(text: &str) -> Option<PastedImage> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains('\n') {
        return None;
    }
    let path = pasted_path(trimmed.trim_matches(|c| c == '\'' || c == '"'))?;
    if !path.is_file() {
        return None;
    }
    from_file(&path, PasteSource::File)
}

#[cfg(unix)]
fn pasted_path(text: &str) -> Option<PathBuf> {
    let path = match text.strip_prefix("file://") {
        Some(rest) => percent_decode(rest),
        None => unescape(text),
    };
    if !path.starts_with('/') && !path.starts_with('~') {
        return None;
    }
    match path.strip_prefix("~/") {
        Some(rest) => Some(Path::new(&std::env::var("HOME").ok()?).join(rest)),
        None => Some(PathBuf::from(path)),
    }
}

#[cfg(windows)]
fn pasted_path(text: &str) -> Option<PathBuf> {
    let path = match text.strip_prefix("file://") {
        Some(rest) => url_path(&percent_decode(rest)),
        None => PathBuf::from(text),
    };
    path.is_absolute().then_some(path)
}

// file:///C:/pictures/a.png names a drive, while file://box/share/a.png names
// another machine, and windows spells those two very differently.
#[cfg(windows)]
fn url_path(rest: &str) -> PathBuf {
    match rest.strip_prefix('/') {
        Some(drive) => PathBuf::from(drive),
        None => PathBuf::from(format!(r"\\{}", rest.replace('/', "\\"))),
    }
}

#[cfg(unix)]
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| u8::from_str_radix(&s[i + 1..i + 3], 16).ok())
            .flatten();
        match decoded {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_png(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("pixel-clipboard-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        image::RgbaImage::from_pixel(6, 4, image::Rgba([1, 2, 3, 255]))
            .save(&path)
            .unwrap();
        path
    }

    #[test]
    fn plain_path_paste_detects_an_image() {
        let path = temp_png("plain.png");
        let pasted = image_path_from_paste(&path.to_string_lossy()).unwrap();
        assert_eq!((pasted.width, pasted.height), (6, 4));
    }

    #[test]
    fn quoted_paths_normalize() {
        let path = temp_png("with space.png");
        assert!(image_path_from_paste(&format!("'{}'", path.to_string_lossy())).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn escaped_spaces_normalize() {
        let path = temp_png("with space.png");
        assert!(image_path_from_paste(&path.to_string_lossy().replace(' ', "\\ ")).is_some());
    }

    #[test]
    fn file_urls_percent_decode() {
        let path = temp_png("url space.png");
        let escaped = path.to_string_lossy().replace(' ', "%20");
        #[cfg(unix)]
        let url = format!("file://{escaped}");
        #[cfg(windows)]
        let url = format!("file:///{}", escaped.replace('\\', "/"));
        assert!(image_path_from_paste(&url).is_some());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_take_either_separator() {
        let path = temp_png("slashes.png");
        let raw = path.to_string_lossy().into_owned();
        assert!(image_path_from_paste(&raw).is_some());
        assert!(image_path_from_paste(&raw.replace('\\', "/")).is_some());
    }

    #[cfg(windows)]
    #[test]
    fn file_urls_naming_a_machine_become_share_paths() {
        assert_eq!(
            pasted_path("file://box/share/shot.png"),
            Some(PathBuf::from(r"\\box\share\shot.png"))
        );
        assert_eq!(
            pasted_path("file:///C:/pictures/shot.png"),
            Some(PathBuf::from("C:/pictures/shot.png"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_drive_without_a_path_is_not_a_path() {
        assert!(pasted_path("C:").is_none());
        assert!(pasted_path("C:shot.png").is_none());
        assert!(pasted_path("shot.png").is_none());
        assert!(pasted_path("/pictures/shot.png").is_none());
    }

    #[test]
    fn ordinary_text_is_not_a_path() {
        assert!(image_path_from_paste("hello world").is_none());
        assert!(image_path_from_paste("/does/not/exist.png").is_none());
        assert!(image_path_from_paste("one\n/two.png").is_none());
    }

    #[test]
    fn non_image_files_are_rejected() {
        let dir = std::env::temp_dir().join("pixel-clipboard-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.txt");
        std::fs::write(&path, "just text").unwrap();
        assert!(image_path_from_paste(&path.to_string_lossy()).is_none());
    }
}

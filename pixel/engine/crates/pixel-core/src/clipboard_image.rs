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
    let path = pasted_path(text, std::env::var(HOME_VAR).ok().as_deref())?;
    if !path.is_file() {
        return None;
    }
    from_file(&path, PasteSource::File)
}

fn pasted_path(text: &str, home: Option<&str>) -> Option<PathBuf> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains('\n') {
        return None;
    }
    let unquoted = trimmed.trim_matches(|c| c == '\'' || c == '"');
    let path = match unquoted.strip_prefix("file://") {
        Some(rest) => file_url_path(percent_decode(rest)),
        None => unescape(unquoted),
    };
    let path = match path.strip_prefix("~/") {
        Some(rest) => Path::new(home?).join(rest),
        None => PathBuf::from(path),
    };
    names_a_local_file(&path).then_some(path)
}

const HOME_VAR: &str = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

// Touching a `\\host\share` path makes Windows sign in to that host, so only drive paths count.
#[cfg(windows)]
fn names_a_local_file(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    ) && path.is_absolute()
}

#[cfg(not(windows))]
fn names_a_local_file(path: &Path) -> bool {
    path.is_absolute()
}

// `file:///C:/x.png` names `C:/x.png` on Windows.
fn file_url_path(path: String) -> String {
    let bytes = path.as_bytes();
    let drive = cfg!(windows) && bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':';
    if drive { path[1..].to_string() } else { path }
}

// Backslash is the path separator on Windows, so pasted paths there are taken verbatim.
#[cfg(windows)]
fn unescape(s: &str) -> String {
    s.to_string()
}

#[cfg(not(windows))]
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

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pixel-clipboard-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_png(name: &str) -> PathBuf {
        let path = temp_dir().join(name);
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
    fn quoted_escaped_and_file_url_paths_normalize() {
        let path = temp_png("with space.png");
        let raw = path.to_string_lossy();
        assert!(image_path_from_paste(&format!("'{raw}'")).is_some());
        assert!(image_path_from_paste(&format!("\"{raw}\"")).is_some());
        if cfg!(not(windows)) {
            assert!(image_path_from_paste(&raw.replace(' ', "\\ ")).is_some());
        }
        let url_path = raw.replace('\\', "/").replace(' ', "%20");
        let url = if url_path.starts_with('/') { format!("file://{url_path}") } else { format!("file:///{url_path}") };
        assert!(image_path_from_paste(&url).is_some(), "{url}");
    }

    #[test]
    #[cfg(windows)]
    fn only_local_drive_paths_count_as_pasted_files() {
        let local = |text: &str| pasted_path(text, Some(r"C:\Users\me")).is_some();
        assert!(local(r"C:\Users\me\shot.png"));
        assert!(local("C:/Users/me/shot.png"));
        assert!(local(r"\\?\C:\Users\me\shot.png"));
        assert!(local("~/shot.png"));
        assert!(!local(r"\\attacker\share\shot.png"), "opening it would sign in to that host");
        assert!(!local("//attacker/share/shot.png"));
        assert!(!local(r"\\?\UNC\attacker\share\shot.png"));
        assert!(!local(r"\\.\pipe\shot.png"));
        assert!(!local(r"Users\me\shot.png"));
        assert!(!local("file://attacker/share/shot.png"));
        assert!(!local(r"~/\\attacker\share\shot.png"), "joining an absolute path drops the home directory");
        assert!(!local("~shot.png"));
    }

    #[test]
    #[cfg(not(windows))]
    fn only_absolute_paths_count_as_pasted_files() {
        let local = |text: &str| pasted_path(text, Some("/home/me")).is_some();
        assert!(local("/tmp/shot.png"));
        assert!(local("~/shot.png"));
        assert!(!local("tmp/shot.png"));
        assert!(!local("~shot.png"));
    }

    #[test]
    fn ordinary_text_and_non_image_files_are_rejected() {
        assert!(image_path_from_paste("hello world").is_none());
        assert!(image_path_from_paste("/does/not/exist.png").is_none());
        assert!(image_path_from_paste("one\n/two.png").is_none());
        let path = temp_dir().join("notes.txt");
        std::fs::write(&path, "just text").unwrap();
        assert!(image_path_from_paste(&path.to_string_lossy()).is_none());
    }
}

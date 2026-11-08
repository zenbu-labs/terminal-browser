use std::path::PathBuf;

use pixel_core::backend::{ClipboardImage, SystemClipboard};

pub(crate) struct Arboard;

impl SystemClipboard for Arboard {
    fn files(&self) -> Vec<PathBuf> {
        arboard::Clipboard::new()
            .ok()
            .and_then(|mut clipboard| clipboard.get().file_list().ok())
            .unwrap_or_default()
    }

    fn image(&self) -> Option<ClipboardImage> {
        let image = arboard::Clipboard::new().ok()?.get_image().ok()?;
        Some(ClipboardImage { width: image.width as u32, height: image.height as u32, rgba: image.bytes.into_owned() })
    }
}

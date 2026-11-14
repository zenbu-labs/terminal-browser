use std::io::Write;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::scene::Item;

static MISMATCHES: AtomicU64 = AtomicU64::new(0);

pub struct Settings {
    pub log: Option<std::path::PathBuf>,
    pub pictures: Option<std::path::PathBuf>,
}

pub fn settings() -> Option<&'static Settings> {
    static SETTINGS: OnceLock<Option<Settings>> = OnceLock::new();
    SETTINGS
        .get_or_init(|| {
            (std::env::var("PIXEL_VERIFY_DAMAGE").as_deref() == Ok("1")).then(|| Settings {
                log: std::env::var_os("PIXEL_VERIFY_DAMAGE_LOG").map(Into::into),
                pictures: std::env::var_os("PIXEL_VERIFY_DAMAGE_DIR").map(Into::into),
            })
        })
        .as_ref()
}

pub fn enabled() -> bool {
    settings().is_some()
}

pub fn mismatches() -> u64 {
    MISMATCHES.load(Ordering::Relaxed)
}

pub fn report(line: &str, ok: bool) {
    let Some(settings) = settings() else { return };
    if !ok {
        MISMATCHES.fetch_add(1, Ordering::Relaxed);
        crate::logging::warn("damage", line.to_string());
    }
    if let Some(path) = &settings.log
        && let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

pub fn drifted(fresh: &Item, kept: &Item) -> Option<String> {
    if fresh == kept {
        return None;
    }
    if fresh.children.len() == kept.children.len()
        && let Some(found) = fresh.children.iter().zip(&kept.children).find_map(|(a, b)| drifted(a, b))
    {
        return Some(found);
    }
    let parts: [(&str, bool); 9] = [
        ("bounds", fresh.bounds != kept.bounds),
        ("extent", fresh.extent != kept.extent),
        ("ops", fresh.ops != kept.ops),
        ("inner", fresh.inner != kept.inner),
        ("after", fresh.after != kept.after),
        ("layer", fresh.layer != kept.layer),
        ("fills", fresh.fills != kept.fills),
        ("children", fresh.children.len() != kept.children.len() || fresh.children.iter().zip(&kept.children).any(|(a, b)| a.node != b.node)),
        ("look", (fresh.clips, fresh.opaque, fresh.radius, fresh.surface) != (kept.clips, kept.opaque, kept.radius, kept.surface)),
    ];
    let differ: Vec<&str> = parts.iter().filter(|(_, d)| *d).map(|(name, _)| *name).collect();
    Some(format!("node {} ({}): fresh {:?} kept {:?}", fresh.node, differ.join(", "), short(fresh), short(kept)))
}

fn short(item: &Item) -> String {
    let text = format!("{:?} {:?} {:?} {:?}", item.bounds, item.layer, item.ops, item.after);
    text.chars().take(600).collect()
}

pub mod diff;
pub mod events;
pub mod highlight;
pub mod markdown;
mod mend;
pub mod ops;

use pixel_core::{Engine, EngineEvent, TerminalColors, fontdue};
use serde_json::json;

pub use events::event_json;
pub use ops::{IdMap, OpOutcome, apply_ops};

static UI_FONT_BYTES: &[u8] = include_bytes!("../../../assets/fonts/InterVariable.ttf");
pub static MONO_FONT_BYTES: &[u8] =
    include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf");

const SYSTEM_UI_FONTS: &[&str] = &[
    "/System/Library/Fonts/SFNSRounded.ttf",
    "/System/Library/Fonts/SFNS.ttf",
];

fn load_font(candidates: &[&str], fallback: &'static [u8]) -> fontdue::Font {
    let parse = |bytes: &[u8]| fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default());
    if cfg!(target_os = "macos") {
        for path in candidates {
            if let Ok(bytes) = std::fs::read(path)
                && let Ok(font) = parse(&bytes)
            {
                return font;
            }
        }
    }
    parse(fallback).expect("bundled font parses")
}

pub fn default_fonts() -> pixel_core::fonts::FontRegistry {
    pixel_core::fonts::FontRegistry::new(load_font(&[], MONO_FONT_BYTES), load_font(SYSTEM_UI_FONTS, UI_FONT_BYTES))
}

pub fn engine_info(engine: &Engine) -> serde_json::Value {
    let (width, height) = engine.comp.window;
    let (cell_w, cell_h) = engine.cell;
    json!({
        "width": width,
        "height": height,
        "cellWidth": cell_w,
        "cellHeight": cell_h,
        "basePx": engine.base_px,
        "kittyKeyboard": engine.io.kitty_keyboard(),
        "hosted": engine.io.is_hosted(),
        "colors": colors_json(&engine.colors),
    })
}

pub fn colors_json(colors: &TerminalColors) -> serde_json::Value {
    json!({
        "foreground": colors.foreground,
        "background": colors.background,
        "palette": colors.palette,
    })
}

pub struct Bridge {
    ids: Vec<IdMap>,
}

impl Bridge {
    pub fn new(engine: &Engine) -> Self {
        let ids = (0..engine.comp.views.len()).map(|view| IdMap::new(engine.comp.views[view].tree.root())).collect();
        Self { ids }
    }

    pub fn apply(&mut self, engine: &mut Engine, ops: &str) -> OpOutcome {
        apply_ops(engine, &mut self.ids, ops)
    }

    pub fn event(&self, event: &EngineEvent, engine: &Engine) -> Option<String> {
        event_json(event, engine, &self.ids)
    }
}

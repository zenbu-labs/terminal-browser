pub mod diff;
pub mod events;
pub mod highlight;
pub mod markdown;
mod mend;
pub mod ops;

use pixel_core::{Engine, EngineEvent, HostColors, fontdue};
use serde_json::json;

pub use events::event_json;
pub use ops::{HostOps, IdMap, NoHostOps, OpOutcome, answer_layout_query, apply_ops};

pub const PROTOCOL_VERSION: u32 = 1;

static UI_FONT_BYTES: &[u8] = include_bytes!("../../../assets/fonts/InterVariable.ttf");
static MONO_FONT_BYTES: &[u8] = include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf");

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
    let mut info = json!({
        "width": width,
        "height": height,
        "cellWidth": cell_w,
        "cellHeight": cell_h,
        "basePx": engine.base_px,
        "device": device_json(&engine.device),
        "colors": colors_json(&engine.colors),
        "protocol": PROTOCOL_VERSION,
        "backendApi": pixel_core::backend::API_VERSION,
    });
    info.as_object_mut().expect("info is an object").extend(engine.backend.describe());
    info
}

pub fn device_json(device: &pixel_core::Device) -> serde_json::Value {
    json!({
        "name": device.name,
        "lattice": [device.lattice.0, device.lattice.1],
        "colors": match device.colors {
            pixel_core::ColorDepth::TrueColor => "truecolor",
            pixel_core::ColorDepth::Indexed256 => "256",
            pixel_core::ColorDepth::Indexed16 => "16",
            pixel_core::ColorDepth::Monochrome => "mono",
        },
        "pointer": match device.pointer {
            pixel_core::Pointer::Precise => "precise",
            pixel_core::Pointer::Coarse => "coarse",
        },
    })
}

pub fn colors_json(colors: &HostColors) -> serde_json::Value {
    json!({
        "foreground": colors.foreground,
        "background": colors.background,
        "palette": colors.palette,
    })
}

pub struct Bridge {
    pub ids: Vec<IdMap>,
}

impl Bridge {
    pub fn new(engine: &Engine) -> Self {
        let ids = (0..engine.comp.views.len()).map(|view| IdMap::new(engine.comp.views[view].tree.root())).collect();
        Self { ids }
    }

    pub fn apply(&mut self, engine: &mut Engine, ops: &str, host: &mut dyn HostOps) -> OpOutcome {
        apply_ops(engine, &mut self.ids, ops, host)
    }

    pub fn event(&self, event: &EngineEvent, engine: &Engine) -> Option<String> {
        event_json(event, engine, &self.ids)
    }
}

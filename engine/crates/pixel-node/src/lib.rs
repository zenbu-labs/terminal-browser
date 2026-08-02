mod diff;
mod events;
mod highlight;
#[cfg(target_os = "macos")]
mod iosurface;
mod markdown;
mod mend;
mod ops;
#[cfg(target_os = "linux")]
mod pixmap;
mod surface;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{JsFunction, Result};
use napi_derive::napi;
use pixel_core::{Engine, EngineConfig, TerminalColors, Waker, fontdue};
use serde_json::json;

use crate::events::event_json;
use crate::ops::{IdMap, apply_ops};
use crate::surface::{SurfaceCommand, SurfaceMailbox, SurfacePixels};

fn draw_frame(
    engine: &mut Engine,
    frame: &surface::SurfaceFrame,
) -> std::result::Result<u32, String> {
    match &frame.pixels {
        #[cfg(target_os = "macos")]
        SurfacePixels::IoSurface(surface) => {
            let locked = surface.lock()?;
            engine
                .draw_surface(
                    frame.id,
                    locked.width,
                    locked.height,
                    locked.pixels(),
                    locked.stride,
                    frame.damage,
                )
                .map(|_| locked.height)
                .map_err(|error| error.to_string())
        }
        #[cfg(target_os = "linux")]
        SurfacePixels::Pixmap(surface) => {
            let locked = surface.lock()?;
            engine
                .draw_surface(
                    frame.id,
                    locked.width,
                    locked.height,
                    locked.pixels(),
                    locked.stride,
                    frame.damage,
                )
                .map(|_| locked.height)
                .map_err(|error| error.to_string())
        }
        SurfacePixels::Owned {
            bgra,
            width,
            height,
        } => engine
            .draw_surface(
                frame.id,
                *width,
                *height,
                bgra,
                *width as usize * 4,
                frame.damage,
            )
            .map(|_| *height)
            .map_err(|error| error.to_string()),
    }
}

/// One plane of a dmabuf-backed shared texture, as Electron reports it on
/// Linux. Offsets and sizes are in bytes.
#[cfg(target_os = "linux")]
#[napi(object)]
pub struct SurfacePixmap {
    pub fd: i32,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub offset: u32,
    pub size: u32,
}

#[napi(object)]
pub struct DamageRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl DamageRect {
    fn into_rect(self) -> pixel_core::surfaces::Rect {
        pixel_core::surfaces::Rect {
            x: self.x,
            y: self.y,
            w: self.width,
            h: self.height,
        }
    }
}

static UI_FONT_BYTES: &[u8] = include_bytes!("../../../examples/typing/assets/InterVariable.ttf");
static MONO_FONT_BYTES: &[u8] =
    include_bytes!("../../../examples/typing/assets/JetBrainsMono-Regular.ttf");

const SYSTEM_UI_FONTS: &[&str] = &[
    "/System/Library/Fonts/SFNSRounded.ttf",
    "/System/Library/Fonts/SFNS.ttf",
];
const SYSTEM_MONO_FONTS: &[&str] = &["/System/Library/Fonts/SFNSMono.ttf"];

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

fn err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

struct SendEngine(Engine);

#[allow(unsafe_code)]
unsafe impl Send for SendEngine {}

pub(crate) fn colors_json(colors: &TerminalColors) -> serde_json::Value {
    json!({
        "foreground": colors.foreground,
        "background": colors.background,
        "palette": colors.palette,
    })
}

#[napi]
pub struct PixelEngine {
    engine: Option<Engine>,
    info: String,
    tx: Sender<String>,
    rx: Option<Receiver<String>>,
    waker: Waker,
    surfaces: Arc<SurfaceMailbox>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[napi]
impl PixelEngine {
    #[napi(constructor)]
    pub fn new(tty: Option<String>, tmux: Option<bool>) -> Result<Self> {
        let fonts = vec![
            load_font(SYSTEM_UI_FONTS, UI_FONT_BYTES),
            load_font(SYSTEM_MONO_FONTS, MONO_FONT_BYTES),
        ];
        let mut engine = Engine::new(EngineConfig {
            fonts,
            cell_metrics_font: 1,
            watch_resize: false,
            tty,
            tmux: tmux.unwrap_or(false),
        })
        .map_err(err)?;
        let waker = engine.term.waker().map_err(err)?;
        engine.cpu_throttle.register_current_thread();
        let (width, height) = engine.comp.window;
        let (cell_w, cell_h) = engine.cell;
        let info = json!({
            "width": width,
            "height": height,
            "cellWidth": cell_w,
            "cellHeight": cell_h,
            "basePx": engine.base_px,
            "colors": colors_json(&engine.colors),
        })
        .to_string();
        let (tx, rx) = channel();
        Ok(Self {
            engine: Some(engine),
            info,
            tx,
            rx: Some(rx),
            waker,
            // who even uses you tho
            surfaces: Arc::new(SurfaceMailbox::default()),
            stop: Arc::new(AtomicBool::new(false)),
            thread: None,
        })
    }

    #[napi]
    pub fn info(&self) -> String {
        self.info.clone()
    }

    /*
    this is the function node calls to send data to rust
     */
    #[napi]
    pub fn apply_ops(&self, ops: String) -> Result<()> {
        let _ = self.tx.send(ops);
        self.waker.wake();
        Ok(())
    }

    #[napi]
    pub fn update_surface(
        &self,
        id: u32,
        bgra: Buffer,
        width: u32,
        height: u32,
        damage: Option<DamageRect>,
    ) -> Result<()> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| Error::from_reason("surface dimensions overflow"))?;
        let source = bgra.as_ref();
        if expected == 0 || source.len() < expected {
            return Err(Error::from_reason(format!(
                "surface buffer has {} bytes, expected {expected}",
                source.len()
            )));
        }
        let mut owned = self.surfaces.take_spare(id);
        owned.clear();
        owned.extend_from_slice(&source[..expected]);
        self.surfaces.submit(
            id,
            SurfacePixels::Owned {
                bgra: owned,
                width,
                height,
            },
            damage.map(DamageRect::into_rect),
        );
        self.waker.wake();
        Ok(())
    }

    #[napi]
    pub fn remove_surface(&self, id: u32) {
        self.surfaces.remove(id);
        self.waker.wake();
    }

    #[napi]
    pub fn surface_stats(&self) -> String {
        let (submitted, coalesced, presented, rows) = self.surfaces.stats();
        json!({
            "submitted": submitted,
            "coalesced": coalesced,
            "presented": presented,
            "rows": rows,
        })
        .to_string()
    }

    /**
     * wait i dont get how rust works??
     */
    #[napi]
    pub fn set_key_event_types(&mut self, enabled: bool) -> Result<()> {
        let engine = self
            .engine
            .as_mut()
            .ok_or_else(|| Error::from_reason("key reporting must be configured before start"))?;
        engine.term.set_key_event_types(enabled).map_err(err)
    }

    #[napi]
    pub fn start(&mut self, callback: JsFunction) -> Result<()> {
        let dispatch_to_node: ThreadsafeFunction<String> = callback
            .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<String>| {
                Ok(vec![ctx.value])
            })?;
        let engine = self
            .engine
            .take()
            .ok_or_else(|| Error::from_reason("engine already started"))?;
        let rx = self
            .rx
            .take()
            .ok_or_else(|| Error::from_reason("engine already started"))?;
        let stop = self.stop.clone();
        let surfaces = self.surfaces.clone();
        let cell = SendEngine(engine);
        self.thread = Some(std::thread::spawn(move || {
            let cell = cell;
            let mut engine = cell.0;
            engine.set_default_menu(true);
            engine.emit_logs = true;
            let mut ids: Vec<IdMap> = (0..engine.comp.views.len())
                .map(|view| IdMap::new(engine.comp.views[view].tree.root()))
                .collect();
            let exit_error = loop {
                let events = match engine.pump(None) {
                    Ok(events) => events,
                    Err(e) => break Some(e.to_string()),
                };
                if stop.load(Ordering::Relaxed) {
                    break None;
                }
                while let Ok(cmd) = rx.try_recv() {
                    let outcome = apply_ops(&mut engine, &mut ids, &cmd);
                    if let Some(message) = outcome.error {
                        pixel_core::logging::error("bridge", message.clone());
                        let error = json!({ "type": "error", "message": message });
                        dispatch_to_node.call(
                            Ok(error.to_string()),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                    for reply in outcome.replies {
                        dispatch_to_node.call(Ok(reply), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
                let mut surface_error = None;
                for command in surfaces.take() {
                    match command {
                        SurfaceCommand::Frame(frame) => {
                            let result = draw_frame(&mut engine, &frame);
                            match result {
                                Ok(rows) => surfaces.recycle(frame, rows),
                                Err(error) => {
                                    surface_error = Some(error);
                                    break;
                                }
                            }
                        }
                        SurfaceCommand::Remove(id) => {
                            if let Err(error) = engine.delete_surface(id) {
                                surface_error = Some(error.to_string());
                                break;
                            }
                        }
                    }
                }
                if surface_error.is_some() {
                    break surface_error;
                }
                for event in &events {
                    if let Some(json) = event_json(event, &engine, &ids) {
                        dispatch_to_node.call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
            };
            drop(engine);
            if !stop.load(Ordering::Relaxed) {
                let exit = json!({ "type": "exit", "error": exit_error });
                dispatch_to_node.call(
                    Ok(exit.to_string()),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
        }));
        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.waker.wake();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.engine = None;
    }
}

// Zero-copy frame submission is per-platform: each platform exports its own
// method shaped after the handle Electron produces there, and the JS side
// feature-detects which one exists.
#[cfg(target_os = "macos")]
#[napi]
impl PixelEngine {
    #[napi]
    pub fn update_surface_texture(
        &self,
        id: u32,
        handle: Buffer,
        damage: Option<DamageRect>,
    ) -> Result<()> {
        let surface =
            iosurface::RetainedSurface::from_handle(handle.as_ref()).map_err(Error::from_reason)?;
        self.surfaces.submit(
            id,
            SurfacePixels::IoSurface(surface),
            damage.map(DamageRect::into_rect),
        );
        self.waker.wake();
        Ok(())
    }
}

#[cfg(target_os = "linux")]
#[napi]
impl PixelEngine {
    #[napi]
    pub fn update_surface_pixmap(
        &self,
        id: u32,
        pixmap: SurfacePixmap,
        damage: Option<DamageRect>,
    ) -> Result<()> {
        let surface = pixmap::PixmapSurface::from_plane(
            pixmap.fd,
            pixmap.width,
            pixmap.height,
            pixmap.stride,
            pixmap.offset,
            pixmap.size,
        )
        .map_err(Error::from_reason)?;
        self.surfaces.submit(
            id,
            SurfacePixels::Pixmap(surface),
            damage.map(DamageRect::into_rect),
        );
        self.waker.wake();
        Ok(())
    }
}

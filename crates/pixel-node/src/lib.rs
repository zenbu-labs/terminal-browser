mod events;
mod ops;

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

/**
 * obviously retarded
 */
static UI_FONT_BYTES: &[u8] = include_bytes!("../../../examples/typing/assets/InterVariable.ttf");
static MONO_FONT_BYTES: &[u8] =
    include_bytes!("../../../examples/typing/assets/JetBrainsMono-Regular.ttf");

const SYSTEM_UI_FONTS: &[&str] = &["/System/Library/Fonts/SFNS.ttf"];
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

fn colors_json(colors: &TerminalColors) -> serde_json::Value {
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
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[napi]
impl PixelEngine {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        let fonts = vec![
            load_font(SYSTEM_UI_FONTS, UI_FONT_BYTES),
            load_font(SYSTEM_MONO_FONTS, MONO_FONT_BYTES),
        ];
        let mut engine = Engine::new(EngineConfig {
            fonts,
            cell_metrics_font: 1,
            watch_resize: false,
        })
        .map_err(err)?;
        let waker = engine.waker().map_err(err)?;
        let (width, height) = engine.window_px();
        let (cell_w, cell_h) = engine.cell_px();
        let info = json!({
            "width": width,
            "height": height,
            "cellWidth": cell_w,
            "cellHeight": cell_h,
            "basePx": engine.base_px(),
            "colors": colors_json(engine.colors()),
        })
        .to_string();
        let (tx, rx) = channel();
        Ok(Self {
            engine: Some(engine),
            info,
            tx,
            rx: Some(rx),
            waker,
            stop: Arc::new(AtomicBool::new(false)),
            thread: None,
        })
    }

    #[napi]
    pub fn info(&self) -> String {
        self.info.clone()
    }

    #[napi]
    pub fn apply_ops(&self, ops: String) -> Result<()> {
        let _ = self.tx.send(ops);
        self.waker.wake();
        Ok(())
    }

    #[napi]
    pub fn start(&mut self, callback: JsFunction) -> Result<()> {
        let tsfn: ThreadsafeFunction<String> = callback
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
        let cell = SendEngine(engine);
        self.thread = Some(std::thread::spawn(move || {
            let cell = cell;
            let mut engine = cell.0;
            engine.set_default_menu(true);
            engine.set_emit_logs(true);
            let mut ids: Vec<IdMap> = (0..engine.view_count())
                .map(|view| IdMap::new(engine.view_tree(view).expect("view exists").root()))
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
                        tsfn.call(
                            Ok(error.to_string()),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                    for reply in outcome.replies {
                        tsfn.call(Ok(reply), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
                for event in &events {
                    if let Some(json) = event_json(event, &engine, &ids) {
                        tsfn.call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
            };
            drop(engine);
            if !stop.load(Ordering::Relaxed) {
                let exit = json!({ "type": "exit", "error": exit_error });
                tsfn.call(
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

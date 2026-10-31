#![allow(unsafe_code)]

mod calls;
mod guard;
mod host;
mod input;

use std::ffi::{CStr, CString, c_char};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;

use pixel_bridge::Bridge;
use pixel_core::device::{DeviceConfig, DeviceInbox, DeviceMetrics};
use pixel_core::{Engine, EngineConfig, TerminalColors};
use serde::Deserialize;

use guard::{catching, guarded};
pub use host::{PixelCallbacks, PixelCover, PixelFrame, PixelPlacement};
use host::{Host, SharedCallbacks};

const ABI_VERSION: u32 = 1;
const PANICS_BEFORE_GIVING_UP: u32 = 20;

pub struct PixelEngine {
    engine: Option<Engine>,
    info: String,
    inbox: DeviceInbox,
    callbacks: SharedCallbacks,
    ops: Sender<String>,
    ops_rx: Option<Receiver<String>>,
    waker: pixel_core::Waker,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

struct SendEngine(Engine);

// SAFETY: the engine moves to its own thread once and is only used there afterwards.
unsafe impl Send for SendEngine {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    width: u32,
    height: u32,
    cell_width: u32,
    cell_height: u32,
    #[serde(default)]
    colors: Colors,
    #[serde(default = "enabled")]
    native_views: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Deserialize, Default)]
struct Colors {
    foreground: Option<[u8; 4]>,
    background: Option<[u8; 4]>,
}

fn c_str(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    // SAFETY: callers pass NUL terminated strings that live for the duration of the call.
    unsafe { CStr::from_ptr(ptr) }.to_str().ok().map(str::to_owned)
}

fn into_c(string: String) -> *mut c_char {
    CString::new(string).map_or(std::ptr::null_mut(), CString::into_raw)
}

fn with<R>(engine: *mut PixelEngine, f: impl FnOnce(&mut PixelEngine) -> R) -> Option<R> {
    // SAFETY: the pointer came from pixel_engine_new and is not freed until pixel_engine_free.
    unsafe { engine.as_mut() }.map(f)
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_engine_new(config_json: *const c_char) -> *mut PixelEngine {
    guarded("pixel_engine_new", std::ptr::null_mut(), || {
        let config = match c_str(config_json).map(|json| serde_json::from_str::<Config>(&json)) {
            Some(Ok(config)) => config,
            Some(Err(error)) => {
                pixel_core::logging::error("ios", format!("bad engine config: {error}"));
                return std::ptr::null_mut();
            }
            None => return std::ptr::null_mut(),
        };
        let callbacks = SharedCallbacks::default();
        let inbox = DeviceInbox::default();
        let device = DeviceConfig {
            host: Box::new(Host::new(callbacks.clone())),
            inbox: inbox.clone(),
            metrics: DeviceMetrics { width_px: config.width, height_px: config.height, cell: (config.cell_width, config.cell_height) },
            colors: TerminalColors { foreground: config.colors.foreground, background: config.colors.background, ..TerminalColors::default() },
            native_views: config.native_views,
        };
        let engine_config = EngineConfig {
            fonts: pixel_bridge::default_fonts(),
            cell_metrics_font: 0,
            watch_resize: false,
            tty: None,
            host: None,
            wrapper: pixel_core::wrapper::Wrapper::None,
            session_env: pixel_core::SessionEnv::of_process(),
        };
        let mut engine = match Engine::with_device(engine_config, device) {
            Ok(engine) => engine,
            Err(error) => {
                pixel_core::logging::error("ios", format!("engine failed to start: {error}"));
                return std::ptr::null_mut();
            }
        };
        let Ok(waker) = engine.io.waker() else {
            return std::ptr::null_mut();
        };
        let info = pixel_bridge::engine_info(&engine).to_string();
        let (ops, ops_rx) = channel();
        Box::into_raw(Box::new(PixelEngine {
            engine: Some(engine),
            info,
            inbox,
            callbacks,
            ops,
            ops_rx: Some(ops_rx),
            waker,
            stop: Arc::new(AtomicBool::new(false)),
            thread: None,
        }))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_engine_info(engine: *mut PixelEngine) -> *mut c_char {
    guarded("pixel_engine_info", std::ptr::null_mut(), || {
        with(engine, |e| into_c(e.info.clone())).unwrap_or(std::ptr::null_mut())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_engine_start(engine: *mut PixelEngine, callbacks: PixelCallbacks) {
    guarded("pixel_engine_start", (), || {
        with(engine, |this| {
            let (Some(engine), Some(ops)) = (this.engine.take(), this.ops_rx.take()) else {
                return;
            };
            this.callbacks.set(Some(callbacks));
            let stop = this.stop.clone();
            let engine = SendEngine(engine);
            this.thread = Some(std::thread::spawn(move || run(engine, ops, callbacks, &stop)));
        });
    })
}

fn run(engine: SendEngine, ops: Receiver<String>, callbacks: PixelCallbacks, stop: &AtomicBool) {
    let SendEngine(mut engine) = engine;
    engine.set_default_menu(false);
    let mut bridge = Bridge::new(&engine);
    let mut panics = 0;
    let error = loop {
        let mut finished: Option<Option<String>> = None;
        let stepped = catching(|| {
            let events = match engine.pump(None) {
                Ok(events) => events,
                Err(error) => return finished = Some(Some(error.to_string())),
            };
            if stop.load(Ordering::Relaxed) {
                return finished = Some(None);
            }
            while let Ok(batch) = ops.try_recv() {
                let outcome = bridge.apply(&mut engine, &batch);
                if let Some(message) = outcome.error {
                    callbacks.event(&serde_json::json!({ "type": "error", "message": message }).to_string());
                }
                for reply in outcome.replies {
                    callbacks.event(&reply);
                }
            }
            for event in &events {
                if let Some(json) = bridge.event(event, &engine) {
                    callbacks.event(&json);
                }
            }
        });
        if !stepped {
            panics += 1;
            callbacks.event(&serde_json::json!({ "type": "error", "message": "the engine panicked" }).to_string());
            if panics > PANICS_BEFORE_GIVING_UP {
                break Some("the engine kept panicking".to_string());
            }
            continue;
        }
        if let Some(result) = finished {
            break result;
        }
    };
    drop(engine);
    if !stop.load(Ordering::Relaxed) {
        callbacks.event(&serde_json::json!({ "type": "exit", "error": error }).to_string());
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_engine_apply_ops(engine: *mut PixelEngine, ops_json: *const c_char) {
    guarded("pixel_engine_apply_ops", (), || {
        let Some(ops) = c_str(ops_json) else { return };
        with(engine, |e| {
            let _ = e.ops.send(ops);
            e.waker.wake();
        });
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_engine_input(engine: *mut PixelEngine, input_json: *const c_char) {
    guarded("pixel_engine_input", (), || {
        let Some(json) = c_str(input_json) else { return };
        match serde_json::from_str::<input::Input>(&json) {
            Ok(input) => {
                if let Some(event) = input.into_event() {
                    with(engine, |e| e.inbox.push(event));
                }
            }
            Err(error) => pixel_core::logging::warn("ios", format!("bad input {json}: {error}")),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_engine_resize(engine: *mut PixelEngine, width_px: u32, height_px: u32, cell_width: u32, cell_height: u32) {
    guarded("pixel_engine_resize", (), || {
        with(engine, |e| e.inbox.resize(DeviceMetrics { width_px, height_px, cell: (cell_width, cell_height) }));
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_engine_stop(engine: *mut PixelEngine) {
    guarded("pixel_engine_stop", (), || {
        with(engine, |e| {
            e.stop.store(true, Ordering::Relaxed);
            e.waker.wake();
            if let Some(thread) = e.thread.take() {
                let _ = thread.join();
            }
            e.callbacks.set(None);
        });
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_engine_free(engine: *mut PixelEngine) {
    guarded("pixel_engine_free", (), || {
        if engine.is_null() {
            return;
        }
        pixel_engine_stop(engine);
        // SAFETY: the pointer came from Box::into_raw in pixel_engine_new and is freed once.
        drop(unsafe { Box::from_raw(engine) });
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_call(name: *const c_char, args_json: *const c_char) -> *mut c_char {
    guarded("pixel_call", std::ptr::null_mut(), || {
        let name = c_str(name).unwrap_or_default();
        let args: Vec<serde_json::Value> = c_str(args_json).and_then(|a| serde_json::from_str(&a).ok()).unwrap_or_default();
        let result = match calls::call(&name, &args) {
            Ok(value) => serde_json::json!({ "ok": value }),
            Err(error) => serde_json::json!({ "error": error }),
        };
        into_c(result.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_string_free(string: *mut c_char) {
    guarded("pixel_string_free", (), || {
        if !string.is_null() {
            // SAFETY: the string came from CString::into_raw in this library.
            drop(unsafe { CString::from_raw(string) });
        }
    })
}

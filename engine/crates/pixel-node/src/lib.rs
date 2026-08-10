mod capture;
mod diff;
mod events;
mod highlight;
#[cfg(target_os = "macos")]
mod iosurface;
mod markdown;
mod mend;
mod ops;
mod record;
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

pub struct EncodeRecordingTask {
    job_json: String,
    progress: Option<ThreadsafeFunction<f64>>,
}

impl Task for EncodeRecordingTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        let progress = self.progress.clone();
        record::run(&self.job_json, &move |percent: f64| {
            if let Some(callback) = &progress {
                callback.call(Ok(percent), ThreadsafeFunctionCallMode::NonBlocking);
            }
        })
        .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

pub struct FilmstripTask {
    dir: String,
    frames: Vec<u32>,
    tile_width: u32,
    width: u32,
    height: u32,
}

impl Task for FilmstripTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Vec<u8>> {
        let mut segment = capture::Segment::open(std::path::Path::new(&self.dir))
            .map_err(|e| Error::from_reason(format!("{}: {e}", self.dir)))?;
        let mut strip = pixel_core::Canvas::new(self.width, self.height);
        strip.fill([24, 24, 26, 255]);
        for (slot, &index) in self.frames.iter().enumerate() {
            let (pixels, w, h) = segment.frame(index as usize).map_err(err)?;
            strip.blit_scaled_rgba(
                (slot as u32 * self.tile_width) as f32,
                0.0,
                self.tile_width as f32,
                self.height as f32,
                pixels,
                w,
                h,
            );
        }
        Ok(strip.pixels)
    }

    fn resolve(&mut self, _env: Env, output: Vec<u8>) -> Result<Buffer> {
        Ok(Buffer::from(output))
    }
}

#[napi(ts_return_type = "Promise<Buffer>")]
pub fn capture_filmstrip(
    dir: String,
    frames: Vec<u32>,
    tile_width: u32,
    width: u32,
    height: u32,
) -> AsyncTask<FilmstripTask> {
    AsyncTask::new(FilmstripTask {
        dir,
        frames,
        tile_width,
        width,
        height,
    })
}

#[napi(ts_return_type = "Promise<void>")]
pub fn encode_recording(
    job_json: String,
    on_progress: Option<JsFunction>,
) -> Result<AsyncTask<EncodeRecordingTask>> {
    let progress = on_progress
        .map(|callback| {
            callback.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<f64>| {
                ctx.env.create_double(ctx.value).map(|value| vec![value])
            })
        })
        .transpose()?;
    Ok(AsyncTask::new(EncodeRecordingTask { job_json, progress }))
}

/// TERMINAL_BROWSER_AUTOPROFILE_MS=<n>: records engine spans from boot for n
/// milliseconds and writes profiles/profile-<stamp>.json, so a headless
/// harness gets a full profile without the devtools UI.
struct Autoprofile {
    stop_at: Option<std::time::Instant>,
}

impl Autoprofile {
    fn from_env(engine: &mut Engine) -> Self {
        let stop_at = std::env::var("TERMINAL_BROWSER_AUTOPROFILE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|ms| std::time::Instant::now() + std::time::Duration::from_millis(ms));
        if stop_at.is_some() {
            engine.profile_start();
        }
        Self { stop_at }
    }

    fn tick(&mut self, engine: &mut Engine) {
        if self
            .stop_at
            .is_some_and(|at| std::time::Instant::now() >= at)
        {
            self.stop_at = None;
            if let Ok(Some(path)) = engine.profiler.toggle() {
                pixel_core::logging::info(
                    "profiler",
                    format!("autoprofile written to {}", path.display()),
                );
            }
        }
    }
}

fn draw_frame(
    engine: &mut Engine,
    frame: &surface::SurfaceFrame,
) -> std::result::Result<u32, String> {
    match &frame.pixels {
        // macOS: the frame is an IOSurface whose locked pages read at normal
        // memory speed.
        #[cfg(target_os = "macos")]
        SurfacePixels::IoSurface(surface) => {
            let locked = surface.lock()?;
            draw_pixels(
                engine,
                frame,
                locked.width,
                locked.height,
                locked.pixels(),
                locked.stride,
            )
        }
        // Linux: the frame is a GPU dmabuf whose CPU mapping is uncached.
        #[cfg(target_os = "linux")]
        SurfacePixels::Pixmap(surface) => {
            let locked = surface.lock()?;
            let len = locked.stride * locked.height as usize;
            engine
                .draw_surface(
                    frame.id,
                    locked.width,
                    locked.height,
                    pixel_core::surfaces::Source::Uncached {
                        bgra: &locked.pixels()[..len],
                        stride: locked.stride,
                    },
                    frame.damage,
                )
                .map(|_| locked.height)
                .map_err(|error| error.to_string())
        }
        // Both platforms: bitmap mode, pixels already copied into our memory.
        SurfacePixels::Owned {
            bgra,
            width,
            height,
        } => draw_pixels(engine, frame, *width, *height, bgra, *width as usize * 4),
    }
}

fn draw_pixels(
    engine: &mut Engine,
    frame: &surface::SurfaceFrame,
    width: u32,
    height: u32,
    pixels: &[u8],
    stride: usize,
) -> std::result::Result<u32, String> {
    engine
        .draw_surface(
            frame.id,
            width,
            height,
            pixel_core::surfaces::Source::Cached { bgra: pixels, stride },
            frame.damage,
        )
        .map(|_| height)
        .map_err(|error| error.to_string())
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

static UI_FONT_BYTES: &[u8] = include_bytes!("../../../assets/fonts/InterVariable.ttf");
static MONO_FONT_BYTES: &[u8] =
    include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf");

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
pub fn display_scale() -> Option<f64> {
    pixel_core::display_scale().map(f64::from)
}

#[napi]
pub struct PixelEngine {
    engine: Option<Engine>,
    info: String,
    tx: Sender<String>,
    rx: Option<Receiver<String>>,
    waker: Waker,
    surfaces: Arc<SurfaceMailbox>,
    captures: capture::Registry,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[napi]
impl PixelEngine {
    #[napi(constructor)]
    pub fn new(tty: Option<String>, wrapper: Option<String>) -> Result<Self> {
        let fonts = vec![
            load_font(SYSTEM_UI_FONTS, UI_FONT_BYTES),
            load_font(SYSTEM_MONO_FONTS, MONO_FONT_BYTES),
        ];
        let mut engine = Engine::new(EngineConfig {
            fonts,
            cell_metrics_font: 1,
            watch_resize: false,
            tty,
            wrapper: pixel_core::wrapper::Wrapper::named(wrapper.as_deref()),
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
            "kittyKeyboard": engine.term.kitty_keyboard(),
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
            captures: capture::Registry::default(),
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
        let damage = damage.map(DamageRect::into_rect);
        self.captures
            .capture(id, &source[..expected], width as usize * 4, width, height, damage);
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
            damage,
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

    #[napi]
    pub fn start_surface_capture(&self, surface_id: u32, dir: String) -> Result<u32> {
        self.captures
            .start(surface_id, std::path::Path::new(&dir))
            .map_err(err)
    }

    #[napi]
    pub fn stop_surface_capture(&self, capture_id: u32) -> Result<String> {
        let stats  = self.captures.stop(capture_id).map_err(err)?;
        Ok(json!({
            "frames": stats.frames,
            "drops": stats.drops,
            "durationMs": stats.duration_us as f64 / 1000.0,
        })
        .to_string())
    }

    #[napi]
    pub fn capture_index(&self, capture_id: u32) -> Result<String> {
        self.captures
            .with_segment(capture_id, |segment| {
                let frames: Vec<serde_json::Value> = segment
                    .metas()
                    .iter()
                    .map(|meta| {
                        json!({
                            "tMs": meta.t_us as f64 / 1000.0,
                            "key": meta.key,
                            "width": meta.width,
                            "height": meta.height,
                            "dropsBefore": meta.drops_before,
                        })
                    })
                    .collect();
                Ok(json!({
                    "frames": frames,
                    "drops": segment.drops,
                    "durationMs": segment.duration_us as f64 / 1000.0,
                })
                .to_string())
            })
            .map_err(err)
    }

    #[napi]
    pub fn capture_frame(&self, capture_id: u32, index: u32) -> Result<Buffer> {
        self.captures
            .with_segment(capture_id, |segment| {
                let (pixels, _, _) = segment.frame(index as usize)?;
                Ok(Buffer::from(pixels))
            })
            .map_err(err)
    }

    #[napi]
    pub fn release_capture(&self, capture_id: u32) {
        self.captures.release(capture_id);
    }

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
            let mut autoprofile = Autoprofile::from_env(&mut engine);
            let exit_error = loop {
                let events = match engine.pump(None) {
                    Ok(events) => events,
                    Err(e) => break Some(e.to_string()),
                };
                autoprofile.tick(&mut engine);
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
                for event in &events {
                    if let Some(json) = event_json(event, &engine, &ids) {
                        dispatch_to_node.call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking);
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

// Zero-copy frame submission is per-platform: each platform exports the method
// shaped after the handle Electron produces there, and the JS side
// feature-detects which one exists. The cfg has to gate whole impl blocks —
// napi registers every method in a block, even ones cfg strips out.
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
        let damage = damage.map(DamageRect::into_rect);
        if self.captures.wants(id) {
            let locked = surface.lock().map_err(Error::from_reason)?;
            self.captures.capture(
                id,
                locked.pixels(),
                locked.stride,
                locked.width,
                locked.height,
                damage,
            );
        }
        self.surfaces
            .submit(id, SurfacePixels::IoSurface(surface), damage);
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
        released: Option<ThreadsafeFunction<u32>>,
    ) -> Result<()> {
        let release_hook = released.map(|tsfn| {
            Box::new(move || {
                tsfn.call(Ok(0), ThreadsafeFunctionCallMode::NonBlocking);
            }) as Box<dyn FnOnce() + Send>
        });
        let mut surface = match pixmap::PixmapSurface::from_plane(
            pixmap.fd,
            pixmap.width,
            pixmap.height,
            pixmap.stride,
            pixmap.offset,
            pixmap.size,
        ) {
            Ok(surface) => surface,
            Err(error) => {
                if let Some(hook) = release_hook {
                    hook();
                }
                return Err(Error::from_reason(error));
            }
        };
        if let Some(hook) = release_hook {
            surface.set_on_drop(hook);
        }
        let damage = damage.map(DamageRect::into_rect);
        if self.captures.wants(id) {
            let locked = surface.lock().map_err(Error::from_reason)?;
            self.captures.capture(
                id,
                locked.pixels(),
                locked.stride,
                locked.width,
                locked.height,
                damage,
            );
        }
        self.surfaces
            .submit(id, SurfacePixels::Pixmap(surface), damage);
        self.waker.wake();
        Ok(())
    }
}


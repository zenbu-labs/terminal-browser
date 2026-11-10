use std::cell::RefCell;
use std::collections::VecDeque;
use std::io;
use std::ptr::NonNull;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, msg_send};
use objc2_app_kit::{
    NSBitmapFormat, NSBitmapImageRep, NSCursor, NSDeviceRGBColorSpace, NSEvent, NSEventMask, NSEventModifierFlags,
    NSEventType, NSImage, NSView,
};
use objc2_foundation::NSSize;
use pixel_core::backend::{Frame, HostInfo, Metrics};
use pixel_raster::{Raster, RasterOptions};
use pixel_core::{Backend, Event, HostColors, Mods, Mouse, MouseButton, MouseKind, Waker};

pub enum Msg {
    Event(Event),
    Wake,
}

pub struct Shared {
    pub scale: f64,
    pub size: Mutex<(u32, u32)>,
}

impl Shared {
    pub fn metrics(&self, window: (u32, u32)) -> Metrics {
        let scale = self.scale as u32;
        Metrics { window, cell: (8 * scale, 17 * scale) }
    }
}

struct PendingFrame {
    width: u32,
    height: u32,
    premultiplied: bool,
    rgba: Vec<u8>,
}

pub struct AppKitBackend {
    shared: Arc<Shared>,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    queued: VecDeque<Event>,
    latest: Arc<Mutex<Option<PendingFrame>>>,
    raster: Raster,
}

impl AppKitBackend {
    pub fn new(shared: Arc<Shared>, tx: Sender<Msg>, rx: Receiver<Msg>) -> Self {
        Self { shared, tx, rx, queued: VecDeque::new(), latest: Arc::new(Mutex::new(None)), raster: Raster::new() }
    }
}

impl Backend for AppKitBackend {
    fn start(&mut self) -> io::Result<HostInfo> {
        let size = *self.shared.size.lock().unwrap();
        let colors = HostColors { foreground: Some([235, 235, 240, 255]), background: Some([24, 24, 28, 255]), ..HostColors::default() };
        Ok(HostInfo { metrics: self.shared.metrics(size), colors, device: pixel_core::Device::default() })
    }

    fn waker(&mut self) -> io::Result<Waker> {
        let tx = self.tx.clone();
        Ok(Waker::new(move || {
            let _ = tx.send(Msg::Wake);
        }))
    }

    fn poll(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        if let Some(event) = self.queued.pop_front() {
            return Ok(Some(event));
        }
        let msg = match timeout {
            Some(timeout) => match self.rx.recv_timeout(timeout) {
                Ok(msg) => msg,
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                Err(RecvTimeoutError::Disconnected) => return Ok(Some(Event::Closed)),
            },
            None => match self.rx.recv() {
                Ok(msg) => msg,
                Err(_) => return Ok(Some(Event::Closed)),
            },
        };
        Ok(match msg {
            Msg::Event(event) => Some(event),
            Msg::Wake => None,
        })
    }

    fn present(&mut self, frame: Frame<'_>) -> io::Result<usize> {
        let pixels = self.raster.render(&frame, RasterOptions::default());
        let canvas = pixels.canvas;
        let pending = PendingFrame { width: canvas.width, height: canvas.height, premultiplied: pixels.premultiplied, rgba: canvas.pixels.clone() };
        let bytes = pending.rgba.len();
        // Only the newest frame matters; the main thread is asked to draw only when none is waiting.
        if self.latest.lock().unwrap().replace(pending).is_none() {
            let latest = self.latest.clone();
            let scale = self.shared.scale;
            DispatchQueue::main().exec_async(move || {
                if let Some(frame) = latest.lock().unwrap().take() {
                    show(frame, scale);
                }
            });
        }
        Ok(bytes)
    }

    fn set_pointer_shape(&mut self, shape: &str) -> io::Result<()> {
        let shape = shape.to_string();
        DispatchQueue::main().exec_async(move || match shape.as_str() {
            "pointer" => NSCursor::pointingHandCursor().set(),
            "text" => NSCursor::IBeamCursor().set(),
            _ => NSCursor::arrowCursor().set(),
        });
        Ok(())
    }
}

thread_local! {
    static VIEW: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
}

pub fn install_view(view: Retained<NSView>) {
    VIEW.with(|slot| *slot.borrow_mut() = Some(view));
}

fn show(frame: PendingFrame, scale: f64) {
    let format = if frame.premultiplied { NSBitmapFormat::empty() } else { NSBitmapFormat::AlphaNonpremultiplied };
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            frame.width as isize,
            frame.height as isize,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            format,
            (frame.width * 4) as isize,
            32,
        )
    };
    let Some(rep) = rep else { return };
    unsafe { std::ptr::copy_nonoverlapping(frame.rgba.as_ptr(), rep.bitmapData(), frame.rgba.len()) };
    let size = NSSize::new(frame.width as f64 / scale, frame.height as f64 / scale);
    let image = NSImage::initWithSize(NSImage::alloc(), size);
    image.addRepresentation(&rep);
    VIEW.with(|slot| {
        if let Some(view) = slot.borrow().as_ref() {
            let layer: *mut AnyObject = unsafe { msg_send![&**view, layer] };
            let _: () = unsafe { msg_send![layer, setContents: &*image] };
        }
    });
}

pub fn pixel_size(view: &NSView, scale: f64) -> (u32, u32) {
    let bounds = view.bounds();
    ((bounds.size.width * scale).round() as u32, (bounds.size.height * scale).round() as u32)
}

pub fn forward_input(view: &Retained<NSView>, scale: f64, tx: Sender<Msg>) -> Option<Retained<AnyObject>> {
    let view = view.clone();
    let handler = block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let ns = unsafe { event.as_ref() };
        if let Some(event) = translate(ns, &view, scale) {
            let _ = tx.send(Msg::Event(event));
        }
        event.as_ptr()
    });
    let mask = NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp | NSEventMask::LeftMouseDragged | NSEventMask::MouseMoved | NSEventMask::ScrollWheel;
    unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler) }
}

fn translate(event: &NSEvent, view: &NSView, scale: f64) -> Option<Event> {
    let point = view.convertPoint_fromView(event.locationInWindow(), None);
    let height = view.bounds().size.height;
    if point.x < 0.0 || point.y < 0.0 || point.y > height {
        return None;
    }
    let (x, y) = (point.x * scale, (height - point.y) * scale);
    let flags = event.modifierFlags();
    let mods = Mods {
        shift: flags.contains(NSEventModifierFlags::Shift),
        alt: flags.contains(NSEventModifierFlags::Option),
        ctrl: flags.contains(NSEventModifierFlags::Control),
        sup: flags.contains(NSEventModifierFlags::Command),
    };
    let mouse = |kind, button| Some(Event::Mouse(Mouse { kind, button, mods, x: x as u32, y: y as u32 }));
    match event.r#type() {
        NSEventType::LeftMouseDown => mouse(MouseKind::Down, MouseButton::Left),
        NSEventType::LeftMouseUp => mouse(MouseKind::Up, MouseButton::Left),
        NSEventType::LeftMouseDragged => mouse(MouseKind::Move, MouseButton::Left),
        NSEventType::MouseMoved => mouse(MouseKind::Move, MouseButton::None),
        NSEventType::ScrollWheel => {
            let precise = if event.hasPreciseScrollingDeltas() { scale } else { scale * 16.0 };
            let step = (-event.scrollingDeltaX() * precise, -event.scrollingDeltaY() * precise);
            Some(Event::Wheel { at: Some((x as f32, y as f32)), steps: vec![(step.0 as f32, step.1 as f32)], mods })
        }
        _ => None,
    }
}

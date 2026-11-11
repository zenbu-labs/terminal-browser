use std::any::Any;
use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub use crate::scene::{Frame, Scene};
pub use crate::text_metrics::measure_text;
pub use crate::input::{Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind};
pub use crate::surfaces::{OpaqueArea, Rect, SurfaceCover, SurfaceLayout, SurfacePlacement};

pub const API_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HostColors {
    pub foreground: Option<[u8; 4]>,
    pub background: Option<[u8; 4]>,
    pub palette: [Option<[u8; 4]>; 16],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Metrics {
    pub window: (u32, u32),
    pub cell: (u32, u32),
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostInfo {
    pub metrics: Metrics,
    pub colors: HostColors,
    pub device: crate::device::Device,
}

#[derive(Clone)]
pub struct Waker(Arc<dyn Fn() + Send + Sync>);

impl Waker {
    pub fn new(wake: impl Fn() + Send + Sync + 'static) -> Self {
        Self(Arc::new(wake))
    }

    pub fn wake(&self) {
        (self.0)()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Key(KeyEvent),
    Mouse(Mouse),
    Wheel {
        at: Option<(f32, f32)>,
        steps: Vec<(f32, f32)>,
        mods: Mods,
    },
    Pinch {
        at: Option<(f32, f32)>,
        magnification: f32,
    },
    Paste(String),
    Focus(bool),
    Resize(Metrics),
    Colors(HostColors),
    Device(crate::device::Device),
    Visible(bool),
    Redraw,
    Closed,
    ClipboardData {
        items: Vec<(String, Vec<u8>)>,
        ok: bool,
    },
    Message(serde_json::Value),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub trait SystemClipboard: Send + Sync {
    fn files(&self) -> Vec<std::path::PathBuf>;
    fn image(&self) -> Option<ClipboardImage>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardRead<'a> {
    Text,
    Types,
    Item(&'a str),
}

pub trait Backend: Any + Send {
    fn start(&mut self) -> io::Result<HostInfo>;
    fn waker(&mut self) -> io::Result<Waker>;
    fn poll(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>>;
    fn present(&mut self, frame: Frame<'_>) -> io::Result<usize>;

    fn poll_metrics(&mut self) -> io::Result<Option<Metrics>> {
        Ok(None)
    }

    fn pending_present(&self) -> bool {
        false
    }

    fn animating(&self) -> bool {
        false
    }

    fn before_frame(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn idle(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn spare(&mut self, _fonts: &[crate::fonts::Font], _until: Instant) {}

    fn deadline(&self) -> Option<Instant> {
        None
    }

    fn schedule_present(&mut self, _at: Option<Instant>) {}

    fn take_presented_at(&mut self) -> Option<Instant> {
        None
    }

    fn byte_rate_limit(&self) -> Option<f32> {
        None
    }

    fn set_title(&mut self, _text: &str) -> io::Result<()> {
        Ok(())
    }

    fn set_pointer_shape(&mut self, _shape: &str) -> io::Result<()> {
        Ok(())
    }

    fn write_clipboard(&mut self, _text: &str) -> io::Result<()> {
        Ok(())
    }

    fn read_clipboard(&mut self, _read: ClipboardRead<'_>) -> io::Result<()> {
        Ok(())
    }

    fn clipboard_has_types(&self) -> bool {
        false
    }

    fn system_clipboard(&self) -> Option<Arc<dyn SystemClipboard>> {
        None
    }

    fn message(&mut self, _message: serde_json::Value) {}

    fn describe(&self) -> serde_json::Map<String, serde_json::Value> {
        serde_json::Map::new()
    }
}

impl dyn Backend {
    pub fn downcast_mut<B: Backend>(&mut self) -> Option<&mut B> {
        (self as &mut dyn Any).downcast_mut()
    }

    pub fn downcast_ref<B: Backend>(&self) -> Option<&B> {
        (self as &dyn Any).downcast_ref()
    }
}

pub fn sleep_until(deadline: Instant) {
    crate::throttle::sleep_until(deadline)
}


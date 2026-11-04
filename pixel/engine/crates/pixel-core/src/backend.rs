use std::any::Any;
use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub use crate::canvas::{Canvas, Frame, Overlay, Pixels, ScrollLayer, measure_text};
pub use crate::input::{Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind};
pub use crate::surfaces::{NativeCover, NativeLayout, NativePlacement, OpaqueArea, Rect};

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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HostInfo {
    pub metrics: Metrics,
    pub colors: HostColors,
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
    // fixme: placeholder copy
    /// Precise scrolling in pixels, positive y scrolls content up. Each step is applied in turn.
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
    Visible(bool),
    // fixme: placeholder copy
    /// The host lost what was presented; the next frame repaints everything.
    Redraw,
    Closed,
    ClipboardData {
        items: Vec<(String, Vec<u8>)>,
        ok: bool,
    },
    // fixme: placeholder copy
    /// Something only this backend knows about, passed to the app as is.
    Message(serde_json::Value),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Wants {
    // fixme: placeholder copy
    /// Paint the largest list scroller into its own layer (`Frame::layer`) so it can be moved instead of resent.
    pub scroll_layer: bool,
    // fixme: placeholder copy
    /// When one view fills the window, present its canvas directly (premultiplied) instead of a composed copy.
    pub view_canvas: bool,
    // fixme: placeholder copy
    /// Leave surfaces as transparent holes and report where they are (`Frame::native`) for the host to draw them.
    pub native_surfaces: bool,
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
    // fixme: placeholder copy
    /// Returns the bytes sent, for hosts where that's the cost of a frame.
    fn present(&mut self, frame: Frame<'_>) -> io::Result<usize>;

    // fixme: placeholder copy
    /// For hosts that learn their size by asking rather than being told: `Some` when it changed.
    fn poll_metrics(&mut self) -> io::Result<Option<Metrics>> {
        Ok(None)
    }

    fn wants(&self) -> Wants {
        Wants::default()
    }

    // fixme: placeholder copy
    /// The backend still owes a present, so `present` is called again even if nothing changed.
    fn pending_present(&self) -> bool {
        false
    }

    // fixme: placeholder copy
    /// The backend animates something of its own and wants frames at the animation rate.
    fn animating(&self) -> bool {
        false
    }

    fn before_frame(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn idle(&mut self, _last: Frame<'_>) -> io::Result<()> {
        Ok(())
    }

    // fixme: placeholder copy
    /// Wake the engine by then even if no input arrives.
    fn deadline(&self) -> Option<Instant> {
        None
    }

    fn schedule_present(&mut self, _at: Option<Instant>) {}

    // fixme: placeholder copy
    /// When the last presented frame was actually shown, if the host can tell.
    fn take_presented_at(&mut self) -> Option<Instant> {
        None
    }

    // fixme: placeholder copy
    /// Frames are throttled so the bytes sent stay under this many per second.
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

    // fixme: placeholder copy
    /// Text arrives as `Event::Paste`, types and items as `Event::ClipboardData`.
    fn read_clipboard(&mut self, _read: ClipboardRead<'_>) -> io::Result<()> {
        Ok(())
    }

    fn clipboard_has_types(&self) -> bool {
        false
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


use std::collections::VecDeque;
use std::time::{Duration, Instant};

use pixel_core::backend::Event;
use pixel_core::logging;
use pixel_core::{Mods, Mouse, MouseKind};

use super::NativeScroll;
use super::Waker;
use super::hover::{HoverOracle, Verdict};
use super::pairing::NativePairing;

const PINCH_HOVER_WINDOW: Duration = Duration::from_millis(2000);

pub type Pane = ((f32, f32), (f32, f32));

pub struct NativeInput {
    native: Option<NativeScroll>,
    use_native: bool,
    native_delivering: bool,
    pairing: NativePairing,
    hover_oracle: HoverOracle,
}

impl Default for NativeInput {
    fn default() -> Self {
        Self {
            native: None,
            use_native: false,
            native_delivering: false,
            pairing: NativePairing::new(),
            hover_oracle: HoverOracle::new(),
        }
    }
}

impl NativeInput {
    pub fn start(&mut self, waker: Option<Waker>) {
        self.native = NativeScroll::spawn(waker);
        self.use_native = self.native.is_some();
    }

    pub fn stop(&mut self) {
        self.native = None;
        self.use_native = false;
    }

    pub fn active(&self) -> bool {
        self.use_native
    }

    pub fn invalidate(&mut self) {
        self.hover_oracle.invalidate();
    }

    fn ingest_native(&mut self, (pane, pad): Pane, pixel_mouse: bool) {
        let Some(native) = &mut self.native else {
            return;
        };
        let events = native.drain();
        let scale = native.scale;
        if native.dead() {
            logging::warn(
                "engine",
                "native scroll helper exited; falling back to wheel ticks",
            );
            self.native = None;
            self.pairing.reset();
            self.hover_oracle.invalidate();
            return;
        }
        if !self.use_native {
            return;
        }
        let now = Instant::now();
        self.pairing
            .ingest(events, scale, now, &mut self.hover_oracle, pane, pad);
        let wants_cursor = pixel_mouse && self.hover_oracle.wants_cursor(now);
        if let Some(native) = &mut self.native {
            native.request_positions(wants_cursor);
        }
    }

    pub fn drain_native(
        &mut self,
        extent: Pane,
        pixel_mouse: bool,
        pointer: Option<(f32, f32)>,
        last_pointer_activity: Option<Instant>,
        queued: &mut VecDeque<Event>,
    ) {
        self.ingest_native(extent, pixel_mouse);
        let (zoom, scrolls) = self.pairing.take();
        let (pane, pad) = extent;
        let pinch_here = match self.hover_oracle.verdict(Instant::now(), pane, pad) {
            Verdict::Deliver => true,
            Verdict::Discard => false,
            Verdict::Unknown => last_pointer_activity
                .is_some_and(|at| at.elapsed() < PINCH_HOVER_WINDOW),
        };
        let magnification = zoom - 1.0;
        if magnification != 0.0 && pinch_here {
            queued.push_back(Event::Pinch { at: pointer, magnification });
        }
        if scrolls.is_empty() {
            return;
        }
        if !self.native_delivering {
            self.native_delivering = true;
            logging::info("engine", "native scroll delivering");
        }
        queued.push_back(Event::Wheel {
            at: pointer,
            steps: scrolls.into_iter().map(|(dx, dy)| (-dx, -dy)).collect(),
            mods: Mods::default(),
        });
    }

    pub fn swallows(&mut self, mouse: &Mouse, extent: Pane, pixel_mouse: bool) -> bool {
        if !(self.use_native && self.native.is_some()) {
            return false;
        }
        let point = (mouse.x as f32, mouse.y as f32);
        let now = Instant::now();
        let scrolling = matches!(
            mouse.kind,
            MouseKind::ScrollUp | MouseKind::ScrollDown | MouseKind::ScrollLeft | MouseKind::ScrollRight
        );
        self.ingest_native(extent, pixel_mouse);
        let located = pixel_mouse.then_some(point);
        if scrolling && mouse.mods == Mods::default() {
            if self.pairing.on_wheel_tick(located, now, &mut self.hover_oracle) {
                return true;
            }
        } else if let Some(located) = located {
            self.hover_oracle.note_local(located, now);
        }
        false
    }
}

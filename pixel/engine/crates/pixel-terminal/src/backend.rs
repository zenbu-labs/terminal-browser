use std::collections::VecDeque;
use std::io;
use std::time::{Duration, Instant};

use pixel_core::backend::{
    Backend, ClipboardRead, Event, Frame, HostInfo, Metrics, Wants, Waker,
};
use pixel_core::fonts::Font;
use pixel_core::logging;
use pixel_core::{Mods, MouseKind};
use serde_json::json;

use crate::native::NativeScroll;
use crate::native::hover::{HoverOracle, Verdict};
use crate::native::pairing::NativePairing;
use crate::terminal::{self, Handoff, Retarget, SessionEnv, Terminal, WindowSize};
use crate::wrapper::Wrapper;

const CELL_REPLY_WAIT: Duration = Duration::from_millis(150);
const COLOR_SETTLE_DELAY: Duration = Duration::from_millis(50);
const COLOR_REQUEST_INTERVAL: Duration = Duration::from_secs(1);
const RELAYED_RESIZE_POLL: Duration = Duration::from_millis(500);
const PINCH_HOVER_WINDOW: Duration = Duration::from_millis(2000);
const INLINE_BYTES_PER_SEC: f32 = 3_000_000.0;

#[derive(Debug, Clone)]
pub struct HostOptions {
    pub socket: String,
    pub pane: String,
    pub name: String,
    pub tty: Option<String>,
}

pub struct TerminalOptions {
    pub tty: Option<String>,
    pub host: Option<HostOptions>,
    pub wrapper: Wrapper,
    pub session_env: SessionEnv,
    pub watch_resize: bool,
}

pub struct TerminalBackend {
    term: Terminal,
    session_env: SessionEnv,
    window: (u32, u32),
    cell: (u32, u32),
    cell_estimate: Option<(u32, u32)>,
    awaiting_cell: Option<(WindowSize, Instant)>,
    cell_exact: bool,
    resized: Option<Metrics>,
    color_request_at: Option<Instant>,
    last_color_request: Option<Instant>,
    focused: bool,
    native: Option<NativeScroll>,
    use_native: bool,
    native_delivering: bool,
    pairing: NativePairing,
    hover_oracle: HoverOracle,
    pointer: Option<(f32, f32)>,
    last_pointer_activity: Option<Instant>,
    queued: VecDeque<Event>,
}

pub(crate) fn window_from(ws: &WindowSize, cell: (u32, u32), cell_is_exact: bool) -> (u32, u32) {
    let cols = if ws.cols > 0 { ws.cols } else { 80 };
    let rows = if ws.rows > 0 { ws.rows } else { 24 };
    let mut width = cols * cell.0;
    let mut height = rows * cell.1;
    if cell_is_exact {
        return (width, height);
    }
    if ws.width_px > 0 {
        width = width.min(ws.width_px / cell.0 * cell.0);
    }
    if ws.height_px > 0 {
        height = height.min(ws.height_px / cell.1 * cell.1);
    }
    (width, height)
}

impl TerminalBackend {
    pub fn new(options: TerminalOptions) -> io::Result<Self> {
        let mut term = match (&options.host, &options.tty) {
            (Some(host), _) => match &host.tty {
                Some(tty) => Terminal::join_embedded(&host.socket, &host.pane, &host.name, tty)?,
                None => Terminal::join_host(&host.socket, &host.pane, &host.name)?,
            },
            (None, Some(path)) => {
                Terminal::open(path, options.wrapper, options.session_env.clone())?
            }
            (None, None) => Terminal::new(options.wrapper, options.session_env.clone())?,
        };
        if options.watch_resize {
            term.watch_resize()?;
        }
        Ok(Self {
            term,
            session_env: options.session_env,
            window: (0, 0),
            cell: terminal::DEFAULT_CELL,
            cell_estimate: None,
            awaiting_cell: None,
            cell_exact: false,
            resized: None,
            color_request_at: None,
            last_color_request: None,
            focused: true,
            native: None,
            use_native: false,
            native_delivering: false,
            pairing: NativePairing::new(),
            hover_oracle: HoverOracle::new(),
            pointer: None,
            last_pointer_activity: None,
            queued: VecDeque::new(),
        })
    }

    pub fn kitty_keyboard(&self) -> bool {
        self.term.kitty_keyboard()
    }

    pub fn is_hosted(&self) -> bool {
        self.term.is_hosted()
    }

    pub fn set_key_event_types(&mut self, enabled: bool) -> io::Result<()> {
        self.term.set_key_event_types(enabled)
    }

    pub fn set_highlight_transmits(&mut self, on: bool) {
        self.term.set_highlight_transmits(on);
    }

    pub fn note(&mut self, text: String) {
        self.term.note(text);
    }

    pub fn set_frame_events(&mut self, font: Option<Font>) {
        match font {
            Some(font) => self.term.set_overlay_font(font),
            None => {
                if let Err(error) = self.term.overlay_off() {
                    logging::warn("engine", format!("could not clear the presenter overlay: {error}"));
                }
            }
        }
    }

    pub fn retarget(&mut self, target: Retarget) -> io::Result<()> {
        self.term.retarget(target, self.session_env.clone())?;
        self.spawn_native();
        let colors = self.term.query_colors()?;
        self.queued.push_back(Event::Colors(colors));
        self.cell_estimate = None;
        let ws = self.term.size()?;
        self.apply_window(&ws, "retarget")?;
        if let Some(metrics) = self.resized.take() {
            self.queued.push_back(Event::Resize(metrics));
        }
        Ok(())
    }

    fn spawn_native(&mut self) {
        self.native = if self.term.is_hosted() && !self.term.is_embedded() {
            None
        } else {
            NativeScroll::spawn(self.term.waker().ok())
        };
        self.use_native = self.native.is_some();
    }

    fn apply_window(&mut self, ws: &WindowSize, source: &str) -> io::Result<()> {
        let estimate = ws.cell_size();
        if estimate != self.cell_estimate {
            self.cell_estimate = estimate;
            if let Some(cell) = self.term.ask_cell_size()? {
                self.awaiting_cell = None;
                self.cell_exact = true;
                return self.resize_to(ws, cell, source);
            }
            self.awaiting_cell = Some((*ws, Instant::now() + CELL_REPLY_WAIT));
        }
        match &mut self.awaiting_cell {
            Some((pending, _)) => {
                *pending = *ws;
                Ok(())
            }
            None => self.resize_to(ws, self.cell, source),
        }
    }

    fn apply_overdue_window(&mut self) -> io::Result<()> {
        let Some((ws, at)) = self.awaiting_cell else {
            return Ok(());
        };
        if Instant::now() < at {
            return Ok(());
        }
        self.awaiting_cell = None;
        let cell = ws.cell_size().unwrap_or(self.cell);
        self.cell_exact = false;
        self.resize_to(&ws, cell, "unanswered cell query")
    }

    fn resize_to(&mut self, ws: &WindowSize, cell: (u32, u32), source: &str) -> io::Result<()> {
        self.term.set_cell_size(cell);
        let window = window_from(ws, cell, self.cell_exact);
        if window == self.window && cell == self.cell {
            return Ok(());
        }
        self.term.retry_frame_transport(false)?;
        logging::info(
            "engine",
            format!(
                "window size from {source}: {}x{} cells, {}x{} px, estimated cell {:?}",
                ws.cols,
                ws.rows,
                ws.width_px,
                ws.height_px,
                ws.cell_size()
            ),
        );
        self.hover_oracle.invalidate();
        self.window = window;
        self.cell = cell;
        self.resized = Some(Metrics { window, cell });
        Ok(())
    }

    fn schedule_color_request(&mut self, delay: Duration) {
        let at = Instant::now() + delay;
        self.color_request_at = Some(self.color_request_at.map_or(at, |queued| queued.min(at)));
    }

    fn recheck_colors_on_focus(&mut self) {
        if self.term.reports_color_scheme() {
            return;
        }
        let stale = self
            .last_color_request
            .is_none_or(|at| at.elapsed() >= COLOR_REQUEST_INTERVAL);
        if stale {
            self.schedule_color_request(Duration::ZERO);
        }
    }

    fn send_due_color_request(&mut self) -> io::Result<()> {
        let Some(at) = self.color_request_at else {
            return Ok(());
        };
        if Instant::now() < at {
            return Ok(());
        }
        self.color_request_at = None;
        self.last_color_request = Some(Instant::now());
        self.term.request_colors()
    }

    fn pane_extent(&self) -> ((f32, f32), (f32, f32)) {
        (
            (self.window.0 as f32, self.window.1 as f32),
            (self.cell.0 as f32, self.cell.1 as f32),
        )
    }

    fn ingest_native(&mut self) {
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
        let (pane, pad) = self.pane_extent();
        self.pairing
            .ingest(events, scale, now, &mut self.hover_oracle, pane, pad);
        let wants_cursor = self.term.reports_pixel_mouse() && self.hover_oracle.wants_cursor(now);
        if let Some(native) = &mut self.native {
            native.request_positions(wants_cursor);
        }
    }

    fn drain_native(&mut self) {
        self.ingest_native();
        let (zoom, scrolls) = self.pairing.take();
        let (pane, pad) = self.pane_extent();
        let pinch_here = match self.hover_oracle.verdict(Instant::now(), pane, pad) {
            Verdict::Deliver => true,
            Verdict::Discard => false,
            Verdict::Unknown => self
                .last_pointer_activity
                .is_some_and(|at| at.elapsed() < PINCH_HOVER_WINDOW),
        };
        let magnification = zoom - 1.0;
        if magnification != 0.0 && pinch_here {
            self.queued.push_back(Event::Pinch { at: self.pointer, magnification });
        }
        if scrolls.is_empty() {
            return;
        }
        if !self.native_delivering {
            self.native_delivering = true;
            logging::info("engine", "native scroll delivering");
        }
        self.queued.push_back(Event::Wheel {
            at: self.pointer,
            steps: scrolls.into_iter().map(|(dx, dy)| (-dx, -dy)).collect(),
            mods: Mods::default(),
        });
    }

    fn translate(&mut self, event: terminal::Event) -> io::Result<Option<Event>> {
        Ok(match event {
            terminal::Event::HostClosed => Some(Event::Closed),
            terminal::Event::Handoff(Handoff::Adopt { tty }) => Some(Event::Message(json!({
                "type": "handoff",
                "tty": tty,
                "socket": null,
            }))),
            terminal::Event::Handoff(Handoff::Rejoin { socket }) => Some(Event::Message(json!({
                "type": "handoff",
                "tty": null,
                "socket": socket,
            }))),
            terminal::Event::Devtools => Some(Event::Message(json!({ "type": "devtools" }))),
            terminal::Event::Wheel { x, y, delta_x, delta_y, mods } => Some(Event::Wheel {
                at: Some((x as f32, y as f32)),
                steps: vec![(delta_x, delta_y)],
                mods,
            }),
            terminal::Event::Key(key) => Some(Event::Key(key)),
            terminal::Event::Mouse(mouse) => {
                let point = (mouse.x as f32, mouse.y as f32);
                let now = Instant::now();
                self.pointer = Some(point);
                self.last_pointer_activity = Some(now);
                let scrolling = matches!(
                    mouse.kind,
                    MouseKind::ScrollUp | MouseKind::ScrollDown | MouseKind::ScrollLeft | MouseKind::ScrollRight
                );
                if self.use_native && self.native.is_some() {
                    self.ingest_native();
                    let located = self.term.reports_pixel_mouse().then_some(point);
                    if scrolling && mouse.mods == Mods::default() {
                        if self.pairing.on_wheel_tick(located, now, &mut self.hover_oracle) {
                            return Ok(None);
                        }
                    } else if let Some(located) = located {
                        self.hover_oracle.note_local(located, now);
                    }
                }
                Some(Event::Mouse(mouse))
            }
            terminal::Event::Paste(text) => Some(Event::Paste(text)),
            terminal::Event::Focus(focused) => {
                let gained = focused && !self.focused;
                self.focused = focused;
                if gained {
                    self.recheck_colors_on_focus();
                }
                Some(Event::Focus(focused))
            }
            terminal::Event::Visible(visible) => Some(Event::Visible(visible)),
            terminal::Event::WindowSize(ws) => {
                self.apply_window(&ws, "in-band report")?;
                if let Some(metrics) = self.resized.take() {
                    self.queued.push_back(Event::Resize(metrics));
                }
                if self.term.is_embedded() {
                    self.queued.push_back(Event::Redraw);
                }
                self.queued.pop_front()
            }
            terminal::Event::CellSize(cell) => {
                let ws = match self.awaiting_cell.take() {
                    Some((ws, _)) => ws,
                    None => self.term.size()?,
                };
                self.cell_exact = true;
                self.resize_to(&ws, cell, "cell size report")?;
                self.resized.take().map(Event::Resize)
            }
            terminal::Event::ClipboardData { items, ok } => Some(Event::ClipboardData { items, ok }),
            terminal::Event::ColorSchemeChanged => {
                self.schedule_color_request(COLOR_SETTLE_DELAY);
                None
            }
            terminal::Event::Colors(colors) => Some(Event::Colors(colors)),
        })
    }
}

impl Backend for TerminalBackend {
    fn start(&mut self) -> io::Result<HostInfo> {
        let colors = self.term.query_colors()?;
        let ws = self.term.size()?;
        let cell = self.term.cell_size()?.unwrap_or(terminal::DEFAULT_CELL);
        self.window = window_from(&ws, cell, false);
        self.cell = cell;
        self.cell_estimate = ws.cell_size();
        self.spawn_native();
        logging::info(
            "engine",
            format!(
                "terminal {}x{} cells, native scroll {}{}",
                ws.cols,
                ws.rows,
                self.use_native,
                if self.term.relayed() { ", tmux passthrough" } else { "" }
            ),
        );
        Ok(HostInfo { metrics: Metrics { window: self.window, cell }, colors })
    }

    fn waker(&mut self) -> io::Result<Waker> {
        let waker = self.term.waker()?;
        Ok(Waker::new(move || waker.wake()))
    }

    fn poll(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        if let Some(event) = self.queued.pop_front() {
            return Ok(Some(event));
        }
        self.send_due_color_request()?;
        if let Some(raw) = self.term.poll_event(timeout)?
            && let Some(event) = self.translate(raw)?
        {
            return Ok(Some(event));
        }
        if self.queued.is_empty() {
            self.drain_native();
        }
        Ok(self.queued.pop_front())
    }

    fn present(&mut self, frame: Frame<'_>) -> io::Result<usize> {
        self.term.draw(frame)
    }

    fn poll_metrics(&mut self) -> io::Result<Option<Metrics>> {
        let ws = self.term.size()?;
        if ws.cols != 0 || ws.width_px != 0 {
            self.apply_window(&ws, "ioctl")?;
        }
        self.apply_overdue_window()?;
        Ok(self.resized.take())
    }

    fn wants(&self) -> Wants {
        Wants {
            scroll_layer: self.term.draws_layers(),
            view_canvas: self.term.draws_locally(),
        }
    }

    fn pending_present(&self) -> bool {
        self.term.holds_a_frame()
    }

    fn animating(&self) -> bool {
        self.term.highlight_active()
    }

    fn before_frame(&mut self) -> io::Result<()> {
        self.term.tick_highlights()?;
        self.term.draw_overlay()
    }

    fn idle(&mut self, last: Frame<'_>) -> io::Result<()> {
        self.term.flatten_if_idle(last)
    }

    fn deadline(&self) -> Option<Instant> {
        [
            self.color_request_at,
            self.awaiting_cell.as_ref().map(|(_, at)| *at),
            self.term.idle_flatten_at(),
            self.term.overlay_due(),
            self.term.relayed().then(|| Instant::now() + RELAYED_RESIZE_POLL),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    fn schedule_present(&mut self, at: Option<Instant>) {
        self.term.present_at(at);
    }

    fn take_presented_at(&mut self) -> Option<Instant> {
        self.term.take_ready_at()
    }

    fn byte_rate_limit(&self) -> Option<f32> {
        self.term.frames_are_inline().then_some(INLINE_BYTES_PER_SEC)
    }

    fn set_title(&mut self, text: &str) -> io::Result<()> {
        self.term.set_title(text)
    }

    fn set_pointer_shape(&mut self, shape: &str) -> io::Result<()> {
        self.term.set_pointer_shape(shape)
    }

    fn write_clipboard(&mut self, text: &str) -> io::Result<()> {
        self.term.set_clipboard(text)
    }

    fn read_clipboard(&mut self, read: ClipboardRead<'_>) -> io::Result<()> {
        match read {
            ClipboardRead::Text => self.term.request_clipboard(),
            ClipboardRead::Types => self.term.request_clipboard_types(),
            ClipboardRead::Item(mime) => self.term.request_clipboard_data(mime),
        }
    }

    fn clipboard_has_types(&self) -> bool {
        self.term.clipboard_data_supported()
    }

    fn describe(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut info = serde_json::Map::new();
        info.insert("kittyKeyboard".into(), self.term.kitty_keyboard().into());
        info.insert("hosted".into(), self.term.is_hosted().into());
        info
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_uses_grid_when_pixels_missing() {
        let ws = WindowSize {
            cols: 80,
            rows: 24,
            width_px: 0,
            height_px: 0,
        };
        assert_eq!(window_from(&ws, (16, 32), false), (80 * 16, 24 * 32));
    }

    #[test]
    fn window_is_whole_cells_within_the_reported_pixels() {
        let ws = WindowSize {
            cols: 100,
            rows: 40,
            width_px: 1007,
            height_px: 845,
        };
        assert_eq!(window_from(&ws, (10, 20), false), (1000, 800));
        let ws = WindowSize {
            cols: 100,
            rows: 40,
            width_px: 1050,
            height_px: 800,
        };
        assert_eq!(window_from(&ws, (11, 21), false), (1045, 798));
    }

    #[test]
    fn a_cell_the_terminal_reported_outranks_relay_pixels() {
        let ws = WindowSize {
            cols: 94,
            rows: 51,
            width_px: 1504,
            height_px: 1734,
        };
        assert_eq!(window_from(&ws, (19, 42), true), (94 * 19, 51 * 42));
    }
}

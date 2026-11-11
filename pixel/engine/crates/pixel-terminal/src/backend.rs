use std::collections::VecDeque;
use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

use pixel_core::backend::{
    Backend, ClipboardRead, Event, Frame, HostInfo, Metrics, SystemClipboard, Waker,
};
use pixel_core::fonts::Font;
use pixel_core::logging;
use pixel_kitty::Wrapper;
use serde_json::json;

use crate::presenter::{CellsPresenter, KittyPresenter, Presenter};
use crate::terminal::{self, Handoff, Retarget, SessionEnv, Terminal, WindowSize};

const CELL_REPLY_WAIT: Duration = Duration::from_millis(150);
const COLOR_SETTLE_DELAY: Duration = Duration::from_millis(50);
const COLOR_REQUEST_INTERVAL: Duration = Duration::from_secs(1);
const RELAYED_RESIZE_POLL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone)]
pub struct HostOptions {
    pub socket: String,
    pub pane: String,
    pub name: String,
    pub tty: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Renderer {
    #[default]
    Kitty,
    Cells,
}

impl Renderer {
    pub fn named(name: Option<&str>) -> Self {
        match name.map(str::trim) {
            Some("cells") => Renderer::Cells,
            _ => Renderer::Kitty,
        }
    }
}

pub struct TerminalOptions {
    pub tty: Option<String>,
    pub host: Option<HostOptions>,
    pub wrapper: Wrapper,
    pub session_env: SessionEnv,
    pub watch_resize: bool,
    pub renderer: Renderer,
}

pub struct TerminalBackend {
    presenter: Box<dyn Presenter>,
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
        let open = |pixel_mouse: bool| match &options.tty {
            Some(path) => Terminal::open(path, options.wrapper, pixel_mouse),
            None => Terminal::new(options.wrapper, pixel_mouse),
        };
        let (mut term, presenter): (Terminal, Box<dyn Presenter>) = match (&options.host, options.renderer) {
            (Some(host), _) => {
                let mut term = match &host.tty {
                    Some(tty) => Terminal::join_embedded(&host.socket, &host.pane, &host.name, tty)?,
                    None => Terminal::join_host(&host.socket, &host.pane, &host.name)?,
                };
                let presenter = KittyPresenter::new(&mut term, &options.session_env)?;
                (term, Box::new(presenter))
            }
            (None, Renderer::Kitty) => {
                let mut term = open(KittyPresenter::PIXEL_MOUSE)?;
                let presenter = KittyPresenter::new(&mut term, &options.session_env)?;
                (term, Box::new(presenter))
            }
            (None, Renderer::Cells) => (open(CellsPresenter::PIXEL_MOUSE)?, Box::new(CellsPresenter::new(&options.session_env))),
        };
        if options.watch_resize {
            term.watch_resize()?;
        }
        Ok(Self {
            presenter,
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
        self.presenter.highlight_transmits(on);
    }

    pub fn note(&mut self, text: String) {
        self.presenter.note(text);
    }

    pub fn set_frame_events(&mut self, font: Option<Font>) {
        if let Err(error) = self.presenter.overlay_font(font) {
            logging::warn("engine", format!("could not clear the presenter overlay: {error}"));
        }
    }

    pub fn retarget(&mut self, target: Retarget) -> io::Result<()> {
        self.presenter.close(&mut self.term);
        self.term.retarget(target)?;
        self.presenter = self.presenter.renew(&mut self.term, &self.session_env)?;
        self.presenter.start_input(&mut self.term);
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
        let window = window_from(ws, cell, self.cell_exact || self.presenter.whole_cells());
        self.presenter.geometry(ws, cell);
        if window == self.window && cell == self.cell {
            return Ok(());
        }
        let device = self.presenter.resized(&mut self.term, cell != self.cell, cell)?;
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
        if let Some(device) = device {
            self.queued.push_back(Event::Device(device));
        }
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
                self.pointer = Some((mouse.x as f32, mouse.y as f32));
                self.last_pointer_activity = Some(Instant::now());
                let extent = self.pane_extent();
                if self.presenter.swallows(&mouse, extent, self.term.reports_pixel_mouse()) {
                    return Ok(None);
                }
                Some(Event::Mouse(mouse))
            }
            terminal::Event::Paste(text) => Some(Event::Paste(text)),
            terminal::Event::Focus(focused) => {
                if focused {
                    self.presenter.focused(&mut self.term)?;
                }
                let gained = focused && !self.focused;
                self.focused = focused;
                if gained {
                    self.recheck_colors_on_focus();
                }
                Some(Event::Focus(focused))
            }
            terminal::Event::Visible(visible) => Some(Event::Visible(visible)),
            terminal::Event::WindowSize(ws) => {
                self.presenter.window_reported();
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
            terminal::Event::Colors(colors) => {
                self.presenter.colors(colors);
                Some(Event::Colors(colors))
            }
        })
    }
}

impl Backend for TerminalBackend {
    fn start(&mut self) -> io::Result<HostInfo> {
        let colors = self.term.query_colors()?;
        let ws = self.term.size()?;
        let cell = self.term.cell_size()?.unwrap_or(terminal::DEFAULT_CELL);
        self.term.set_cell_size(cell);
        self.window = window_from(&ws, cell, self.presenter.whole_cells());
        self.cell = cell;
        self.presenter.colors(colors);
        self.presenter.geometry(&ws, cell);
        self.cell_estimate = ws.cell_size();
        self.presenter.start_input(&mut self.term);
        logging::info(
            "engine",
            format!(
                "terminal {}x{} cells, {} renderer, native scroll {}{}",
                ws.cols,
                ws.rows,
                self.presenter.name(),
                self.presenter.native_scroll(),
                if self.term.relayed() { ", tmux passthrough" } else { "" }
            ),
        );
        let device = self.presenter.device(cell);
        Ok(HostInfo { metrics: Metrics { window: self.window, cell }, colors, device })
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
            let extent = self.pane_extent();
            let pixel_mouse = self.term.reports_pixel_mouse();
            self.presenter.drain_input(extent, pixel_mouse, self.pointer, self.last_pointer_activity, &mut self.queued);
        }
        Ok(self.queued.pop_front())
    }

    fn present(&mut self, frame: Frame<'_>) -> io::Result<usize> {
        self.presenter.present(&mut self.term, frame)
    }

    fn poll_metrics(&mut self) -> io::Result<Option<Metrics>> {
        let ws = self.term.size()?;
        if ws.cols != 0 || ws.width_px != 0 {
            self.apply_window(&ws, "ioctl")?;
        }
        self.apply_overdue_window()?;
        Ok(self.resized.take())
    }

    fn pending_present(&self) -> bool {
        self.presenter.pending_present()
    }

    fn animating(&self) -> bool {
        self.presenter.animating()
    }

    fn before_frame(&mut self) -> io::Result<()> {
        self.presenter.before_frame(&mut self.term)
    }

    fn idle(&mut self) -> io::Result<()> {
        self.presenter.idle(&mut self.term)
    }

    fn spare(&mut self, fonts: &[pixel_core::fonts::Font], until: Instant) {
        self.presenter.spare(fonts, until);
    }

    fn deadline(&self) -> Option<Instant> {
        [
            self.color_request_at,
            self.awaiting_cell.as_ref().map(|(_, at)| *at),
            self.presenter.deadline(),
            self.term.relayed().then(|| Instant::now() + RELAYED_RESIZE_POLL),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    fn schedule_present(&mut self, at: Option<Instant>) {
        self.presenter.schedule_present(at);
    }

    fn take_presented_at(&mut self) -> Option<Instant> {
        self.presenter.take_presented_at()
    }

    fn byte_rate_limit(&self) -> Option<f32> {
        self.presenter.byte_rate_limit()
    }

    fn set_title(&mut self, text: &str) -> io::Result<()> {
        self.term.set_title(text)
    }

    fn set_pointer_shape(&mut self, shape: &str) -> io::Result<()> {
        let drawn = self.presenter.pointer_shape(shape);
        self.term.set_pointer_shape(shape, drawn)
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

    fn system_clipboard(&self) -> Option<Arc<dyn SystemClipboard>> {
        Some(Arc::new(crate::system_clipboard::Arboard))
    }

    fn describe(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut info = serde_json::Map::new();
        info.insert("kittyKeyboard".into(), self.term.kitty_keyboard().into());
        info.insert("hosted".into(), self.term.is_hosted().into());
        info.insert("renderer".into(), self.presenter.name().into());
        info
    }
}

impl Drop for TerminalBackend {
    fn drop(&mut self) {
        self.presenter.close(&mut self.term);
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

mod clipboard;
mod compositor;
mod doc;
mod embed;
mod frame;
mod hover;
mod input;
mod keys;
mod native_pairing;
mod overlay;
mod pointer;
mod scroll;

use std::io;
use std::time::{Duration, Instant};

use clipboard::ClipboardFlows;
use compositor::Compositor;
use hover::HoverOracle;
use native_pairing::NativePairing;
use pointer::DragTarget;

pub use overlay::HighlightArea;

use crate::wrapper::Wrapper;
use crate::logging;
use crate::menu::MenuController;
use crate::native::NativeScroll;
use crate::profiler::ProfileData;
use crate::scroll::ScrollProfile;
use crate::scroll::profiles::Smooth;
use crate::style::Color;
use crate::terminal::{
    Event, Handoff, KeyEvent, Mods, Mouse, MouseButton, MouseKind, Retarget, Terminal,
    TerminalColors,
};
use crate::text_input::InputReply;
use crate::throttle::CpuThrottle;
use crate::tree::{NodeId, PxRect};

fn window_from(ws: &crate::terminal::WindowSize, cell: (u32, u32), cell_is_exact: bool) -> (u32, u32) {
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

const PAINT_INTERVAL_WITH_INPUT_PENDING: Duration = Duration::from_millis(16);
const CELL_REPLY_WAIT: Duration = Duration::from_millis(150);

static DEFAULT_PROFILE: Smooth = Smooth {
    tau: 0.08,
    brake: 0.025,
};

pub struct EngineConfig {
    pub fonts: Vec<fontdue::Font>,
    pub cell_metrics_font: usize,
    pub watch_resize: bool,
    pub tty: Option<String>,
    pub host: Option<HostConfig>,
    pub wrapper: Wrapper,
    pub session_env: crate::terminal::SessionEnv,
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    pub socket: String,
    pub pane: String,
    pub name: String,
    pub tty: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarkRef {
    pub id: u64,
    pub offset: usize,
    pub data: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeSource {
    Type,
    Paste,
    Edit,
}

impl ChangeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeSource::Type => "type",
            ChangeSource::Paste => "paste",
            ChangeSource::Edit => "edit",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    HostClosed,
    Handoff {
        tty: Option<String>,
        socket: Option<String>,
    },
    Visible {
        visible: bool,
    },
    Click {
        view: usize,
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
        offset: Option<usize>,
    },
    ClickOutside {
        view: usize,
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
    },
    RightClick {
        view: usize,
        x: f32,
        y: f32,
    },
    Change {
        view: usize,
        node: NodeId,
        key: Option<String>,
        text: String,
        marks: Vec<MarkRef>,
        cursor: usize,
        caret: PxRect,
        source: ChangeSource,
    },
    Caret {
        view: usize,
        node: NodeId,
        key: Option<String>,
        cursor: usize,
        caret: PxRect,
    },
    Submit {
        view: usize,
        node: NodeId,
        key: Option<String>,
        text: String,
        marks: Vec<MarkRef>,
    },
    Scroll {
        view: usize,
        node: NodeId,
        key: Option<String>,
        offset: f32,
        max: f32,
    },
    Resize {
        view: usize,
        width: u32,
        height: u32,
        cell: (u32, u32),
        base_px: f32,
    },
    Colors {
        colors: TerminalColors,
    },
    Devtools,
    Inspect {
        view: usize,
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
    },
    Key {
        view: usize,
        event: KeyEvent,
    },
    Paste {
        view: usize,
        text: String,
    },
    Focus {
        focused: bool,
    },
    PasteImage {
        view: usize,
        node: NodeId,
        key: Option<String>,
        path: String,
        width: u32,
        height: u32,
        source: crate::clipboard_image::PasteSource,
    },
    SerializeMarks {
        view: usize,
        token: u64,
        marks: Vec<(NodeId, u64, usize)>,
    },
    Wheel {
        view: usize,
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
        delta_x: f32,
        delta_y: f32,
        precise: bool,
        mods: Mods,
    },
    MouseMove {
        view: usize,
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
    },
    Pointer {
        view: usize,
        node: NodeId,
        key: Option<String>,
        kind: MouseKind,
        button: MouseButton,
        mods: crate::terminal::Mods,
        x: f32,
        y: f32,
    },
    HoverEnter {
        view: usize,
        node: NodeId,
        key: Option<String>,
    },
    HoverLeave {
        view: usize,
        node: NodeId,
        key: Option<String>,
    },
    Drag {
        view: usize,
        node: NodeId,
        key: Option<String>,
        phase: DragPhase,
        x: f32,
        y: f32,
        mods: Mods,
    },
    Selection {
        view: usize,
        node: NodeId,
        key: Option<String>,
        text: String,
        rect: PxRect,
        parts: Vec<(String, usize, usize)>,
    },
    Log(logging::LogEntry),
    Profile(ProfileData),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FrameStats {
    pub frame_ms: f32,
    pub fps: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragPhase {
    Start,
    Move,
    End,
}

pub struct Engine {
    pub term: Terminal,
    session_env: crate::terminal::SessionEnv,
    pub comp: Compositor,
    pub fonts: Vec<fontdue::Font>,
    cell_metrics_font: usize,
    pub cell: (u32, u32),
    cell_estimate: Option<(u32, u32)>,
    pub base_px: f32,
    pub colors: TerminalColors,
    cursor: Option<(f32, f32)>,
    hover: Option<(usize, NodeId)>,
    focus_view: usize,
    active_view: usize,
    term_focused: bool,
    pub native: Option<NativeScroll>,
    pub use_native: bool,
    pixel_mouse: bool,
    last_native_scroll: Option<Instant>,
    pairing: NativePairing,
    hover_oracle: HoverOracle,
    pub profile: &'static dyn ScrollProfile,
    pub(super) last_wheel_tick:
        Option<(Instant, crate::terminal::MouseKind, u32, u32, crate::terminal::Mods)>,
    pub(super) wheel_echo_consumed: bool,
    default_menu: bool,
    menu: MenuController,
    inspect_mode: bool,
    inspect_view: usize,
    inspect_hover: Option<NodeId>,
    highlight: Option<(usize, NodeId, HighlightArea)>,
    hover_target: Option<(usize, NodeId)>,
    emit_logs: bool,
    log_cursor: u64,
    drag: Option<(usize, DragTarget)>,
    pending_click: Option<(usize, NodeId)>,
    pointer_capture: Option<(usize, NodeId)>,
    key_passthrough: bool,
    last_selection: Option<(
        usize,
        NodeId,
        crate::selection::DocPos,
        crate::selection::DocPos,
        u32,
    )>,
    bar_hover: Option<(usize, NodeId)>,
    bar_drag: Option<(usize, NodeId, f32)>,
    reveal: bool,
    pub key_capture: Vec<String>,
    pub cpu_throttle: CpuThrottle,
    throttle_registered: bool,
    scroll_burst: u32,
    last_scroll_mark: Option<Instant>,
    clipboard: ClipboardFlows,
    focus_click: Option<(Instant, (f32, f32))>,
    focus_click_enabled: bool,
    last_pointer_activity: Option<Instant>,
    last_pointer_click: Option<Instant>,
    next_pasted_mark: u64,
    pending: Vec<EngineEvent>,
    awaiting_cell: Option<(crate::terminal::WindowSize, Instant)>,
    cell_exact: bool,
    color_request_at: Option<Instant>,
    last_color_request: Option<Instant>,
    last_step: Instant,
    last_frame: Instant,
    last_frame_bytes: usize,
    frame_deferred: bool,
    max_fps: f32,
    frame_due: Option<Instant>,
    pub stats: FrameStats,
}

const FOCUS_CLICK_POINTER_WINDOW: Duration = Duration::from_millis(1000);
const FOCUS_CLICK_DELAY: Duration = Duration::from_millis(75);
const COLOR_SETTLE_DELAY: Duration = Duration::from_millis(50);
const COLOR_REQUEST_INTERVAL: Duration = Duration::from_secs(1);
const RELAYED_RESIZE_POLL: Duration = Duration::from_millis(500);

impl Engine {
    pub fn new(config: EngineConfig) -> io::Result<Self> {
        assert!(!config.fonts.is_empty());
        let max_fps = frame::DEFAULT_MAX_FPS;
        let mut term = match (&config.host, &config.tty) {
            (Some(host), _) => match &host.tty {
                Some(tty) => Terminal::join_embedded(&host.socket, &host.pane, &host.name, tty)?,
                None => Terminal::join_host(&host.socket, &host.pane, &host.name)?,
            },
            (None, Some(path)) => {
                Terminal::open(path, config.wrapper, config.session_env.clone())?
            }
            (None, None) => Terminal::new(config.wrapper, config.session_env.clone())?,
        };
        if config.watch_resize {
            term.watch_resize()?;
        }
        let colors = term.query_colors()?;
        let ws = term.size()?;
        let cell = term.cell_size()?.unwrap_or(crate::terminal::DEFAULT_CELL);
        let window = window_from(&ws, cell, false);
        let base_px = px_for_cell_height(&config.fonts[config.cell_metrics_font], cell.1 as f32);
        let native = if term.is_hosted() && !term.is_embedded() {
            None
        } else {
            NativeScroll::spawn(term.waker().ok())
        };
        let use_native = native.is_some();
        let pixel_mouse = term.reports_pixel_mouse();
        logging::info(
            "engine",
            format!(
                "started {}x{}px, cell {}x{}, base {base_px:.1}px, native scroll {}{}",
                window.0,
                window.1,
                cell.0,
                cell.1,
                use_native,
                if term.relayed() {
                    ", tmux passthrough"
                } else {
                    ""
                }
            ),
        );
        let engine = Self {
            term,
            session_env: config.session_env,
            comp: Compositor::new(window),
            fonts: config.fonts,
            cell_metrics_font: config.cell_metrics_font,
            cell,
            cell_estimate: ws.cell_size(),
            base_px,
            colors,
            cursor: None,
            hover: None,
            focus_view: 0,
            active_view: 0,
            term_focused: true,
            native,
            use_native,
            pixel_mouse,
            last_native_scroll: None,
            pairing: NativePairing::new(),
            hover_oracle: HoverOracle::new(),
            profile: &DEFAULT_PROFILE,
            last_wheel_tick: None,
            wheel_echo_consumed: false,
            default_menu: false,
            menu: MenuController::default(),
            inspect_mode: false,
            inspect_view: 0,
            inspect_hover: None,
            highlight: None,
            hover_target: None,
            emit_logs: false,
            log_cursor: 0,
            drag: None,
            pending_click: None,
            pointer_capture: None,
            key_passthrough: false,
            last_selection: None,
            bar_hover: None,
            bar_drag: None,
            reveal: false,
            key_capture: Vec::new(),
            cpu_throttle: CpuThrottle::new(),
            throttle_registered: false,
            scroll_burst: 0,
            last_scroll_mark: None,
            clipboard: ClipboardFlows::new(),
            focus_click: None,
            focus_click_enabled: true,
            last_pointer_activity: None,
            last_pointer_click: None,
            next_pasted_mark: 1 << 48,
            pending: Vec::new(),
            awaiting_cell: None,
            cell_exact: false,
            color_request_at: None,
            last_color_request: None,
            last_step: Instant::now(),
            last_frame: Instant::now(),
            last_frame_bytes: 0,
            frame_deferred: false,
            max_fps,
            frame_due: None,
            stats: FrameStats::default(),
        };
        Ok(engine)
    }

    pub fn add_font(&mut self, font: fontdue::Font) -> usize {
        self.fonts.push(font);
        self.fonts.len() - 1
    }

    pub fn add_view(&mut self) -> usize {
        let view = self.comp.add_view();
        logging::info("engine", format!("view {view} created"));
        view
    }

    pub fn set_pane(&mut self, slot: usize, view: usize) {
        if self.comp.set_pane(slot, view) {
            logging::info("engine", format!("pane {slot} shows view {view}"));
            let resized = self.comp.apply_layout(true);
            self.push_resizes(resized);
        }
    }

    pub fn set_inspect_view(&mut self, view: usize) {
        if view < self.comp.views.len() {
            self.inspect_view = view;
        }
    }

    pub fn set_clear_color(&mut self, view: usize, color: Color) {
        let Some(v) = self.comp.views.get_mut(view) else {
            return;
        };
        if v.clear_color != color {
            v.clear_color = color;
            v.tree.mark_paint();
        }
    }

    pub fn set_default_menu(&mut self, enabled: bool) {
        self.default_menu = enabled;
        if !enabled {
            self.close_menu();
        }
    }

    pub fn set_focus_click(&mut self, enabled: bool) {
        self.focus_click_enabled = enabled;
        if !enabled {
            self.focus_click = None;
        }
    }

    pub fn set_inspect_mode(&mut self, enabled: bool) {
        if self.inspect_mode != enabled {
            self.inspect_mode = enabled;
            self.inspect_hover = None;
            self.comp.dirty = true;
        }
    }

    pub fn set_highlight(&mut self, target: Option<(usize, NodeId, HighlightArea)>) {
        if self.highlight != target {
            self.highlight = target;
            self.comp.dirty = true;
        }
    }

    pub fn set_split(&mut self, split: Option<f32>) {
        if !self.comp.set_split(split) {
            return;
        }
        logging::info(
            "engine",
            match self.comp.split {
                Some(f) => format!("split screen at {:.0}%", f * 100.0),
                None => "split screen closed".into(),
            },
        );
        let resized = self.comp.apply_layout(false);
        self.push_resizes(resized);
    }

    fn push_resizes(&mut self, resized: Vec<(usize, (u32, u32))>) {
        for (view, size) in resized {
            self.pending.push(EngineEvent::Resize {
                view,
                width: size.0,
                height: size.1,
                cell: self.cell,
                base_px: self.base_px,
            });
        }
    }

    pub fn native_scroll_active(&self) -> bool {
        self.use_native
            && self.native.is_some()
            && self
                .last_native_scroll
                .is_some_and(|at| at.elapsed() < Duration::from_millis(1500))
    }

    pub fn profile_start(&mut self) {
        if !crate::profiler::is_recording() {
            logging::info("profiler", "recording started");
            crate::profiler::start();
        }
    }

    pub fn profile_stop(&mut self) {
        if let Some(data) = self.stop_recording() {
            self.pending.push(EngineEvent::Profile(data));
        }
    }

    pub fn profile_stop_to_file(&mut self) -> io::Result<Option<std::path::PathBuf>> {
        self.stop_recording().map(|data| crate::profiler::write_report(&data)).transpose()
    }

    fn stop_recording(&mut self) -> Option<ProfileData> {
        crate::image_cache::emit_pending_waits();
        let data = crate::profiler::stop()?;
        logging::info("profiler", format!("recording stopped, {} spans", data.spans.len()));
        Some(data)
    }

    pub fn set_cpu_throttle(&mut self, rate: f32) {
        if !CpuThrottle::supported() && rate > 1.0 {
            logging::warn("engine", "cpu throttle is only supported on macOS");
            return;
        }
        self.cpu_throttle.set_rate(rate);
        let applied = self.cpu_throttle.rate();
        logging::info("engine", format!("cpu throttle {applied}x"));
        crate::profiler::mark("throttle", 0, || format!("cpu throttle {applied}x"));
    }

    pub fn flush_view_layout(&mut self, view: usize) {
        let base_px = self.base_px;
        let fonts = &self.fonts;
        if let Some(v) = self.comp.views.get_mut(view) {
            v.tree.flush_layout(fonts, base_px);
        }
    }

    pub fn set_focus(&mut self, view: usize, id: Option<NodeId>) {
        if view >= self.comp.views.len() {
            return;
        }
        for (i, v) in self.comp.views.iter_mut().enumerate() {
            if i != view {
                v.tree.set_focus(None);
            }
        }
        self.comp.views[view].tree.set_focus(id);
        if id.is_some() {
            self.key_passthrough = false;
        }
        self.focus_view = view;
    }

    fn focused(&self) -> Option<(usize, NodeId)> {
        self.comp.views[self.focus_view]
            .tree
            .focus()
            .map(|id| (self.focus_view, id))
    }

    fn paint_then_wait(
        &mut self,
        out_empty: bool,
        wait: Option<Duration>,
    ) -> io::Result<Option<crate::terminal::Event>> {
        self.frame()?;
        self.send_due_color_request()?;
        let mut first_wait = if self.frame_deferred && let Some(due) = self.frame_due {
            Some(due.saturating_duration_since(Instant::now()).max(Duration::from_millis(1)))
        } else if self.animating() || self.frame_deferred {
            Some(Duration::from_millis(6))
        } else if !out_empty {
            Some(Duration::ZERO)
        } else {
            wait
        };
        let deadlines = [
            self.clipboard.osc_deadline(),
            self.focus_click.as_ref().map(|(deadline, _)| *deadline),
            self.color_request_at,
            self.awaiting_cell.as_ref().map(|(_, at)| *at),
            self.term.idle_flatten_at(),
            self.term.overlay_due(),
        ];
        for deadline in deadlines.into_iter().flatten() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            first_wait = Some(first_wait.map_or(remaining, |w| w.min(remaining)));
        }
        if self.term.relayed() {
            first_wait = Some(first_wait.map_or(RELAYED_RESIZE_POLL, |w| w.min(RELAYED_RESIZE_POLL)));
        }
        self.term.poll_event(first_wait)
    }

    pub fn pump(&mut self, wait: Option<Duration>) -> io::Result<Vec<EngineEvent>> {
        if !self.throttle_registered {
            self.throttle_registered = true;
            self.cpu_throttle.register_current_thread();
            if let Ok(waker) = self.term.waker() {
                crate::image_cache::set_waker(move || waker.wake());
            }
        }

        self.drain_images();
        let mut out = Vec::new();
        out.append(&mut self.pending);
        if !out.is_empty() {
            self.drain_logs(&mut out);
            return Ok(out);
        }
        self.check_resize(&mut out)?;
        let mut event = self.term.poll_event(Some(Duration::ZERO))?;
        let input_pending = event.is_some();
        if !input_pending {
            event = self.paint_then_wait(out.is_empty(), wait)?;
        }
        while let Some(current) = event {
            self.handle_event(current, &mut out)?;
            event = self.term.poll_event(Some(Duration::ZERO))?;
        }
        if let Some((deadline, point)) = self.focus_click
            && Instant::now() >= deadline
        {
            self.focus_click = None;
            for kind in [MouseKind::Down, MouseKind::Up] {
                self.handle_mouse(
                    Mouse {
                        kind,
                        button: MouseButton::Left,
                        mods: Mods::default(),
                        x: point.0 as u32,
                        y: point.1 as u32,
                    },
                    &mut out,
                )?;
            }
        }
        self.check_resize(&mut out)?;
        self.apply_overdue_window()?;
        self.drain_native(&mut out);
        let now = Instant::now();
        let dt = now.duration_since(self.last_step).as_secs_f32().min(0.05);
        self.last_step = now;
        self.step_scrolls(dt);
        self.step_bars(dt);
        if self.reveal {
            self.reveal = false;
            self.reveal_caret();
        }
        self.emit_scroll_events(&mut out);
        self.drain_images();
        out.append(&mut self.pending);
        if !input_pending || self.last_frame.elapsed() >= PAINT_INTERVAL_WITH_INPUT_PENDING {
            self.frame()?;
        }
        self.drain_logs(&mut out);
        Ok(out)
    }

    fn drain_images(&mut self) {
        let drained = crate::image_cache::drain_completed();
        if drained.landed {
            for view in &mut self.comp.views {
                view.tree.mark_layout();
            }
        }
        for (view, node, image) in self
            .clipboard
            .resolve_pastes(&mut self.term, drained.pastes)
        {
            let mut out = std::mem::take(&mut self.pending);
            self.push_paste_image(view, node, image, &mut out);
            self.pending = out;
        }
    }

    pub fn set_log_capture(&mut self, on: bool) {
        logging::keep_in_memory(on);
        self.emit_logs = on;
    }

    pub fn set_log_file(&mut self, path: Option<std::path::PathBuf>) {
        logging::write_to_file(path);
    }

    fn drain_logs(&mut self, out: &mut Vec<EngineEvent>) {
        if !self.emit_logs {
            return;
        }
        let entries = logging::entries_after(self.log_cursor);
        if let Some(last) = entries.last() {
            self.log_cursor = last.seq + 1;
        }
        out.extend(entries.into_iter().map(EngineEvent::Log));
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

    fn apply_colors(&mut self, colors: TerminalColors, out: &mut Vec<EngineEvent>) {
        if colors == self.colors {
            return;
        }
        self.colors = colors;
        logging::info(
            "engine",
            format!("colors changed, background {:?}", colors.background),
        );
        for view in &mut self.comp.views {
            view.tree.mark_paint();
        }
        self.comp.dirty = true;
        out.push(EngineEvent::Colors { colors });
    }

    fn check_resize(&mut self, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        let ws = self.term.size()?;
        if ws.cols == 0 && ws.width_px == 0 {
            return Ok(());
        }
        self.apply_window(&ws, "ioctl")?;
        out.append(&mut self.pending);
        Ok(())
    }

    fn apply_window(&mut self, ws: &crate::terminal::WindowSize, source: &str) -> io::Result<()> {
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

    fn resize_to(&mut self, ws: &crate::terminal::WindowSize, cell: (u32, u32), source: &str) -> io::Result<()> {
        self.term.set_cell_size(cell);
        let window = window_from(ws, cell, self.cell_exact);
        if window == self.comp.window && cell == self.cell {
            return Ok(());
        }
        let estimate = ws.cell_size();
        logging::info(
            "engine",
            format!("window size from {source}: {}x{} cells, {}x{} px, estimated cell {:?}", ws.cols, ws.rows, ws.width_px, ws.height_px, estimate),
        );
        let base_px = px_for_cell_height(
            &self.fonts[self.cell_metrics_font.min(self.fonts.len() - 1)],
            cell.1 as f32,
        );
        logging::info(
            "engine",
            format!(
                "resize {}x{} cell {}x{} base {:.1}px -> {}x{} cell {}x{} base {base_px:.1}px",
                self.comp.window.0,
                self.comp.window.1,
                self.cell.0,
                self.cell.1,
                self.base_px,
                window.0,
                window.1,
                cell.0,
                cell.1,
            ),
        );
        crate::profiler::mark("resize", 0, || {
            format!("resize {}x{} cell {}x{}", window.0, window.1, cell.0, cell.1)
        });
        let base_changed = (base_px - self.base_px).abs() > 0.01;
        self.hover_oracle.invalidate();
        self.comp.window = window;
        self.cell = cell;
        self.base_px = base_px;
        let resized = self.comp.apply_layout(base_changed);
        self.push_resizes(resized);
        Ok(())
    }

    pub fn retarget(&mut self, target: Retarget) -> io::Result<()> {
        self.term.retarget(target, self.session_env.clone())?;
        self.native = if self.term.is_hosted() && !self.term.is_embedded() {
            None
        } else {
            NativeScroll::spawn(self.term.waker().ok())
        };
        self.use_native = self.native.is_some();
        self.pixel_mouse = self.term.reports_pixel_mouse();
        let colors = self.term.query_colors()?;
        let mut out = Vec::new();
        self.apply_colors(colors, &mut out);
        self.cell_estimate = None;
        let ws = self.term.size()?;
        self.apply_window(&ws, "retarget")?;
        self.comp.dirty = true;
        self.pending.append(&mut out);
        Ok(())
    }

    fn handle_event(&mut self, event: Event, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        match event {
            Event::HostClosed => out.push(EngineEvent::HostClosed),
            Event::Wheel {
                x,
                y,
                delta_x,
                delta_y,
                mods,
            } => self.forwarded_wheel((x as f32, y as f32), (delta_x, delta_y), mods, out),
            Event::Handoff(Handoff::Adopt { tty }) => out.push(EngineEvent::Handoff {
                tty: Some(tty),
                socket: None,
            }),
            Event::Handoff(Handoff::Rejoin { socket }) => out.push(EngineEvent::Handoff {
                tty: None,
                socket: Some(socket),
            }),
            Event::Key(key) => self.handle_key(key, out)?,
            Event::Paste(text) => {
                crate::profiler::mark("paste", self.active_view as u32, || {
                    format!("paste ({} chars)", text.chars().count())
                });
                if let Some((view, focus)) = self.focused() {
                    if let Some(image) = crate::clipboard_image::image_path_from_paste(&text) {
                        self.push_paste_image(view, focus, image, out);
                    } else {
                        let rich = clipboard::parse_rich_paste(&text);
                        if let Some((_, marks)) = &rich {
                            self.next_pasted_mark += marks.len() as u64;
                        }
                        let first_id = self.next_pasted_mark
                            - rich.as_ref().map_or(0, |(_, m)| m.len() as u64);
                        if let Some(input) = self.comp.views[view].tree.input_mut(focus) {
                            match rich {
                                Some((rich_text, marks)) => {
                                    input.insert_rich(&rich_text, &marks, first_id)
                                }
                                None => input.insert(&text),
                            }
                            self.finish_reply(
                                view,
                                focus,
                                InputReply::Edited,
                                ChangeSource::Paste,
                                out,
                            )?;
                        }
                    }
                    // todo: review this better
                } else if let Some(image) = crate::clipboard_image::image_path_from_paste(&text) {
                    let view = self.active_view;
                    let root = self.comp.views[view].tree.root();
                    self.push_paste_image(view, root, image, out);
                } else {
                    out.push(EngineEvent::Paste {
                        view: self.active_view,
                        text,
                    });
                }
            }
            Event::Focus(focused) => {
                let gained = focused && !self.term_focused;
                self.term_focused = focused;
                if gained {
                    self.recheck_colors_on_focus();
                }
                if !focused {
                    self.focus_click = None;
                } else if gained
                    && let Some(point) = self.cursor
                    && focus_click_arms(
                        self.focus_click_enabled,
                        self.last_pointer_activity,
                        self.last_pointer_click,
                        Instant::now(),
                    )
                {
                    self.focus_click = Some((Instant::now() + FOCUS_CLICK_DELAY, point));
                }
                out.push(EngineEvent::Focus { focused });
            }
            Event::WindowSize(ws) => {
                self.apply_window(&ws, "in-band report")?;
                if self.term.is_embedded() {
                    self.comp.dirty = true;
                }
            }
            Event::CellSize(cell) => {
                let ws = match self.awaiting_cell.take() {
                    Some((ws, _)) => ws,
                    None => self.term.size()?,
                };
                self.cell_exact = true;
                self.resize_to(&ws, cell, "cell size report")?;
            }
            Event::Mouse(mouse) => self.handle_mouse(mouse, out)?,
            Event::ClipboardData { items, ok } => {
                self.clipboard
                    .handle_clipboard_data(&mut self.term, items, ok)
            }
            Event::ColorSchemeChanged => self.schedule_color_request(COLOR_SETTLE_DELAY),
            Event::Colors(colors) => self.apply_colors(colors, out),
            Event::Devtools => out.push(EngineEvent::Devtools),
            Event::Visible(visible) => out.push(EngineEvent::Visible { visible }),
        }
        self.emit_selection_change(out);
        Ok(())
    }

    pub fn set_clipboard(&mut self, text: &str) {
        if let Err(error) = self.term.set_clipboard(text) {
            logging::warn("engine", format!("clipboard write failed: {error}"));
        }
    }

    pub fn set_title(&mut self, text: &str) {
        if let Err(error) = self.term.set_title(text) {
            logging::warn("engine", format!("title write failed: {error}"));
        }
    }

    pub fn request_clipboard_image(&mut self, view: usize) {
        let root = self.comp.views[view].tree.root();
        self.clipboard.request_paste(view, root);
    }

    fn begin_rich_capture(
        &mut self,
        view: usize,
        text: String,
        marks: Vec<(NodeId, crate::text_input::Mark)>,
    ) -> io::Result<()> {
        let event = self
            .clipboard
            .begin_rich_capture(&mut self.term, view, text, marks)?;
        self.pending.extend(event);
        Ok(())
    }

    pub fn attach_rich_clipboard(&mut self, token: u64, marks: Vec<(usize, String)>) {
        self.clipboard.attach_rich(&mut self.term, token, marks);
    }

}


pub fn px_for_cell_height(font: &fontdue::Font, cell_height: f32) -> f32 {
    let probe = font
        .horizontal_line_metrics(100.0)
        .expect("font has horizontal metrics");
    (cell_height * 100.0 / probe.new_line_size).clamp(6.0, 512.0)
}

fn focus_click_arms(
    enabled: bool,
    last_pointer_activity: Option<Instant>,
    last_pointer_click: Option<Instant>,
    now: Instant,
) -> bool {
    enabled
        && last_pointer_activity
            .is_some_and(|at| now.duration_since(at) <= FOCUS_CLICK_POINTER_WINDOW)
        && last_pointer_click
            .is_none_or(|click| now.duration_since(click) > FOCUS_CLICK_POINTER_WINDOW)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::WindowSize;

    #[test]
    fn focus_click_arms_after_recent_pointer_motion() {
        let moved = Instant::now();
        let now = moved + Duration::from_millis(200);
        assert!(focus_click_arms(true, Some(moved), None, now));
    }

    #[test]
    fn focus_click_does_not_arm_when_disabled() {
        let moved = Instant::now();
        let now = moved + Duration::from_millis(200);
        assert!(!focus_click_arms(false, Some(moved), None, now));
    }

    #[test]
    fn focus_click_does_not_arm_after_a_recent_real_click() {
        let moved = Instant::now();
        let clicked = moved + Duration::from_millis(100);
        let now = moved + Duration::from_millis(200);
        assert!(!focus_click_arms(true, Some(moved), Some(clicked), now));
        let old_click = now - FOCUS_CLICK_POINTER_WINDOW - Duration::from_millis(1);
        assert!(focus_click_arms(true, Some(moved), Some(old_click), now));
    }

    #[test]
    fn focus_click_does_not_arm_without_recent_pointer_motion() {
        let moved = Instant::now();
        let now = moved + FOCUS_CLICK_POINTER_WINDOW + Duration::from_millis(1);
        assert!(!focus_click_arms(true, Some(moved), None, now));
        assert!(!focus_click_arms(true, None, None, now));
    }

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

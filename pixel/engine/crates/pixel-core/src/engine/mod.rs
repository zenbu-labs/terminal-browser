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
    Event, Handoff, KeyEvent, Mods, MouseButton, MouseKind, Retarget, Terminal,
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
    last_pointer_activity: Option<Instant>,
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
            last_pointer_activity: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::{Dimension, Inset, Position, Style};
    use crate::terminal::{Mouse, WindowSize};
    use crate::terminal::test_support::{FakeTerminal, open_pty};
    use crate::tree::Props;
    use std::os::fd::AsRawFd as _;

    struct TestEngine {
        engine: Engine,
        _terminal: FakeTerminal,
        _master: std::fs::File,
        _slave: std::fs::File,
        popup: NodeId,
        backdrop: NodeId,
    }

    impl TestEngine {
        fn new(pointer_events: bool) -> Self {
            let (master, slave, path) = open_pty();
            let size = libc::winsize {
                ws_col: 40,
                ws_row: 15,
                ws_xpixel: 320,
                ws_ypixel: 240,
            };
            #[allow(unsafe_code)]
            let resized = unsafe { libc::ioctl(slave.as_raw_fd(), libc::TIOCSWINSZ, &size) };
            assert_eq!(resized, 0);
            let terminal = FakeTerminal::new(&master, Some(b"\x1b[?1016;1$y"), false);
            let font = fontdue::Font::from_bytes(
                include_bytes!("../../../../assets/fonts/JetBrainsMono-Regular.ttf").as_slice(),
                fontdue::FontSettings::default(),
            )
            .unwrap();
            let mut engine = Engine::new(EngineConfig {
                fonts: vec![font],
                cell_metrics_font: 0,
                watch_resize: false,
                tty: Some(path),
                host: None,
                wrapper: Wrapper::None,
                session_env: crate::terminal::SessionEnv::of_session(Default::default()),
            })
            .unwrap();
            engine.use_native = false;
            engine.native = None;
            assert_eq!(engine.comp.window, (320, 240));
            assert_eq!(engine.cell, (8, 16));
            let tree = &mut engine.comp.views[0].tree;
            let backdrop = tree.create(Props {
                key: Some("backdrop".into()),
                clickable: true,
                style: Style {
                    position: Position::Absolute,
                    inset: Inset::top_left(0.0, 0.0),
                    width: Dimension::Px(320.0),
                    height: Dimension::Px(240.0),
                    ..Style::default()
                },
                ..Props::default()
            });
            tree.append(tree.root(), backdrop);
            let popup = tree.create(Props {
                key: Some("popup".into()),
                pointer_events,
                clickable: true,
                outside_click_events: true,
                hover_events: true,
                wheel_events: true,
                style: Style {
                    position: Position::Absolute,
                    inset: Inset::top_left(40.0, 40.0),
                    width: Dimension::Px(80.0),
                    height: Dimension::Px(60.0),
                    ..Style::default()
                },
                ..Props::default()
            });
            tree.append(tree.root(), popup);
            engine.flush_view_layout(0);
            assert_eq!(
                engine.comp.views[0].tree.hit_pointer(50.0, 50.0),
                pointer_events.then_some(popup)
            );
            assert_eq!(
                engine.comp.views[0].tree.hit_click(10.0, 10.0),
                Some(backdrop)
            );
            Self {
                engine,
                _terminal: terminal,
                _master: master,
                _slave: slave,
                popup,
                backdrop,
            }
        }
    }

    fn mouse(kind: MouseKind, point: (u32, u32)) -> Mouse {
        Mouse {
            kind,
            button: MouseButton::Left,
            mods: Mods::default(),
            x: point.0,
            y: point.1,
        }
    }

    fn refocus(engine: &mut Engine, out: &mut Vec<EngineEvent>) {
        engine.handle_event(Event::Focus(false), out).unwrap();
        assert!(!engine.term_focused);
        assert_eq!(out.last(), Some(&EngineEvent::Focus { focused: false }));
        engine.handle_event(Event::Focus(true), out).unwrap();
        assert!(engine.term_focused);
        assert_eq!(out.last(), Some(&EngineEvent::Focus { focused: true }));
    }

    fn pump_past_focus_delay(engine: &mut Engine, out: &mut Vec<EngineEvent>) {
        let until = Instant::now() + Duration::from_millis(110);
        while Instant::now() < until {
            out.extend(engine.pump(Some(Duration::from_millis(10))).unwrap());
        }
    }

    fn assert_no_clicks(out: &[EngineEvent]) {
        assert!(
            !out.iter().any(|event| matches!(
                event,
                EngineEvent::Click { .. }
                    | EngineEvent::ClickOutside { .. }
                    | EngineEvent::RightClick { .. }
                    | EngineEvent::Pointer {
                        kind: MouseKind::Down | MouseKind::Up,
                        ..
                    }
            )),
            "focus fabricated a click: {out:?}"
        );
    }

    #[test]
    fn refocus_after_motion_inside_popup_does_not_send_pointer_buttons() {
        let mut fixture = TestEngine::new(true);
        let engine = &mut fixture.engine;
        let mut out = Vec::new();
        engine
            .handle_event(Event::Mouse(mouse(MouseKind::Move, (50, 50))), &mut out)
            .unwrap();
        assert!(out.iter().any(|event| matches!(event,
            EngineEvent::Pointer { node, kind: MouseKind::Move, .. } if *node == fixture.popup
        )));
        assert!(out.iter().any(|event| matches!(event,
            EngineEvent::HoverEnter { node, .. } if *node == fixture.popup
        )));
        let activity = engine.last_pointer_activity;
        refocus(engine, &mut out);
        assert!(engine.color_request_at.is_some());
        pump_past_focus_delay(engine, &mut out);
        assert_no_clicks(&out);
        assert_eq!(engine.cursor, Some((50.0, 50.0)));
        assert_eq!(engine.last_pointer_activity, activity);
        assert_eq!(engine.hover_target, Some((0, fixture.popup)));
        assert_eq!(engine.pointer_capture, None);
        assert!(engine.last_color_request.is_some());
    }

    #[test]
    fn refocus_after_motion_outside_popup_does_not_dismiss_it() {
        let mut fixture = TestEngine::new(true);
        let engine = &mut fixture.engine;
        let mut out = Vec::new();
        engine
            .handle_mouse(mouse(MouseKind::Move, (10, 10)), &mut out)
            .unwrap();
        refocus(engine, &mut out);
        pump_past_focus_delay(engine, &mut out);
        assert_no_clicks(&out);
        assert_eq!(engine.comp.views[0].tree.find("popup"), Some(fixture.popup));
        assert_eq!(engine.pending_click, None);
    }

    #[test]
    fn repeated_focus_reports_do_not_create_clicks() {
        let mut fixture = TestEngine::new(false);
        let engine = &mut fixture.engine;
        let mut out = Vec::new();
        engine
            .handle_mouse(mouse(MouseKind::Move, (50, 50)), &mut out)
            .unwrap();
        for _ in 0..2 {
            refocus(engine, &mut out);
            engine.handle_event(Event::Focus(true), &mut out).unwrap();
            pump_past_focus_delay(engine, &mut out);
            engine.handle_event(Event::Focus(true), &mut out).unwrap();
        }
        assert_no_clicks(&out);
        let focus: Vec<_> = out
            .iter()
            .filter_map(|event| match event {
                EngineEvent::Focus { focused } => Some(*focused),
                _ => None,
            })
            .collect();
        assert_eq!(focus, [false, true, true, true, false, true, true, true]);
    }

    #[test]
    fn genuine_pointer_buttons_and_capture_survive_refocus() {
        let mut fixture = TestEngine::new(true);
        let engine = &mut fixture.engine;
        let mut out = Vec::new();
        let down = Mouse {
            mods: Mods {
                shift: true,
                ..Mods::default()
            },
            ..mouse(MouseKind::Down, (50, 50))
        };
        engine.handle_event(Event::Mouse(down), &mut out).unwrap();
        assert_eq!(
            out,
            vec![EngineEvent::Pointer {
                view: 0,
                node: fixture.popup,
                key: Some("popup".into()),
                kind: MouseKind::Down,
                button: down.button,
                mods: down.mods,
                x: 10.0,
                y: 10.0,
            }]
        );
        assert_eq!(engine.pointer_capture, Some((0, fixture.popup)));
        out.clear();
        refocus(engine, &mut out);
        pump_past_focus_delay(engine, &mut out);
        assert_no_clicks(&out);
        assert_eq!(engine.pointer_capture, Some((0, fixture.popup)));
        out.clear();
        engine
            .handle_mouse(mouse(MouseKind::Move, (10, 10)), &mut out)
            .unwrap();
        engine
            .handle_mouse(mouse(MouseKind::Up, (10, 10)), &mut out)
            .unwrap();
        assert_eq!(
            out,
            vec![
                EngineEvent::Pointer {
                    view: 0,
                    node: fixture.popup,
                    key: Some("popup".into()),
                    kind: MouseKind::Move,
                    button: MouseButton::Left,
                    mods: Mods::default(),
                    x: -30.0,
                    y: -30.0,
                },
                EngineEvent::Pointer {
                    view: 0,
                    node: fixture.popup,
                    key: Some("popup".into()),
                    kind: MouseKind::Up,
                    button: MouseButton::Left,
                    mods: Mods::default(),
                    x: -30.0,
                    y: -30.0,
                },
            ]
        );
        assert_eq!(engine.pointer_capture, None);
    }

    #[test]
    fn genuine_clicks_still_activate_popup_and_dismiss_on_backdrop() {
        let mut fixture = TestEngine::new(false);
        let engine = &mut fixture.engine;
        let mut out = Vec::new();
        engine
            .handle_mouse(mouse(MouseKind::Move, (50, 50)), &mut out)
            .unwrap();
        refocus(engine, &mut out);
        out.clear();
        engine
            .handle_mouse(mouse(MouseKind::Down, (50, 50)), &mut out)
            .unwrap();
        assert!(!out.iter().any(|event| matches!(
            event,
            EngineEvent::Click { .. } | EngineEvent::ClickOutside { .. }
        )));
        engine
            .handle_mouse(mouse(MouseKind::Up, (50, 50)), &mut out)
            .unwrap();
        assert!(
            matches!(out.as_slice(), [EngineEvent::Click { node, .. }] if *node == fixture.popup)
        );
        out.clear();
        pump_past_focus_delay(engine, &mut out);
        assert_no_clicks(&out);
        engine
            .handle_mouse(mouse(MouseKind::Down, (10, 10)), &mut out)
            .unwrap();
        assert!(
            matches!(out.as_slice(), [EngineEvent::ClickOutside { node, .. }] if *node == fixture.popup)
        );
        engine
            .handle_mouse(mouse(MouseKind::Up, (10, 10)), &mut out)
            .unwrap();
        assert!(
            matches!(out.as_slice(), [EngineEvent::ClickOutside { node, .. }, EngineEvent::Click { node: backdrop, .. }]
            if *node == fixture.popup && *backdrop == fixture.backdrop)
        );
    }

    #[test]
    fn mouse_activity_still_drives_wheel_and_pinch_hover_fallback() {
        let mut fixture = TestEngine::new(true);
        let engine = &mut fixture.engine;
        let mut out = Vec::new();
        for kind in [
            MouseKind::Move,
            MouseKind::Down,
            MouseKind::Up,
            MouseKind::ScrollDown,
        ] {
            let before = Instant::now();
            engine
                .handle_mouse(mouse(kind, (50, 50)), &mut out)
                .unwrap();
            let activity = engine
                .last_pointer_activity
                .expect("mouse activity was not recorded");
            assert!(activity >= before && activity <= Instant::now());
            assert_eq!(engine.cursor, Some((50.0, 50.0)));
        }
        assert!(out.iter().any(|event| matches!(event,
            EngineEvent::Wheel { node, precise: false, delta_y, .. } if *node == fixture.popup && *delta_y == 16.0
        )));
        for recent in [true, false] {
            if !recent {
                engine.last_pointer_activity = Some(Instant::now() - Duration::from_secs(2));
            }
            engine.pairing.ingest(
                vec![crate::native::NativeEvent::Zoom {
                    magnification: 0.1,
                    point: None,
                }],
                1.0,
                Instant::now(),
                &mut engine.hover_oracle,
                (320.0, 240.0),
                (8.0, 16.0),
            );
            out.clear();
            engine.drain_native(&mut out);
            assert_eq!(
                out.iter().any(|event| matches!(event,
                    EngineEvent::Wheel { node, precise: true, mods, delta_y, .. }
                        if *node == fixture.popup && mods.ctrl && *delta_y < 0.0
                )),
                recent,
                "pinch hover fallback: {out:?}"
            );
        }
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

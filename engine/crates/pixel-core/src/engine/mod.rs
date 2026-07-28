mod clipboard;
mod compositor;
mod doc;
mod embed;
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
use native_pairing::NativePairing;
use pointer::DragTarget;

pub use overlay::HighlightArea;

use crate::canvas::Canvas;
use crate::logging;
use crate::menu::MenuController;
use crate::native::NativeScroll;
use crate::paint::paint;
use crate::profiler::{ProfileData, Profiler};
use crate::scroll::ScrollProfile;
use crate::scroll::profiles::Smooth;
use crate::style::Color;
use crate::terminal::{
    Event, KeyEvent, Mods, Mouse, MouseButton, MouseKind, Terminal, TerminalColors,
};
use crate::text_input::InputReply;
use crate::throttle::CpuThrottle;
use crate::tree::{NodeId, PxRect};


fn window_from(ws: &crate::terminal::WindowSize, cell: (u32, u32)) -> (u32, u32) {
    let cols = if ws.cols > 0 { ws.cols } else { 80 };
    let rows = if ws.rows > 0 { ws.rows } else { 24 };
    let mut width = cols * cell.0;
    let mut height = rows * cell.1;
    if ws.width_px > 0 {
        width = width.min(ws.width_px / cell.0 * cell.0);
    }
    if ws.height_px > 0 {
        height = height.min(ws.height_px / cell.1 * cell.1);
    }
    (width, height)
}

static DEFAULT_PROFILE: Smooth = Smooth {
    tau: 0.08,
    brake: 0.025,
};

pub struct EngineConfig {
    pub fonts: Vec<fontdue::Font>,
    pub cell_metrics_font: usize,
    pub watch_resize: bool,
    pub tty: Option<String>,
    pub shared_memory_frames: bool,
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
        base_px: f32,
    },
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
    pub comp: Compositor,
    pub fonts: Vec<fontdue::Font>,
    cell_metrics_font: usize,
    pub profiler: Profiler,
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
    last_native_scroll: Option<Instant>,
    pairing: NativePairing,
    pub profile: &'static dyn ScrollProfile,
    default_menu: bool,
    menu: MenuController,
    inspect_mode: bool,
    inspect_view: usize,
    inspect_hover: Option<NodeId>,
    highlight: Option<(usize, NodeId, HighlightArea)>,
    hover_target: Option<(usize, NodeId)>,
    pub emit_logs: bool,
    log_cursor: u64,
    drag: Option<(usize, DragTarget)>,
    pointer_capture: Option<(usize, NodeId)>,
    key_passthrough: bool,
    last_selection: Option<(usize, NodeId, crate::selection::DocPos, crate::selection::DocPos, u32)>,
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
    last_pointer_activity: Option<Instant>,
    next_pasted_mark: u64,
    pending: Vec<EngineEvent>,
    last_step: Instant,
    last_frame: Instant,
    pub stats: FrameStats,
}

impl Engine {
    pub fn new(config: EngineConfig) -> io::Result<Self> {
        assert!(!config.fonts.is_empty());
        let mut term = match &config.tty {
            Some(path) => Terminal::open(path, config.shared_memory_frames)?,
            None => Terminal::new(config.shared_memory_frames)?,
        };
        if config.watch_resize {
            term.watch_resize()?;
        }
        let colors = term.query_colors()?;
        let ws = term.size()?;
        let cell = term.cell_size()?.unwrap_or((16, 32));
        let window = window_from(&ws, cell);
        let base_px = px_for_cell_height(&config.fonts[config.cell_metrics_font], cell.1 as f32);
        let native = NativeScroll::spawn(term.waker().ok());
        let use_native = native.is_some();
        logging::info(
            "engine",
            format!(
                "started {}x{}px, cell {}x{}, base {base_px:.1}px, native scroll {}{}",
                window.0,
                window.1,
                cell.0,
                cell.1,
                use_native,
                if term.is_tmux() {
                    ", tmux passthrough"
                } else {
                    ""
                }
            ),
        );
        Ok(Self {
            term,
            comp: Compositor::new(window),
            fonts: config.fonts,
            cell_metrics_font: config.cell_metrics_font,
            profiler: Profiler::new(),
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
            last_native_scroll: None,
            pairing: NativePairing::new(),
            profile: &DEFAULT_PROFILE,
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
            last_pointer_activity: None,
            next_pasted_mark: 1 << 48,
            pending: Vec::new(),
            last_step: Instant::now(),
            last_frame: Instant::now(),
            stats: FrameStats::default(),
        })
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

    pub fn profiler_toggle(&mut self) -> io::Result<Option<std::path::PathBuf>> {
        if crate::profiler::is_recording() {
            crate::image_cache::emit_pending_waits();
        }
        self.profiler.toggle()
    }


    pub fn profile_start(&mut self) {
        if !crate::profiler::is_recording() {
            logging::info("profiler", "recording started");
            crate::profiler::start();
        }
    }

    pub fn profile_stop(&mut self) {
        if crate::profiler::is_recording() {
            crate::image_cache::emit_pending_waits();
        }
        if let Some(data) = crate::profiler::stop() {
            logging::info(
                "profiler",
                format!("recording stopped, {} spans", data.spans.len()),
            );
            self.pending.push(EngineEvent::Profile(data));
        }
    }

    pub fn set_cpu_throttle(&mut self, rate: f32) {
        if !CpuThrottle::supported() && rate > 1.0 {
            logging::warn("engine", "cpu throttle is only supported on macOS");
            return;
        }
        self.cpu_throttle.set_rate(rate);
        let applied = self.cpu_throttle.rate();
        logging::info("engine", format!("cpu throttle {applied}x"));
        if crate::profiler::is_recording() {
            crate::profiler::mark("throttle", 0, format!("cpu throttle {applied}x"));
        }
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
        self.frame()?;
        let first_wait = if self.animating() {
            Some(Duration::from_millis(6))
        } else if !out.is_empty() {
            Some(Duration::ZERO)
        } else {
            wait
        };
        let first_wait = match self.clipboard.osc_deadline() {
            Some(deadline) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                Some(first_wait.map_or(remaining, |w| w.min(remaining)))
            }
            None => first_wait,
        };
        let first_wait = match &self.focus_click {
            Some((deadline, _)) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                Some(first_wait.map_or(remaining, |w| w.min(remaining)))
            }
            None => first_wait,
        };
        let mut event = self.term.poll_event(first_wait)?;
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
        self.frame()?;
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
        for (view, node, image) in self.clipboard.resolve_pastes(&mut self.term, drained.pastes) {
            let mut out = std::mem::take(&mut self.pending);
            self.push_paste_image(view, node, image, &mut out);
            self.pending = out;
        }
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

    fn check_resize(&mut self, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        let ws = self.term.size()?;
        if ws.cols == 0 && ws.width_px == 0 {
            return Ok(());
        }
        self.apply_window(&ws)?;
        out.append(&mut self.pending);
        Ok(())
    }

    fn apply_window(&mut self, ws: &crate::terminal::WindowSize) -> io::Result<()> {
        let estimate = ws.cell_size();
        if estimate != self.cell_estimate {
            self.cell_estimate = estimate;
            self.term.forget_cell_size();
        }
        let cell = self.term.cell_size()?.unwrap_or(self.cell);
        let window = window_from(ws, cell);
        if window == self.comp.window && cell == self.cell {
            return Ok(());
        }
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
        if crate::profiler::is_recording() {
            crate::profiler::mark(
                "resize",
                0,
                format!(
                    "resize {}x{} cell {}x{}",
                    window.0, window.1, cell.0, cell.1
                ),
            );
        }
        let base_changed = (base_px - self.base_px).abs() > 0.01;
        self.comp.window = window;
        self.cell = cell;
        self.base_px = base_px;
        let resized = self.comp.apply_layout(base_changed);
        self.push_resizes(resized);
        Ok(())
    }

    fn handle_event(&mut self, event: Event, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        match event {
            Event::Key(key) => self.handle_key(key, out)?,
            Event::Paste(text) => {
                if crate::profiler::is_recording() {
                    crate::profiler::mark(
                        "paste",
                        self.active_view as u32,
                        format!("paste ({} chars)", text.chars().count()),
                    );
                }
                if let Some((view, focus)) = self.focused() {
                    if let Some(image) = crate::clipboard_image::image_path_from_paste(&text) {
                        self.push_paste_image(view, focus, image, out);
                    } else {
                        let rich = clipboard::parse_rich_paste(&text);
                        if let Some((_, marks)) = &rich {
                            self.next_pasted_mark += marks.len() as u64;
                        }
                        let first_id = self.next_pasted_mark - rich.as_ref().map_or(0, |(_, m)| m.len() as u64);
                        if let Some(input) = self.comp.views[view].tree.input_mut(focus) {
                            match rich {
                                Some((rich_text, marks)) => {
                                    input.insert_rich(&rich_text, &marks, first_id)
                                }
                                None => input.insert(&text),
                            }
                            self.finish_reply(view, focus, InputReply::Edited, ChangeSource::Paste, out)?;
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
                if !focused {
                    self.focus_click = None;
                } else if gained
                    && let Some(at) = self.last_pointer_activity
                    && at.elapsed() <= Duration::from_millis(1000)
                    && let Some(point) = self.cursor
                {
                    self.focus_click = Some((Instant::now() + Duration::from_millis(75), point));
                }
                out.push(EngineEvent::Focus { focused });
            }
            Event::WindowSize(ws) => self.apply_window(&ws)?,
            Event::Mouse(mouse) => self.handle_mouse(mouse, out)?,
            Event::ClipboardData { items, ok } => {
                self.clipboard.handle_clipboard_data(&mut self.term, items, ok)
            }
        }
        self.emit_selection_change(out);
        Ok(())
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

    fn frame(&mut self) -> io::Result<()> {
        let active = self.comp.active_views();
        let views_dirty = active.iter().any(|&v| self.comp.views[v].tree.dirty());
        if !views_dirty && !self.comp.dirty {
            return Ok(());
        }
        crate::profiler::span("frame", || -> io::Result<()> {
            let start = Instant::now();
            for i in active {
                if !self.comp.views[i].tree.dirty() {
                    continue;
                }
                let size = self.comp.views[i].size;
                if size.0 == 0 || size.1 == 0 {
                    continue;
                }
                crate::profiler::set_view(i as u32);
                let cursor = self
                    .cursor
                    .filter(|&(x, _)| self.comp.view_at(x) == i)
                    .map(|c| self.comp.to_local(i, c));
                let fonts = &self.fonts;
                let base_px = self.base_px;
                let view = &mut self.comp.views[i];
                crate::profiler::span("canvas.clear", || {
                    if (view.canvas.width, view.canvas.height) != size {
                        view.canvas = Canvas::new(size.0, size.1);
                    }
                    view.canvas.fill(view.clear_color);
                });
                view.tree.flush_layout(fonts, base_px);
                paint(&view.tree, &mut view.canvas, fonts, cursor);
                view.tree.clear_paint_flag();
                self.comp.dirty = true;
            }
            crate::profiler::set_view(0);
            if !self.comp.dirty {
                return Ok(());
            }
            self.compose();
            let bytes = crate::profiler::span("draw", || self.term.draw(&self.comp.frame))?;
            crate::profiler::count("bytes", bytes as u64);

            let gap = start.duration_since(self.last_frame).as_secs_f32();
            self.last_frame = start;
            let ema = |old: f32, new: f32| {
                if old == 0.0 {
                    new
                } else {
                    old * 0.9 + new * 0.1
                }
            };
            self.stats.frame_ms = ema(self.stats.frame_ms, start.elapsed().as_secs_f32() * 1000.0);
            if gap < 0.25 {
                self.stats.fps = ema(self.stats.fps, 1.0 / gap);
            }
            Ok(())
        })
    }

    fn compose(&mut self) {
        crate::profiler::span("compose", || {
            self.comp.compose();
            if let Some((view, id, area)) = self.highlight {
                self.draw_node_overlay(view, id, area, false);
            }
            if self.inspect_mode
                && let Some(id) = self.inspect_hover
            {
                self.draw_node_overlay(self.inspect_view, id, HighlightArea::All, true);
            }
        });
        self.comp.dirty = false;
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
    use crate::terminal::WindowSize;

    #[test]
    fn window_clips_padding_remainder_to_grid() {
        let ws = WindowSize {
            cols: 100,
            rows: 40,
            width_px: 1007,
            height_px: 845,
        };
        assert_eq!(window_from(&ws, (10, 20)), (1000, 800));
    }

    #[test]
    fn window_uses_grid_when_pixels_missing() {
        let ws = WindowSize {
            cols: 80,
            rows: 24,
            width_px: 0,
            height_px: 0,
        };
        assert_eq!(window_from(&ws, (16, 32)), (80 * 16, 24 * 32));
    }

    #[test]
    fn window_clamps_when_cell_overestimated() {
        let ws = WindowSize {
            cols: 100,
            rows: 40,
            width_px: 1050,
            height_px: 800,
        };
        assert_eq!(window_from(&ws, (11, 21)), (1045, 798));
    }
}

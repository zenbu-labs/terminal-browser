mod clipboard;
mod compositor;
mod doc;
mod embed;
mod frame;
mod input;
mod keys;
mod overlay;
mod pointer;
mod scroll;

use std::io;
use std::time::{Duration, Instant};

use clipboard::ClipboardFlows;
use compositor::Compositor;
use pointer::DragTarget;

pub use overlay::HighlightArea;

use crate::backend::{Backend, HostColors, Metrics};
use crate::logging;
use crate::menu::MenuController;
use crate::profiler::ProfileData;
use crate::scroll::ScrollProfile;
use crate::style::Color;
use crate::backend::Event;
use crate::input::{KeyEvent, Mods, Mouse, MouseButton, MouseKind};
use crate::text_input::InputReply;
use crate::throttle::CpuThrottle;
use crate::tree::{NodeId, PxRect};



pub struct EngineConfig {
    pub fonts: crate::fonts::FontRegistry,
    pub cell_metrics_font: usize,
    pub backend: Box<dyn Backend>,
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
    Message(serde_json::Value),
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
    Stick {
        view: usize,
        node: NodeId,
        key: Option<String>,
        stuck: bool,
    },
    Resize {
        view: usize,
        width: u32,
        height: u32,
        cell: (u32, u32),
        base_px: f32,
    },
    Colors {
        colors: HostColors,
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
        mods: crate::input::Mods,
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
    pub backend: Box<dyn Backend>,
    pub comp: Compositor,
    pub fonts: crate::fonts::FontRegistry,
    cell_metrics_font: usize,
    pub cell: (u32, u32),
    pub base_px: f32,
    pub colors: HostColors,
    pub device: crate::device::Device,
    cursor: Option<(f32, f32)>,
    hover: Option<(usize, NodeId)>,
    focus_view: usize,
    active_view: usize,
    host_focused: bool,
    pub profile: std::sync::Arc<dyn ScrollProfile>,
    default_menu: bool,
    menu: MenuController,
    inspect_mode: bool,
    inspect_view: usize,
    inspect_hover: Option<NodeId>,
    highlight: Option<(usize, NodeId, HighlightArea)>,
    hover_target: Option<(usize, NodeId)>,
    pointer_shape: Option<String>,
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
    last_pointer_activity: Option<Instant>,
    last_pointer_click: Option<Instant>,
    next_pasted_mark: u64,
    pending: Vec<EngineEvent>,
    last_step: Instant,
    last_frame: Instant,
    last_input: Instant,
    frame_slot: Instant,
    present_after: Duration,
    ready_times: std::collections::VecDeque<Duration>,
    last_frame_bytes: usize,
    frame_deferred: bool,
    max_fps: f32,
    frame_due: Option<Instant>,
    scroll_requests: Vec<(usize, scroll::ScrollRequest, bool)>,
    pub stats: FrameStats,
}

const PRECISE_WAIT_TAIL: Duration = Duration::from_micros(1500);
const PRECISE_WAIT_STEP: Duration = Duration::from_micros(250);
const ROW_CATCH_UP_POLL: Duration = Duration::from_millis(8);
const ROW_CATCH_UP_BUDGET: Duration = Duration::from_millis(4);
const ROW_CATCH_UP_MARGIN: Duration = Duration::from_millis(3);

impl Engine {
    pub fn new(config: EngineConfig) -> io::Result<Self> {
        assert!(!config.fonts.is_empty());
        let max_fps = frame::DEFAULT_MAX_FPS;
        let mut backend = config.backend;
        let info = backend.start()?;
        let Metrics { window, cell } = info.metrics;
        let colors = info.colors;
        let mut fonts = config.fonts;
        fonts.set_text_metrics(info.device.text.clone());
        let base_px = px_for_cell_height(&fonts[config.cell_metrics_font], cell.1 as f32);
        logging::info(
            "engine",
            format!(
                "started {}x{}px, cell {}x{}, base {base_px:.1}px",
                window.0, window.1, cell.0, cell.1
            ),
        );
        let mut engine = Self {
            backend,
            comp: Compositor::new(window),
            fonts,
            cell_metrics_font: config.cell_metrics_font,
            cell,
            base_px,
            colors,
            device: info.device.clone(),
            cursor: None,
            hover: None,
            focus_view: 0,
            active_view: 0,
            host_focused: true,
            profile: info.device.scroll.clone(),
            default_menu: false,
            menu: MenuController::default(),
            inspect_mode: false,
            inspect_view: 0,
            inspect_hover: None,
            highlight: None,
            hover_target: None,
            pointer_shape: None,
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
            last_pointer_activity: None,
            last_pointer_click: None,
            next_pasted_mark: 1 << 48,
            pending: Vec::new(),
            last_step: Instant::now(),
            last_frame: Instant::now(),
            last_input: Instant::now(),
            frame_slot: Instant::now(),
            present_after: frame::PRESENT_AFTER_MAX,
            ready_times: std::collections::VecDeque::new(),
            last_frame_bytes: 0,
            frame_deferred: false,
            max_fps,
            frame_due: None,
            scroll_requests: Vec::new(),
            stats: FrameStats::default(),
        };
        for view in &mut engine.comp.views {
            view.tree.set_lattice(engine.device.lattice);
        }
        Ok(engine)
    }

    pub fn add_font_face(&mut self, family: &str, weight: u16, italic: bool, face: fontdue::Font, source: &str) {
        if !self.fonts.add_face(family, weight, italic, face, source) {
            return;
        }
        for view in &mut self.comp.views {
            view.tree.mark_layout();
        }
    }

    pub fn add_view(&mut self) -> usize {
        let view = self.comp.add_view();
        self.comp.views[view].tree.set_lattice(self.device.lattice);
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
        let fonts = &mut self.fonts;
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

    pub fn blur(&mut self, view: usize, id: NodeId) {
        if self.focused() == Some((view, id)) {
            self.set_focus(view, None);
        }
    }

    fn live_focus(&self) -> Option<(usize, NodeId)> {
        self.focused().filter(|&(view, id)| !self.comp.views[view].tree.inert(id))
    }

    fn paint_then_wait(
        &mut self,
        out_empty: bool,
        wait: Option<Duration>,
    ) -> io::Result<Option<Event>> {
        self.frame()?;
        self.sync_pointer_shape();
        let mut first_wait = if self.frame_deferred && let Some(due) = self.frame_due {
            Some(due.saturating_duration_since(Instant::now()).max(Duration::from_millis(1)))
        } else if self.animating() || self.frame_deferred {
            Some(self.until_next_animation_frame())
        } else if !out_empty {
            Some(Duration::ZERO)
        } else {
            wait
        };
        let deadlines = [
            self.clipboard.typed_paste_deadline(),
            self.focus_click.as_ref().map(|(deadline, _)| *deadline),
            self.backend.deadline(),
        ];
        for deadline in deadlines.into_iter().flatten() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            first_wait = Some(first_wait.map_or(remaining, |w| w.min(remaining)));
        }
        if self.rows_pending() {
            first_wait = Some(first_wait.map_or(ROW_CATCH_UP_POLL, |w| w.min(ROW_CATCH_UP_POLL)));
        }
        match first_wait {
            Some(wait) => self.wait_precisely(wait),
            None => self.backend.poll(None),
        }
    }

    fn wait_precisely(&mut self, wait: Duration) -> io::Result<Option<Event>> {
        let deadline = Instant::now() + wait;
        let coarse_end = deadline - wait.min(PRECISE_WAIT_TAIL);
        if let Some(event) = self.backend.poll(Some(coarse_end.saturating_duration_since(Instant::now())))? {
            return Ok(Some(event));
        }
        if Instant::now() + PRECISE_WAIT_STEP < coarse_end {
            return Ok(None);
        }
        while let Some(left) = deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()) {
            if let Some(event) = self.backend.poll(Some(Duration::ZERO))? {
                return Ok(Some(event));
            }
            std::thread::sleep(left.min(PRECISE_WAIT_STEP));
        }
        Ok(None)
    }

    pub fn pump(&mut self, wait: Option<Duration>) -> io::Result<Vec<EngineEvent>> {
        if !self.throttle_registered {
            self.throttle_registered = true;
            self.cpu_throttle.register_current_thread();
            crate::throttle::prefer_current_thread();
            if let Ok(waker) = self.backend.waker() {
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
        self.poll_metrics(&mut out)?;
        let mut event = self.backend.poll(Some(Duration::ZERO))?;
        let input_pending = event.is_some();
        if !input_pending {
            event = self.paint_then_wait(out.is_empty(), wait)?;
        }
        while let Some(current) = event {
            self.handle_event(current, &mut out)?;
            event = self.backend.poll(Some(Duration::ZERO))?;
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
        self.poll_metrics(&mut out)?;
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
        if !input_pending || self.frame_slot.elapsed() >= self.paint_interval_with_input_pending() {
            self.frame()?;
        }
        if self.rows_pending() {
            self.catch_up_rows(input_pending || self.animating());
        }
        self.give_spare_time(input_pending || self.animating());
        self.sync_pointer_shape();
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
            .resolve_pastes(self.backend.as_mut(), drained.pastes)
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

    fn apply_colors(&mut self, colors: HostColors, out: &mut Vec<EngineEvent>) {
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

    fn apply_device(&mut self, device: crate::device::Device) {
        if device == self.device {
            return;
        }
        logging::info("engine", format!("device {} lattice {:?}", device.name, device.lattice));
        self.fonts.set_text_metrics(device.text.clone());
        self.profile = device.scroll.clone();
        for view in &mut self.comp.views {
            view.tree.set_lattice(device.lattice);
            view.tree.mark_layout();
        }
        self.device = device;
        self.comp.dirty = true;
    }

    fn poll_metrics(&mut self, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        if let Some(metrics) = self.backend.poll_metrics()? {
            self.apply_metrics(metrics);
        }
        out.append(&mut self.pending);
        Ok(())
    }

    fn apply_metrics(&mut self, metrics: Metrics) {
        let Metrics { window, cell } = metrics;
        if window == self.comp.window && cell == self.cell {
            return;
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
        crate::profiler::mark("resize", 0, || {
            format!("resize {}x{} cell {}x{}", window.0, window.1, cell.0, cell.1)
        });
        let base_changed = (base_px - self.base_px).abs() > 0.01;
        self.comp.window = window;
        self.cell = cell;
        self.base_px = base_px;
        let resized = self.comp.apply_layout(base_changed);
        self.push_resizes(resized);
    }
    pub fn host_changed(&mut self) -> io::Result<()> {
        self.pointer_shape = None;
        let mut out = Vec::new();
        while let Some(event) = self.backend.poll(Some(Duration::ZERO))? {
            self.handle_event(event, &mut out)?;
        }
        self.pending.append(&mut out);
        self.comp.dirty = true;
        Ok(())
    }

    fn handle_event(&mut self, event: Event, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        if matches!(event, Event::Key(_) | Event::Mouse(_) | Event::Paste(_) | Event::Wheel { .. }) {
            self.last_input = Instant::now();
        }
        match event {
            Event::Closed => out.push(EngineEvent::HostClosed),
            Event::Message(message) => out.push(EngineEvent::Message(message)),
            Event::Wheel { at, steps, mods } => self.wheel_steps(at, &steps, mods, out),
            Event::Pinch { at, magnification } => self.pinch(at, magnification, out),
            Event::Resize(metrics) => self.apply_metrics(metrics),
            Event::Redraw => self.comp.dirty = true,
            Event::Key(key) => crate::profiler::span("input.key", || self.handle_key(key, out))?,
            Event::Paste(text) => {
                crate::profiler::mark("paste", self.active_view as u32, || {
                    format!("paste ({} chars)", text.chars().count())
                });
                if let Some((view, focus)) = self.live_focus() {
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
                let gained = focused && !self.host_focused;
                self.host_focused = focused;
                if !focused {
                    self.focus_click = None;
                } else if gained
                    && let Some(at) = self.last_pointer_activity
                    && at.elapsed() <= Duration::from_millis(1000)
                    && self
                        .last_pointer_click
                        .is_none_or(|click| click.elapsed() > Duration::from_millis(1000))
                    && let Some(point) = self.cursor
                {
                    self.focus_click = Some((Instant::now() + Duration::from_millis(75), point));
                }
                out.push(EngineEvent::Focus { focused });
            }
            Event::Mouse(mouse) => crate::profiler::span("input.mouse", || self.handle_mouse(mouse, out))?,
            Event::ClipboardData { items, ok } => {
                self.clipboard
                    .handle_clipboard_data(self.backend.as_mut(), items, ok)
            }
            Event::Colors(colors) => self.apply_colors(colors, out),
            Event::Device(device) => self.apply_device(device),
            Event::Visible(visible) => out.push(EngineEvent::Visible { visible }),
        }
        self.emit_selection_change(out);
        Ok(())
    }

    pub fn set_clipboard(&mut self, text: &str) {
        if let Err(error) = self.backend.write_clipboard(text) {
            logging::warn("engine", format!("clipboard write failed: {error}"));
        }
    }

    pub fn set_title(&mut self, text: &str) {
        if let Err(error) = self.backend.set_title(text) {
            logging::warn("engine", format!("title write failed: {error}"));
        }
    }

    pub fn request_clipboard_image(&mut self, view: usize) {
        let root = self.comp.views[view].tree.root();
        self.clipboard.request_paste(self.backend.as_ref(), view, root);
    }

    fn begin_rich_capture(
        &mut self,
        view: usize,
        text: String,
        marks: Vec<(NodeId, crate::text_input::Mark)>,
    ) -> io::Result<()> {
        let event = self
            .clipboard
            .begin_rich_capture(self.backend.as_mut(), view, text, marks)?;
        self.pending.extend(event);
        Ok(())
    }

    pub fn attach_rich_clipboard(&mut self, token: u64, marks: Vec<(usize, String)>) {
        self.clipboard.attach_rich(self.backend.as_mut(), token, marks);
    }

}


pub fn px_for_cell_height(font: &crate::fonts::Font, cell_height: f32) -> f32 {
    let probe = font
        .primary()
        .horizontal_line_metrics(100.0)
        .expect("font has horizontal metrics");
    (cell_height * 100.0 / probe.new_line_size).clamp(6.0, 512.0)
}

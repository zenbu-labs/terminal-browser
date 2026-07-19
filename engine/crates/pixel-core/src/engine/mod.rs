mod compositor;

use std::io;
use std::time::{Duration, Instant};

use compositor::Compositor;

use crate::canvas::{Canvas, measure_text};
use crate::logging;
use crate::menu::{MenuClick, MenuController};
use crate::native::{NativeDelta, NativeScroll};
use crate::paint::paint;
use crate::profiler::{ProfileData, Profiler};
use crate::scroll::ScrollProfile;
use crate::scroll::profiles::Smooth;
use crate::selection::DocSelection;
use crate::style::{Color, Edges};
use crate::terminal::{
    Event, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind, Terminal, TerminalColors,
    Waker,
};
use crate::text_input::{Granularity, InputAction, InputReply};
use crate::throttle::CpuThrottle;
use crate::tree::{HitTarget, NodeId, PxRect, Tree};

const FALLBACK_CELL: (u32, u32) = (16, 32);
const FRAME_POLL: Duration = Duration::from_millis(6);
/// how recent pointer activity must be for a focus-in to count as a click
const FOCUS_CLICK_HOVER_WINDOW: Duration = Duration::from_millis(1000);
/// how long an unpaired native scroll gesture may wait for its SGR wheel tick
const NATIVE_PAIR_WINDOW: Duration = Duration::from_millis(250);
/// how recent pointer activity must be for a pinch to count as ours
const PINCH_HOVER_WINDOW: Duration = Duration::from_millis(2000);

#[derive(Clone, Copy, PartialEq)]
enum NativeGesture {
    Idle,
    /// deltas buffering while the terminal has yet to confirm hover
    Undecided { since: Instant },
    Paired,
    Dropped,
}
/// how long after focus-in to wait for the host to forward a real click
const FOCUS_CLICK_GRACE: Duration = Duration::from_millis(75);
// Maps NSEvent.magnification to wheel deltaY so a full pinch (~±1.5 summed)
// lands near the deltas a fast ctrl+scroll would produce.
// so an app computing zoom' = zoom * (1 - deltaY/100) applies pinch as 1 + magnification
const PINCH_WHEEL_SCALE: f32 = 100.0;

/**
 * meh this is not great, the mime type we prefer in the clipboard
 */
const PASTE_IMAGE_MIMES: [(&str, &str); 4] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];

struct OscPaste {
    view: usize,
    node: NodeId,
    stage: OscPasteStage,
    deadline: Instant,
}

enum OscPasteStage {
    Types,
    Data { ext: &'static str },
}

struct RichClip {
    token: u64,
    text: String,
    slots: Vec<RichSlot>,
}

pub const MARK_TOKEN_OPEN: char = '⟦';
pub const MARK_TOKEN_CLOSE: char = '⟧';

fn enrich_clipboard_text(text: &str, slots: &[RichSlot]) -> Option<String> {
    if !slots.iter().any(|s| s.data.is_some()) {
        return None;
    }
    let mut out = String::with_capacity(text.len() * 2);
    for (i, ch) in text.char_indices() {
        if ch == crate::text_input::MARK_CHAR {
            let data = slots
                .iter()
                .find(|s| s.offset == i)
                .and_then(|s| s.data.as_deref());
            if let Some(data) = data {
                out.push(MARK_TOKEN_OPEN);
                out.push_str(data);
                out.push(MARK_TOKEN_CLOSE);
            }
        } else {
            out.push(ch);
        }
    }
    Some(out)
}

fn parse_rich_paste(text: &str) -> Option<(String, Vec<(usize, String)>)> {
    if !text.contains(MARK_TOKEN_OPEN) {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut marks = Vec::new();
    let mut rest = text;
    loop {
        let Some(open) = rest.find(MARK_TOKEN_OPEN) else {
            out.push_str(rest);
            break;
        };
        let after = &rest[open + MARK_TOKEN_OPEN.len_utf8()..];
        let Some(close) = after.find(MARK_TOKEN_CLOSE) else {
            out.push_str(&rest[..open + MARK_TOKEN_OPEN.len_utf8()]);
            rest = after;
            continue;
        };
        out.push_str(&rest[..open]);
        marks.push((out.len(), after[..close].to_string()));
        out.push(crate::text_input::MARK_CHAR);
        rest = &after[close + MARK_TOKEN_CLOSE.len_utf8()..];
    }
    (!marks.is_empty()).then_some((out, marks))
}

struct RichSlot {
    offset: usize,
    data: Option<String>,
}

const CONTENT_FILL: Color = [111, 168, 220, 150];
const PADDING_FILL: Color = [147, 196, 125, 140];
const BORDER_FILL: Color = [255, 229, 153, 150];
const MARGIN_FILL: Color = [246, 178, 107, 150];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HighlightArea {
    #[default]
    All,
    Content,
    Padding,
    Border,
    Margin,
}

fn key_label(key: &KeyEvent) -> String {
    let mut label = String::from("key ");
    if key.mods.ctrl {
        label.push_str("ctrl+");
    }
    if key.mods.alt {
        label.push_str("alt+");
    }
    if key.mods.sup {
        label.push_str("cmd+");
    }
    let name = match key.key {
        crate::terminal::Key::Char(c) => {
            if key.mods.shift {
                label.push_str("shift+");
            }
            label.push(c);
            return label;
        }
        crate::terminal::Key::Up => "up",
        crate::terminal::Key::Down => "down",
        crate::terminal::Key::Left => "left",
        crate::terminal::Key::Right => "right",
        crate::terminal::Key::Home => "home",
        crate::terminal::Key::End => "end",
        crate::terminal::Key::Insert => "insert",
        crate::terminal::Key::PageUp => "pageup",
        crate::terminal::Key::PageDown => "pagedown",
        crate::terminal::Key::Function(number) => {
            label.push('f');
            label.push_str(&number.to_string());
            return label;
        }
        crate::terminal::Key::LeftShift => "leftshift",
        crate::terminal::Key::LeftControl => "leftcontrol",
        crate::terminal::Key::LeftAlt => "leftalt",
        crate::terminal::Key::LeftSuper => "leftsuper",
        crate::terminal::Key::RightShift => "rightshift",
        crate::terminal::Key::RightControl => "rightcontrol",
        crate::terminal::Key::RightAlt => "rightalt",
        crate::terminal::Key::RightSuper => "rightsuper",
        crate::terminal::Key::Enter => "enter",
        crate::terminal::Key::Backspace => "backspace",
        crate::terminal::Key::Delete => "delete",
        crate::terminal::Key::Escape => "escape",
        crate::terminal::Key::Tab => "tab",
        crate::terminal::Key::Unknown => "unknown",
    };
    if key.mods.shift {
        label.push_str("shift+");
    }
    label.push_str(name);
    label
}

fn is_plain_enter(key: &KeyEvent) -> bool {
    key.key == crate::terminal::Key::Enter
        && !key.mods.shift
        && !key.mods.ctrl
        && !key.mods.alt
        && !key.mods.sup
}

fn capture_matches(name: &str, key: &KeyEvent) -> bool {
    use crate::terminal::Key;
    if key.mods.shift || key.mods.alt || key.mods.ctrl || key.mods.sup {
        return false;
    }
    match key.key {
        Key::Char(c) => name.chars().eq(std::iter::once(c)),
        Key::Up => name == "up",
        Key::Down => name == "down",
        Key::Left => name == "left",
        Key::Right => name == "right",
        Key::Home => name == "home",
        Key::End => name == "end",
        Key::Insert => name == "insert",
        Key::PageUp => name == "pageup",
        Key::PageDown => name == "pagedown",
        Key::Function(number) => name == format!("f{number}"),
        Key::LeftShift => name == "leftshift",
        Key::LeftControl => name == "leftcontrol",
        Key::LeftAlt => name == "leftalt",
        Key::LeftSuper => name == "leftsuper",
        Key::RightShift => name == "rightshift",
        Key::RightControl => name == "rightcontrol",
        Key::RightAlt => name == "rightalt",
        Key::RightSuper => name == "rightsuper",
        Key::Enter => name == "enter",
        Key::Backspace => name == "backspace",
        Key::Delete => name == "delete",
        Key::Escape => name == "escape",
        Key::Tab => name == "tab",
        Key::Unknown => false,
    }
}

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
    /// drive this tty instead of the process's stdio (daemon panes)
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
    Click {
        view: usize,
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
        // byte offset into the node's text at the click point, when it has text
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DragTarget {
    Input(NodeId),
    Text,
    Node(NodeId),
}

pub struct Engine {
    term: Terminal,
    comp: Compositor,
    fonts: Vec<fontdue::Font>,
    cell_metrics_font: usize,
    profiler: Profiler,
    cell: (u32, u32),
    cell_estimate: Option<(u32, u32)>,
    base_px: f32,
    colors: TerminalColors,
    cursor: Option<(f32, f32)>,
    hover: Option<(usize, NodeId)>,
    focus_view: usize,
    active_view: usize,
    term_focused: bool,
    native: Option<NativeScroll>,
    use_native: bool,
    // When the helper last delivered a scroll. SGR wheel ticks are only
    // suppressed while the helper is demonstrably alive, so a broken helper
    // (permissions, crash) degrades to tick-based scrolling instead of none.
    last_native_scroll: Option<Instant>,
    // Native scroll pairing: the helper reports every scroll in the system,
    // but the terminal routes SGR wheel ticks by hover — so a tick on our tty
    // proves the gesture is ours. Deltas buffer until the pairing tick
    // arrives; a gesture that never pairs is someone else's and is dropped.
    native_gesture: NativeGesture,
    native_buffer: Vec<(f32, f32)>,
    native_ready: Vec<(f32, f32)>,
    pending_zoom: f32,
    // When the terminal last reported a wheel tick at us. The terminal only
    // sends these while the pointer is over our pane, so this lets native
    // deltas through for an unfocused pane without reacting to scrolls that
    // belong to other panes or apps.
    last_term_wheel: Option<Instant>,
    profile: &'static dyn ScrollProfile,
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
    pointer_capture: Option<(usize, NodeId)>,
    key_passthrough: bool,
    last_selection: Option<(usize, NodeId, crate::selection::DocPos, crate::selection::DocPos, u32)>,
    bar_hover: Option<(usize, NodeId)>,
    bar_drag: Option<(usize, NodeId, f32)>,
    reveal: bool,
    key_capture: Vec<String>,
    cpu_throttle: CpuThrottle,
    throttle_registered: bool,
    scroll_burst: u32,
    last_scroll_mark: Option<Instant>,
    pending_pastes: Vec<(u64, usize, NodeId)>,
    osc_paste: Option<OscPaste>,
    /// synthetic click scheduled by a focus-in that arrived while the pointer
    /// was over us: terminals consume the click that focuses an unfocused
    /// split, so the app would otherwise need a second click
    focus_click: Option<(Instant, (f32, f32))>,
    last_pointer_activity: Option<Instant>,
    rich_clipboard: Option<RichClip>,
    rich_token: u64,
    next_pasted_mark: u64,
    pending: Vec<EngineEvent>,
    last_step: Instant,
    last_frame: Instant,
    stats: FrameStats,
}

impl Engine {
    pub fn new(config: EngineConfig) -> io::Result<Self> {
        assert!(!config.fonts.is_empty());
        let mut term = match &config.tty {
            Some(path) => Terminal::open(path)?,
            None => Terminal::new()?,
        };
        if config.watch_resize {
            term.watch_resize()?;
        }
        let colors = term.query_colors()?;
        let ws = term.size()?;
        let cell = term.cell_size()?.unwrap_or(FALLBACK_CELL);
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
            native_gesture: NativeGesture::Idle,
            native_buffer: Vec::new(),
            native_ready: Vec::new(),
            pending_zoom: 1.0,
            last_term_wheel: None,
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
            pending_pastes: Vec::new(),
            osc_paste: None,
            focus_click: None,
            last_pointer_activity: None,
            rich_clipboard: None,
            rich_token: 0,
            next_pasted_mark: 1 << 48,
            pending: Vec::new(),
            last_step: Instant::now(),
            last_frame: Instant::now(),
            stats: FrameStats::default(),
        })
    }

    pub fn tree(&self) -> &Tree {
        &self.comp.views[0].tree
    }

    pub fn tree_mut(&mut self) -> &mut Tree {
        &mut self.comp.views[0].tree
    }

    pub fn view_tree(&self, view: usize) -> Option<&Tree> {
        self.comp.views.get(view).map(|v| &v.tree)
    }

    pub fn view_tree_mut(&mut self, view: usize) -> Option<&mut Tree> {
        self.comp.views.get_mut(view).map(|v| &mut v.tree)
    }

    pub fn view_count(&self) -> usize {
        self.comp.views.len()
    }

    pub fn view_size(&self, view: usize) -> (u32, u32) {
        self.comp.views.get(view).map_or((0, 0), |v| v.size)
    }

    pub fn window_px(&self) -> (u32, u32) {
        self.comp.window
    }

    pub fn cell_px(&self) -> (u32, u32) {
        self.cell
    }

    pub fn base_px(&self) -> f32 {
        self.base_px
    }

    pub fn colors(&self) -> &TerminalColors {
        &self.colors
    }

    pub fn stats(&self) -> FrameStats {
        self.stats
    }

    pub fn fonts(&self) -> &[fontdue::Font] {
        &self.fonts
    }

    pub fn add_font(&mut self, font: fontdue::Font) -> usize {
        self.fonts.push(font);
        self.fonts.len() - 1
    }

    pub fn cursor(&self) -> Option<(f32, f32)> {
        self.cursor
    }

    pub fn split(&self) -> Option<f32> {
        self.comp.split()
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

    pub fn set_emit_logs(&mut self, enabled: bool) {
        self.emit_logs = enabled;
    }

    pub fn set_inspect_mode(&mut self, enabled: bool) {
        if self.inspect_mode != enabled {
            self.inspect_mode = enabled;
            self.inspect_hover = None;
            self.comp.dirty = true;
        }
    }

    pub fn inspect_mode(&self) -> bool {
        self.inspect_mode
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
            match self.comp.split() {
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

    pub fn set_scroll_profile(&mut self, profile: &'static dyn ScrollProfile) {
        self.profile = profile;
    }

    pub fn native_scroll_available(&self) -> bool {
        self.native.is_some()
    }

    pub fn native_scroll_active(&self) -> bool {
        self.use_native
            && self.native.is_some()
            && self
                .last_native_scroll
                .is_some_and(|at| at.elapsed() < Duration::from_millis(1500))
    }

    pub fn set_native_scroll(&mut self, enabled: bool) {
        self.use_native = enabled;
    }

    pub fn waker(&mut self) -> io::Result<Waker> {
        self.term.waker()
    }

    pub fn set_key_event_types(&mut self, enabled: bool) -> io::Result<()> {
        self.term.set_key_event_types(enabled)
    }

    pub fn profiler_toggle(&mut self) -> io::Result<Option<std::path::PathBuf>> {
        if crate::profiler::is_recording() {
            crate::image_cache::emit_pending_waits();
        }
        self.profiler.toggle()
    }

    pub fn profiler_recording(&self) -> bool {
        self.profiler.is_recording()
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

    pub fn cpu_throttle(&self) -> &CpuThrottle {
        &self.cpu_throttle
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

    pub fn set_clipboard(&mut self, text: &str) -> io::Result<()> {
        self.term.set_clipboard(text)
    }

    pub fn set_pointer_shape(&mut self, shape: &str) -> io::Result<()> {
        self.term.set_pointer_shape(shape)
    }

    pub fn draw_surface(
        &mut self,
        surface: u32,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> io::Result<usize> {
        if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "surface dimensions do not match its pixels",
            ));
        }
        crate::surfaces::set(surface, width, height, rgba);
        self.mark_surface_views(surface);
        Ok(rgba.len())
    }

    pub fn delete_surface(&mut self, surface: u32) -> io::Result<()> {
        crate::surfaces::remove(surface);
        self.mark_surface_views(surface);
        Ok(())
    }

    fn mark_surface_views(&mut self, surface: u32) {
        for view in self.comp.active_views() {
            let tree = &mut self.comp.views[view].tree;
            if tree.uses_surface(surface) {
                tree.mark_paint();
            }
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

    pub fn set_key_capture(&mut self, keys: Vec<String>) {
        self.key_capture = keys;
    }

    pub fn splice_input(&mut self, view: usize, id: NodeId, start: usize, end: usize, text: &str) {
        fn char_floor(text: &str, mut at: usize) -> usize {
            while at > 0 && !text.is_char_boundary(at) {
                at -= 1;
            }
            at
        }
        {
            let Some(input) = self.comp.views[view].tree.input_mut(id) else {
                return;
            };
            let len = input.text().len();
            let start = char_floor(input.text(), start.min(len));
            let end = char_floor(input.text(), end.min(len)).max(start);
            input.set_cursor(start, false);
            if end > start {
                input.set_cursor(end, true);
            }
            input.insert(text);
        }
        self.comp.views[view].tree.sync_input_text(id);
        self.reveal = true;
        let mut events = Vec::new();
        self.push_change(view, id, ChangeSource::Edit, &mut events);
        self.pending.append(&mut events);
    }

    pub fn select_all_input(&mut self, view: usize, id: NodeId) {
        let Some(input) = self.comp.views[view].tree.input_mut(id) else {
            return;
        };
        input.select_all();
        self.comp.views[view].tree.mark_paint();
        let mut events = Vec::new();
        self.push_caret(view, id, &mut events);
        self.pending.append(&mut events);
    }

    pub fn apply_input_action(
        &mut self,
        action: InputAction,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let Some((view, focus)) = self.focused() else {
            return self.apply_doc_action(action);
        };
        let Some(input) = self.comp.views[view].tree.input_mut(focus) else {
            return Ok(());
        };
        let reply = input.apply(action);
        if reply == InputReply::None {
            return self.apply_doc_action(action);
        }
        self.finish_reply(view, focus, reply, ChangeSource::Edit, out)
    }

    fn apply_doc_action(&mut self, action: InputAction) -> io::Result<()> {
        let view = self.active_view;
        match action {
            InputAction::Copy => {
                if let Some(text) = self.comp.views[view].tree.doc_selected_text() {
                    self.term.set_clipboard(&text)?;
                }
            }
            InputAction::SelectAll => {
                self.comp.views[view].tree.doc_select_all();
            }
            _ => {}
        }
        Ok(())
    }

    pub fn pump(&mut self, wait: Option<Duration>) -> io::Result<Vec<EngineEvent>> {
        if !self.throttle_registered {
            self.throttle_registered = true;
            self.cpu_throttle.register_current_thread();
            if let Ok(waker) = self.waker() {
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
            Some(FRAME_POLL)
        } else if !out.is_empty() {
            Some(Duration::ZERO)
        } else {
            wait
        };
        let first_wait = match &self.osc_paste {
            Some(paste) => {
                let remaining = paste.deadline.saturating_duration_since(Instant::now());
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
        for (seq, pasted) in drained.pastes {
            let Some(i) = self.pending_pastes.iter().position(|(s, ..)| *s == seq) else {
                continue;
            };
            let (_, view, node) = self.pending_pastes.remove(i);
            match pasted {
                Some(image) => {
                    let mut out = std::mem::take(&mut self.pending);
                    self.push_paste_image(view, node, image, &mut out);
                    self.pending = out;
                }
                None => {
                    if self.osc_paste.is_none()
                        && self.term.clipboard_data_supported()
                        && self.term.request_clipboard_types().is_ok()
                    {
                        self.osc_paste = Some(OscPaste {
                            view,
                            node,
                            stage: OscPasteStage::Types,
                            deadline: Instant::now() + Duration::from_secs(3),
                        });
                    } else {
                        self.request_text_clipboard();
                    }
                }
            }
        }
        if let Some(paste) = &self.osc_paste
            && Instant::now() > paste.deadline
        {
            self.osc_paste = None;
            self.request_text_clipboard();
        }
    }

    fn request_text_clipboard(&mut self) {
        if let Err(error) = self.term.request_clipboard() {
            logging::warn("engine", format!("clipboard request failed: {error}"));
        }
    }

    fn handle_clipboard_data(&mut self, items: Vec<(String, Vec<u8>)>, ok: bool) {
        let Some(paste) = self.osc_paste.take() else {
            return;
        };
        if !ok {
            self.request_text_clipboard();
            return;
        }
        match paste.stage {
            OscPasteStage::Types => {
                let offered = items
                    .iter()
                    .find(|(mime, _)| mime == "." || mime.is_empty())
                    .map(|(_, data)| String::from_utf8_lossy(data).into_owned())
                    .unwrap_or_default();
                let pick = PASTE_IMAGE_MIMES
                    .iter()
                    .find(|(mime, _)| offered.split_whitespace().any(|o| o == *mime));
                match pick {
                    Some(&(mime, ext)) if self.term.request_clipboard_data(mime).is_ok() => {
                        self.osc_paste = Some(OscPaste {
                            stage: OscPasteStage::Data { ext },
                            deadline: Instant::now() + Duration::from_secs(20),
                            ..paste
                        });
                    }
                    _ => self.request_text_clipboard(),
                }
            }
            OscPasteStage::Data { ext } => {
                let data = items
                    .into_iter()
                    .find(|(mime, data)| mime.starts_with("image/") && !data.is_empty())
                    .map(|(_, data)| data);
                match data {
                    Some(data) => {
                        let seq = crate::image_cache::queue_pasted_bytes(data, ext);
                        self.pending_pastes.push((seq, paste.view, paste.node));
                    }
                    None => self.request_text_clipboard(),
                }
            }
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

    fn animating(&self) -> bool {
        let scrolling = self.comp.active_views().into_iter().any(|view| {
            let tree = &self.comp.views[view].tree;
            tree.scroll_nodes()
                .iter()
                .any(|&id| tree.scroll_state(id).is_some_and(|s| !s.settled()))
        });
        scrolling || self.bars_animating()
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
                        let rich = self.rich_paste_payload(&text);
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
                } else if let Some(image) = crate::clipboard_image::image_path_from_paste(&text) {
                    // No focused input: hand the image to the app at the view
                    // root so canvas-style apps can receive pastes.
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
                // clicking an unfocused split focuses it but the terminal
                // consumes that click (ghostty suppresses the release too), so
                // a focus-in right after pointer activity means the user
                // clicked us and lost the click. Schedule a synthetic one; a
                // real press/release in the grace window cancels it for hosts
                // that do forward the click.
                if !focused {
                    self.focus_click = None;
                } else if gained
                    && let Some(at) = self.last_pointer_activity
                    && at.elapsed() <= FOCUS_CLICK_HOVER_WINDOW
                    && let Some(point) = self.cursor
                {
                    self.focus_click = Some((Instant::now() + FOCUS_CLICK_GRACE, point));
                }
                out.push(EngineEvent::Focus { focused });
            }
            Event::WindowSize(ws) => self.apply_window(&ws)?,
            Event::Mouse(mouse) => self.handle_mouse(mouse, out)?,
            Event::ClipboardData { items, ok } => self.handle_clipboard_data(items, ok),
        }
        self.emit_selection_change(out);
        Ok(())
    }

    fn emit_selection_change(&mut self, out: &mut Vec<EngineEvent>) {
        let mut current: Option<(usize, NodeId, DocSelection, u32)> = None;
        for view in 0..self.comp.views.len() {
            let tree = &self.comp.views[view].tree;
            let Some(sel) = tree.doc_selection() else {
                continue;
            };
            if sel.is_collapsed() {
                continue;
            }
            let Some(scope) = tree.doc_scope() else {
                continue;
            };
            let scroll = tree.scroll_state(scope).map_or(0, |s| s.position.to_bits());
            current = Some((view, scope, sel, scroll));
            break;
        }
        let sig = current
            .as_ref()
            .map(|&(view, scope, sel, scroll)| (view, scope, sel.anchor, sel.focus, scroll));
        if sig == self.last_selection {
            return;
        }
        if let Some((view, container, ..)) = self.last_selection
            && current.map(|c| (c.0, c.1)) != Some((view, container))
            && view < self.comp.views.len()
            && self.comp.views[view].tree.selection_events(container)
        {
            out.push(EngineEvent::Selection {
                view,
                node: container,
                key: self.comp.views[view]
                    .tree
                    .key_of(container)
                    .map(str::to_string),
                text: String::new(),
                rect: PxRect::ZERO,
                parts: Vec::new(),
            });
        }
        self.last_selection = sig;
        let Some((view, scope, ..)) = current else {
            return;
        };
        let tree = &self.comp.views[view].tree;
        if !tree.selection_events(scope) {
            return;
        }
        let key = tree.key_of(scope).map(str::to_string);
        // a selection scrolled fully out of view has no snapshot; report it
        // as cleared so subscribers don't anchor UI to a stale rect
        let Some(snapshot) = tree.doc_selection_snapshot(&self.fonts) else {
            out.push(EngineEvent::Selection {
                view,
                node: scope,
                key,
                text: String::new(),
                rect: PxRect::ZERO,
                parts: Vec::new(),
            });
            return;
        };
        let origin = tree.rect(scope).unwrap_or(PxRect::ZERO);
        out.push(EngineEvent::Selection {
            view,
            node: scope,
            key,
            text: snapshot.text,
            rect: PxRect {
                x: snapshot.rect.x - origin.x,
                y: snapshot.rect.y - origin.y,
                w: snapshot.rect.w,
                h: snapshot.rect.h,
            },
            parts: snapshot
                .parts
                .into_iter()
                .map(|(key, range)| (key, range.start, range.end))
                .collect(),
        });
    }

    fn handle_key(&mut self, key: KeyEvent, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        if crate::profiler::is_recording() {
            crate::profiler::mark("key", self.active_view as u32, key_label(&key));
        }
        if self.key_passthrough {
            out.push(EngineEvent::Key {
                view: self.active_view,
                event: key,
            });
            return Ok(());
        }
        if key.kind == KeyKind::Release {
            out.push(EngineEvent::Key {
                view: self.active_view,
                event: key,
            });
            return Ok(());
        }
        if key.key == crate::terminal::Key::Escape {
            if self.menu.is_open() {
                self.close_menu();
                return Ok(());
            }
            if self.inspect_mode {
                self.set_inspect_mode(false);
                return Ok(());
            }
        }
        if self.key_capture.iter().any(|name| capture_matches(name, &key)) {
            out.push(EngineEvent::Key {
                view: self.active_view,
                event: key,
            });
            return Ok(());
        }
        let focused = self.focused().and_then(|(view, id)| {
            self.comp.views[view]
                .tree
                .input_meta(id)
                .map(|(resolved, submit)| (view, id, resolved, submit))
        });
        match focused {
            Some((view, focus, _, true)) if is_plain_enter(&key) => {
                self.submit_input(view, focus, out)?;
            }
            Some((view, focus, resolved, _)) => {
                let wrap = self.comp.views[view]
                    .tree
                    .input_geometry(focus)
                    .and_then(|g| g.max_width);
                let font = &self.fonts[resolved.font.min(self.fonts.len() - 1)];
                let input = self.comp.views[view]
                    .tree
                    .input_mut(focus)
                    .expect("checked above");
                let typed = (key.text.is_some()
                    || matches!(key.key, crate::terminal::Key::Char(_)))
                    && !key.mods.ctrl
                    && !key.mods.sup
                    && !key.mods.alt;
                let source = if typed {
                    ChangeSource::Type
                } else {
                    ChangeSource::Edit
                };
                let reply = input.handle_key(key.clone(), font, resolved.px, wrap);

                if reply == InputReply::None {
                    if !self.handle_doc_key(&key)? {
                        out.push(EngineEvent::Key {
                            view: self.active_view,
                            event: key,
                        });
                    }
                } else {
                    self.finish_reply(view, focus, reply, source, out)?;
                }
            }
            None => {
                if !self.handle_doc_key(&key)? {
                    out.push(EngineEvent::Key {
                        view: self.active_view,
                        event: key,
                    });
                }
            }
        }
        Ok(())
    }

    fn handle_doc_key(&mut self, key: &KeyEvent) -> io::Result<bool> {
        use Granularity::{Char, Line, Word};
        let view = self.active_view;
        let m = key.mods;
        let combo = m.ctrl || m.sup;
        let horizontal = if m.alt {
            Word
        } else if m.sup {
            Line
        } else {
            Char
        };
        let handled = match key.key {
            crate::terminal::Key::Char('c') if combo => {
                match self.comp.views[view].tree.doc_selected_rich() {
                    Some(rich) => {
                        let marks = rich
                            .marks
                            .into_iter()
                            .map(|(node, id, offset, data)| {
                                (
                                    node,
                                    crate::text_input::Mark {
                                        id,
                                        offset,
                                        advance: 0.0,
                                        data,
                                    },
                                )
                            })
                            .collect();
                        self.begin_rich_capture(view, rich.text, marks)?;
                        true
                    }
                    None => false,
                }
            }
            crate::terminal::Key::Char('a') if m.sup => self.comp.views[view].tree.doc_select_all(),
            crate::terminal::Key::Escape => self.comp.views[view].tree.doc_collapse(),
            crate::terminal::Key::Left if m.shift => {
                self.comp.views[view].tree.doc_extend(true, horizontal)
            }
            crate::terminal::Key::Right if m.shift => {
                self.comp.views[view].tree.doc_extend(false, horizontal)
            }
            crate::terminal::Key::Home if m.shift => self.comp.views[view].tree.doc_extend(true, Line),
            crate::terminal::Key::End if m.shift => self.comp.views[view].tree.doc_extend(false, Line),
            crate::terminal::Key::Up if m.shift && m.sup => {
                self.comp.views[view].tree.doc_extend_edge(true)
            }
            crate::terminal::Key::Down if m.shift && m.sup => {
                self.comp.views[view].tree.doc_extend_edge(false)
            }
            crate::terminal::Key::Up if m.shift => {
                let fonts = &self.fonts;
                self.comp.views[view].tree.doc_extend_vertical(true, fonts)
            }
            crate::terminal::Key::Down if m.shift => {
                let fonts = &self.fonts;
                self.comp.views[view].tree.doc_extend_vertical(false, fonts)
            }
            _ => false,
        };
        Ok(handled)
    }

    fn clear_doc_selections(&mut self, except: Option<usize>) {
        for (i, v) in self.comp.views.iter_mut().enumerate() {
            if except != Some(i) {
                v.tree.doc_collapse();
            }
        }
    }

    fn begin_text_selection(&mut self, view: usize, local: (f32, f32)) {
        self.clear_doc_selections(Some(view));
        let fonts = &self.fonts;
        if self.comp.views[view].tree.doc_select_down(local, fonts) {
            if let Some((focus_view, _)) = self.focused() {
                self.comp.views[focus_view].tree.set_focus(None);
            }
            self.drag = Some((view, DragTarget::Text));
        } else if self.comp.views[view].tree.doc_select_down_near(local, fonts) {
            self.drag = Some((view, DragTarget::Text));
        } else {
            self.comp.views[view].tree.doc_collapse();
        }
    }

    fn handle_mouse(&mut self, mouse: Mouse, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        let point = (mouse.x as f32, mouse.y as f32);
        self.cursor = Some(point);
        self.last_pointer_activity = Some(Instant::now());
        if matches!(mouse.kind, MouseKind::Down | MouseKind::Up) {
            self.focus_click = None;
        }
        if matches!(
            mouse.kind,
            MouseKind::ScrollUp
                | MouseKind::ScrollDown
                | MouseKind::ScrollLeft
                | MouseKind::ScrollRight
        ) {
            self.last_term_wheel = Some(Instant::now());
            if mouse.mods == Mods::default() && self.use_native && self.native.is_some() {
                self.ingest_native();
                match self.native_gesture {
                    NativeGesture::Undecided { .. } => {
                        // the buffered deltas cover the same finger travel as
                        // this tick, so the tick is signal only — flushing
                        // them scrolls without losing the gesture start
                        self.native_gesture = NativeGesture::Paired;
                        self.native_ready.append(&mut self.native_buffer);
                        return Ok(());
                    }
                    NativeGesture::Paired => return Ok(()),
                    NativeGesture::Dropped => {
                        // gesture was slower than the pair window and its
                        // buffer is gone: let this tick scroll a cell to
                        // cover it, then ride the native stream
                        self.native_gesture = NativeGesture::Paired;
                    }
                    NativeGesture::Idle => {}
                }
            }
        }
        if matches!(mouse.kind, MouseKind::Down | MouseKind::Up | MouseKind::Move)
            && self.forward_pointer(mouse, point, out)
        {
            return Ok(());
        }
        if mouse.kind == MouseKind::Down {
            self.key_passthrough = false;
        }
        match mouse.kind {
            MouseKind::Down if mouse.button == MouseButton::Left => {
                self.mark_pointer("click", point);
                if self.handle_menu_click(point, out)? {
                    return Ok(());
                }
                if self.comp.on_divider(point.0) {
                    if crate::profiler::is_recording() {
                        crate::profiler::mark("drag", 0, "divider drag".into());
                    }
                    self.comp.divider_drag = true;
                    self.comp.dirty = true;
                    return Ok(());
                }
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                self.active_view = view;
                if let Some((focus_view, _)) = self.focused()
                    && focus_view != view
                {
                    self.comp.views[focus_view].tree.set_focus(None);
                }
                if self.inspect_mode && view == self.inspect_view {
                    self.finish_inspect(local, out);
                    return Ok(());
                }
                for node in self.comp.views[view]
                    .tree
                    .outside_click_targets(local.0, local.1)
                {
                    out.push(EngineEvent::ClickOutside {
                        view,
                        node,
                        key: self.comp.views[view].tree.key_of(node).map(str::to_string),
                        x: local.0,
                        y: local.1,
                    });
                }
                if self.begin_bar_drag(view, local) {
                    return Ok(());
                }
                // A clickable or input painted above the drag surface wins the
                // press — e.g. a toolbar floating over a drag-subscribed canvas.
                let drag_node = self.comp.views[view].tree.hit_drag(local.0, local.1).filter(|&id| {
                    let tree = &self.comp.views[view].tree;
                    let drag_order = tree.paint_order_of(id).unwrap_or(0);
                    let covered = match tree.hit_target(local.0, local.1) {
                        Some(HitTarget::Input(t)) | Some(HitTarget::Click(t)) => {
                            tree.paint_order_of(t).unwrap_or(0) > drag_order
                        }
                        _ => false,
                    };
                    !covered
                });
                if let Some(id) = drag_node {
                    self.drag = Some((view, DragTarget::Node(id)));
                    out.push(EngineEvent::Drag {
                        view,
                        node: id,
                        key: self.comp.views[view].tree.key_of(id).map(str::to_string),
                        phase: DragPhase::Start,
                        x: local.0,
                        y: local.1,
                        mods: mouse.mods,
                    });
                    return Ok(());
                }
                let node = match self.comp.views[view].tree.hit_target(local.0, local.1) {
                    Some(HitTarget::Input(id)) => {
                        self.clear_doc_selections(None);
                        self.set_focus(view, Some(id));
                        self.drag = Some((view, DragTarget::Input(id)));
                        self.forward_mouse(view, id, &mouse, out)?;
                        Some(id)
                    }
                    Some(HitTarget::Click(id)) => {
                        self.begin_text_selection(view, local);
                        Some(id)
                    }
                    Some(HitTarget::Text(_)) => {
                        self.begin_text_selection(view, local);
                        None
                    }
                    None => {
                        self.begin_text_selection(view, local);
                        None
                    }
                };
                if let Some(node) = node {
                    out.push(EngineEvent::Click {
                        view,
                        node,
                        key: self.comp.views[view].tree.key_of(node).map(str::to_string),
                        x: local.0,
                        y: local.1,
                        offset: self.comp.views[view]
                            .tree
                            .offset_at_point(node, local, &self.fonts),
                    });
                }
            }
            MouseKind::Down if mouse.button == MouseButton::Right => {
                self.mark_pointer("right-click", point);
                self.close_menu();
                if self.comp.on_divider(point.0) {
                    return Ok(());
                }
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                self.active_view = view;
                if self.default_menu {
                    self.open_menu(view, local);
                }
                out.push(EngineEvent::RightClick {
                    view,
                    x: local.0,
                    y: local.1,
                });
            }
            MouseKind::Move => {
                if self.comp.divider_drag {
                    let resized = self.comp.drag_divider(point.0);
                    self.push_resizes(resized);
                    return Ok(());
                }
                let divider_hover = self.comp.on_divider(point.0);
                self.comp.set_divider_hover(divider_hover);
                if let Some((view, id, grab)) = self.bar_drag {
                    let local = self.comp.to_local(view, point);
                    self.drag_bar_to(view, id, local.1 - grab);
                    return Ok(());
                }
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                if self.inspect_mode {
                    let over = (view == self.inspect_view)
                        .then(|| self.comp.views[view].tree.hit_any(local.0, local.1))
                        .flatten();
                    if over != self.inspect_hover {
                        self.inspect_hover = over;
                        self.comp.dirty = true;
                    }
                }
                let bar_hover = self.bar_at(view, local).map(|id| (view, id));
                if bar_hover != self.bar_hover {
                    self.bar_hover = bar_hover;
                    self.comp.views[view].tree.mark_paint();
                }
                let hover = self.comp.views[view]
                    .tree
                    .hover_at(local.0, local.1)
                    .map(|id| (view, id));
                if hover != self.hover {
                    if let Some((old, _)) = self.hover {
                        self.comp.views[old].tree.mark_paint();
                    }
                    if let Some((new, _)) = hover {
                        self.comp.views[new].tree.mark_paint();
                    }
                    self.hover = hover;
                }
                self.update_hover_target(view, local, out);
                if let Some(id) = self.comp.views[view].tree.hit_move(local.0, local.1) {
                    out.push(EngineEvent::MouseMove {
                        view,
                        node: id,
                        key: self.comp.views[view].tree.key_of(id).map(str::to_string),
                        x: local.0,
                        y: local.1,
                    });
                }
                if let Some((view, target)) = self.drag {
                    let local = self.comp.to_local(view, point);
                    match target {
                        DragTarget::Input(id) => {
                            let translated = Mouse {
                                x: local.0.max(0.0) as u32,
                                y: local.1.max(0.0) as u32,
                                ..mouse
                            };
                            self.forward_mouse(view, id, &translated, out)?;
                        }
                        DragTarget::Text => {
                            let fonts = &self.fonts;
                            self.comp.views[view]
                                .tree
                                .doc_select_drag((local.0, local.1), fonts);
                            if let Some((focus_view, _)) = self.focused()
                                && self.comp.views[view]
                                    .tree
                                    .doc_selection()
                                    .is_some_and(|sel| !sel.is_collapsed())
                            {
                                self.comp.views[focus_view].tree.set_focus(None);
                            }
                        }
                        DragTarget::Node(id) => {
                            out.push(EngineEvent::Drag {
                                view,
                                node: id,
                                key: self.comp.views[view].tree.key_of(id).map(str::to_string),
                                phase: DragPhase::Move,
                                x: local.0,
                                y: local.1,
                                mods: mouse.mods,
                            });
                        }
                    }
                }
            }
            MouseKind::Up => {
                self.comp.divider_drag = false;
                self.bar_drag = None;
                if let Some((view, target)) = self.drag.take() {
                    match target {
                        DragTarget::Input(id) => {
                            let local = self.comp.to_local(view, point);
                            let translated = Mouse {
                                x: local.0.max(0.0) as u32,
                                y: local.1.max(0.0) as u32,
                                ..mouse
                            };
                            self.forward_mouse(view, id, &translated, out)?;
                        }
                        DragTarget::Text => self.comp.views[view].tree.doc_select_up(),
                        DragTarget::Node(id) => {
                            let local = self.comp.to_local(view, point);
                            out.push(EngineEvent::Drag {
                                view,
                                node: id,
                                key: self.comp.views[view].tree.key_of(id).map(str::to_string),
                                phase: DragPhase::End,
                                x: local.0,
                                y: local.1,
                                mods: mouse.mods,
                            });
                        }
                    }
                }
            }
            MouseKind::ScrollLeft | MouseKind::ScrollRight => {
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                let delta = if mouse.kind == MouseKind::ScrollLeft {
                    -(self.cell.0 as f32)
                } else {
                    self.cell.0 as f32
                };
                self.emit_wheel(view, local, delta, 0.0, false, mouse.mods, out);
            }
            // Reaching here means the tick was not consumed as pairing
            // signal: no native gesture (headless, synthetic input) or a
            // modified scroll (e.g. ctrl+wheel zoom), which always rides the
            // terminal events — the helper cannot report modifiers.
            MouseKind::ScrollUp | MouseKind::ScrollDown => {
                let view = self.comp.view_at(point.0);
                self.mark_scroll(view);
                let local = self.comp.to_local(view, point);
                let delta = if mouse.kind == MouseKind::ScrollUp {
                    -(self.cell.1 as f32)
                } else {
                    self.cell.1 as f32
                };
                if self.emit_wheel(view, local, 0.0, delta, false, mouse.mods, out) {
                    return Ok(());
                }
                if let Some(area) = self.comp.views[view].tree.scroll_area_at(local.0, local.1) {
                    let max = area.max_scroll();
                    let node = area.node;
                    let profile = self.profile;
                    if let Some(state) = self.comp.views[view].tree.scroll_state_mut(node) {
                        state.tick(profile, delta, max);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn update_hover_target(
        &mut self,
        view: usize,
        local: (f32, f32),
        out: &mut Vec<EngineEvent>,
    ) {
        let hover_target = self.comp.views[view]
            .tree
            .hit_hover(local.0, local.1)
            .map(|id| (view, id));
        if hover_target == self.hover_target {
            return;
        }
        if let Some((v, node)) = self.hover_target {
            out.push(EngineEvent::HoverLeave {
                view: v,
                node,
                key: self.comp.views[v].tree.key_of(node).map(str::to_string),
            });
        }
        if let Some((v, node)) = hover_target {
            out.push(EngineEvent::HoverEnter {
                view: v,
                node,
                key: self.comp.views[v].tree.key_of(node).map(str::to_string),
            });
        }
        self.hover_target = hover_target;
    }

    fn forward_pointer(
        &mut self,
        mouse: Mouse,
        point: (f32, f32),
        out: &mut Vec<EngineEvent>,
    ) -> bool {
        let target = match mouse.kind {
            MouseKind::Down => {
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1) else {
                    return false;
                };
                self.active_view = view;
                self.set_focus(view, None);
                self.key_passthrough = true;
                self.pointer_capture = Some((view, node));
                (view, node)
            }
            MouseKind::Move => match self.pointer_capture {
                Some(target) => target,
                None => {
                    let view = self.comp.view_at(point.0);
                    let local = self.comp.to_local(view, point);
                    // pointer nodes swallow moves before the regular hover pass,
                    // so keep enter/leave tracking alive while over them
                    self.update_hover_target(view, local, out);
                    let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1)
                    else {
                        return false;
                    };
                    (view, node)
                }
            },
            MouseKind::Up => match self.pointer_capture.take() {
                Some(target) => target,
                None => {
                    let view = self.comp.view_at(point.0);
                    let local = self.comp.to_local(view, point);
                    let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1)
                    else {
                        return false;
                    };
                    (view, node)
                }
            },
            _ => return false,
        };
        let (view, node) = target;
        let local = self.comp.to_local(view, point);
        let rect = self.comp.views[view]
            .tree
            .rect(node)
            .unwrap_or(PxRect::ZERO);
        out.push(EngineEvent::Pointer {
            view,
            node,
            key: self.comp.views[view].tree.key_of(node).map(str::to_string),
            kind: mouse.kind,
            button: mouse.button,
            mods: mouse.mods,
            x: local.0 - rect.x,
            y: local.1 - rect.y,
        });
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_wheel(
        &mut self,
        view: usize,
        local: (f32, f32),
        delta_x: f32,
        delta_y: f32,
        precise: bool,
        mods: Mods,
        out: &mut Vec<EngineEvent>,
    ) -> bool {
        let tree = &self.comp.views[view].tree;
        let Some(node) = tree.hit_wheel(local.0, local.1) else {
            return false;
        };
        let rect = tree.rect(node).unwrap_or(crate::tree::PxRect::ZERO);
        out.push(EngineEvent::Wheel {
            view,
            node,
            key: tree.key_of(node).map(str::to_string),
            x: local.0 - rect.x,
            y: local.1 - rect.y,
            delta_x,
            delta_y,
            precise,
            mods,
        });
        true
    }

    fn mark_pointer(&mut self, name: &'static str, point: (f32, f32)) {
        if !crate::profiler::is_recording() {
            return;
        }
        let view = self.comp.view_at(point.0);
        let local = self.comp.to_local(view, point);
        let target = self.comp.views[view]
            .tree
            .hit_click(local.0, local.1)
            .and_then(|id| self.comp.views[view].tree.key_of(id))
            .map(str::to_string);
        let label = match target {
            Some(key) => format!("{name} #{key}"),
            None => format!("{name} {},{}", local.0 as i32, local.1 as i32),
        };
        crate::profiler::mark(name, view as u32, label);
    }

    fn mark_scroll(&mut self, view: usize) {
        if !crate::profiler::is_recording() {
            return;
        }
        let now = Instant::now();
        let burst = self
            .last_scroll_mark
            .is_some_and(|at| now.duration_since(at).as_millis() < 350);
        self.scroll_burst = if burst { self.scroll_burst + 1 } else { 1 };
        self.last_scroll_mark = Some(now);
        crate::profiler::mark_or_extend(
            "scroll",
            view as u32,
            format!("scroll x{}", self.scroll_burst),
            350.0,
        );
    }

    fn finish_inspect(&mut self, local: (f32, f32), out: &mut Vec<EngineEvent>) {
        self.inspect_mode = false;
        let view = self.inspect_view;
        let node = self
            .inspect_hover
            .take()
            .or_else(|| self.comp.views[view].tree.hit_any(local.0, local.1));
        self.comp.dirty = true;
        let Some(node) = node else {
            return;
        };
        out.push(EngineEvent::Inspect {
            view,
            node,
            key: self.comp.views[view].tree.key_of(node).map(str::to_string),
            x: local.0,
            y: local.1,
        });
    }

    fn open_menu(&mut self, view: usize, at: (f32, f32)) {
        let size = self.comp.views[view].size;
        let focus = self.menu.open(
            &mut self.comp.views[view].tree,
            view,
            at,
            (size.0 as f32, size.1 as f32),
            self.base_px,
            &self.fonts[0],
            view == self.inspect_view,
        );
        if let Some(id) = focus {
            self.set_focus(view, Some(id));
        }
    }

    fn close_menu(&mut self) {
        if let Some(view) = self.menu.view() {
            self.menu.close(&mut self.comp.views[view].tree);
        }
    }

    fn handle_menu_click(
        &mut self,
        point: (f32, f32),
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<bool> {
        let Some(view) = self.menu.view() else {
            return Ok(false);
        };
        if self.comp.view_at(point.0) != view {
            self.close_menu();
            return Ok(true);
        }
        let local = self.comp.to_local(view, point);
        match self.menu.click(&mut self.comp.views[view].tree, local) {
            MenuClick::KeepOpen | MenuClick::Dismissed => {}
            MenuClick::Action(action) => self.apply_input_action(action, out)?,
            MenuClick::Devtools { target, at } => {
                if let Some(node) = target {
                    out.push(EngineEvent::Inspect {
                        view,
                        node,
                        key: self.comp.views[view].tree.key_of(node).map(str::to_string),
                        x: at.0,
                        y: at.1,
                    });
                }
            }
        }
        Ok(true)
    }

    fn forward_mouse(
        &mut self,
        view: usize,
        id: NodeId,
        mouse: &Mouse,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let Some(geometry) = self.comp.views[view].tree.input_geometry(id) else {
            return Ok(());
        };
        let fonts = &self.fonts;
        let Some(input) = self.comp.views[view].tree.input_mut(id) else {
            return Ok(());
        };
        let reply = input.handle_mouse(mouse, geometry, fonts);
        if reply != InputReply::None {
            self.finish_reply(view, id, reply, ChangeSource::Edit, out)?;
        }
        Ok(())
    }

    fn finish_reply(
        &mut self,
        view: usize,
        id: NodeId,
        reply: InputReply,
        source: ChangeSource,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        match reply {
            InputReply::None => {}
            InputReply::Selected => {
                self.comp.views[view].tree.mark_paint();
                self.push_caret(view, id, out);
            }
            InputReply::Moved => {
                self.reveal = true;
                self.comp.views[view].tree.mark_paint();
                self.push_caret(view, id, out);
            }
            InputReply::Edited => {
                self.comp.views[view].tree.sync_input_text(id);
                self.reveal = true;
                self.push_change(view, id, source, out);
            }
            InputReply::Copy(text, marks) => {
                let marks = marks.iter().map(|m| (id, m.clone())).collect();
                self.begin_rich_capture(view, text, marks)?;
            }
            InputReply::Cut(text, marks) => {
                let marks = marks.iter().map(|m| (id, m.clone())).collect();
                self.begin_rich_capture(view, text, marks)?;
                self.comp.views[view].tree.sync_input_text(id);
                self.reveal = true;
                self.push_change(view, id, source, out);
            }
            InputReply::RequestPaste => {
                let seq = crate::image_cache::queue_clipboard_read();
                self.pending_pastes.push((seq, view, id));
            }
        }
        Ok(())
    }

    fn push_paste_image(
        &mut self,
        view: usize,
        id: NodeId,
        image: crate::clipboard_image::PastedImage,
        out: &mut Vec<EngineEvent>,
    ) {
        logging::info(
            "engine",
            format!("paste image {}x{} {}", image.width, image.height, image.path),
        );
        out.push(EngineEvent::PasteImage {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            path: image.path,
            width: image.width,
            height: image.height,
        });
    }

    // Reads any image on the clipboard and replies with a PasteImage event
    // targeting the view root — for apps that paste without a focused input.
    pub fn request_clipboard_image(&mut self, view: usize) {
        let root = self.comp.views[view].tree.root();
        let seq = crate::image_cache::queue_clipboard_read();
        self.pending_pastes.push((seq, view, root));
    }

    pub fn insert_input_mark(&mut self, view: usize, id: NodeId, mark: u64, offset: Option<usize>) {
        {
            let Some(input) = self.comp.views[view].tree.input_mut(id) else {
                return;
            };
            input.insert_mark(mark, offset);
        }
        self.comp.views[view].tree.sync_input_text(id);
        self.reveal = true;
        let mut events = Vec::new();
        self.push_change(view, id, ChangeSource::Edit, &mut events);
        self.pending.append(&mut events);
    }

    pub fn remove_input_mark(&mut self, view: usize, id: NodeId, mark: u64) {
        {
            let Some(input) = self.comp.views[view].tree.input_mut(id) else {
                return;
            };
            input.remove_mark(mark);
        }
        self.comp.views[view].tree.sync_input_text(id);
        let mut events = Vec::new();
        self.push_change(view, id, ChangeSource::Edit, &mut events);
        self.pending.append(&mut events);
    }

    fn begin_rich_capture(
        &mut self,
        view: usize,
        text: String,
        marks: Vec<(NodeId, crate::text_input::Mark)>,
    ) -> io::Result<()> {
        let projection: String = text
            .chars()
            .filter(|&c| c != crate::text_input::MARK_CHAR)
            .collect();
        self.term.set_clipboard(&projection)?;
        if marks.is_empty() {
            self.rich_clipboard = None;
            return Ok(());
        }
        self.rich_token += 1;
        let slots = marks
            .iter()
            .map(|(_, m)| RichSlot {
                offset: m.offset,
                data: m.data.clone(),
            })
            .collect();
        let request = marks
            .iter()
            .enumerate()
            .map(|(index, (node, m))| (*node, m.id, index))
            .collect();
        self.rich_clipboard = Some(RichClip {
            token: self.rich_token,
            text,
            slots,
        });
        self.pending.push(EngineEvent::SerializeMarks {
            view,
            token: self.rich_token,
            marks: request,
        });
        Ok(())
    }


    pub fn attach_rich_clipboard(&mut self, token: u64, marks: Vec<(usize, String)>) {
        let Some(rich) = self.rich_clipboard.as_mut().filter(|r| r.token == token) else {
            return;
        };
        for (index, data) in marks {
            if let Some(slot) = rich.slots.get_mut(index) {
                slot.data = Some(data);
            }
        }
        let rich = self.rich_clipboard.take().expect("checked above");
        if let Some(enriched) = enrich_clipboard_text(&rich.text, &rich.slots) {
            if let Err(error) = self.term.set_clipboard(&enriched) {
                logging::warn("engine", format!("clipboard write failed: {error}"));
            }
        }
    }

    fn rich_paste_payload(&self, text: &str) -> Option<(String, Vec<(usize, String)>)> {
        parse_rich_paste(text)
    }

    fn input_marks(&self, view: usize, id: NodeId) -> Vec<MarkRef> {
        self.comp.views[view].tree.input(id).map_or(Vec::new(), |input| {
            input
                .marks()
                .iter()
                .map(|m| MarkRef {
                    id: m.id,
                    offset: m.offset,
                    data: m.data.clone(),
                })
                .collect()
        })
    }

    fn submit_input(
        &mut self,
        view: usize,
        id: NodeId,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let text = self.comp.views[view]
            .tree
            .input_text(id)
            .unwrap_or_default()
            .to_string();
        out.push(EngineEvent::Submit {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            text,
            marks: self.input_marks(view, id),
        });
        self.comp.views[view]
            .tree
            .edit_input(id, |input| input.replace_all(""));
        self.finish_reply(view, id, InputReply::Edited, ChangeSource::Edit, out)
    }

    fn push_change(
        &mut self,
        view: usize,
        id: NodeId,
        source: ChangeSource,
        out: &mut Vec<EngineEvent>,
    ) {
        let Some((cursor, caret)) = self.caret_state(view, id) else {
            return;
        };
        let Some(text) = self.comp.views[view].tree.input_text(id) else {
            return;
        };
        let text = text.to_string();
        out.push(EngineEvent::Change {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            text,
            marks: self.input_marks(view, id),
            cursor,
            caret,
            source,
        });
    }

    fn push_caret(&mut self, view: usize, id: NodeId, out: &mut Vec<EngineEvent>) {
        let Some((cursor, caret)) = self.caret_state(view, id) else {
            return;
        };
        out.push(EngineEvent::Caret {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            cursor,
            caret,
        });
    }

    fn caret_state(&mut self, view: usize, id: NodeId) -> Option<(usize, PxRect)> {
        let fonts = &self.fonts;
        let base_px = self.base_px;
        self.comp.views[view].tree.flush_layout(fonts, base_px);
        let tree = &self.comp.views[view].tree;
        let geometry = tree.input_geometry(id)?;
        let input = tree.input(id)?;
        let cursor = input.cursor();
        Some((
            cursor,
            geometry.caret_rect(input.text(), input.marks(), cursor, fonts),
        ))
    }

    fn bar_at(&self, view: usize, point: (f32, f32)) -> Option<NodeId> {
        let tree = &self.comp.views[view].tree;
        tree.scroll_nodes().into_iter().rev().find(|&id| {
            tree.bar_opacity(id) > 0.1
                && tree
                    .scrollbar_rects(id)
                    .is_some_and(|r| r.zone.contains(point.0, point.1))
        })
    }

    fn begin_bar_drag(&mut self, view: usize, point: (f32, f32)) -> bool {
        let Some(id) = self.bar_at(view, point) else {
            return false;
        };
        let Some(rects) = self.comp.views[view].tree.scrollbar_rects(id) else {
            return false;
        };
        let grab = if rects.thumb.contains(rects.thumb.x + 1.0, point.1) {
            point.1 - rects.thumb.y
        } else {
            let center_grab = rects.thumb.h / 2.0;
            self.drag_bar_to(view, id, point.1 - center_grab);
            center_grab
        };
        self.bar_drag = Some((view, id, grab));
        self.touch_bar(view, id);
        true
    }

    fn drag_bar_to(&mut self, view: usize, id: NodeId, thumb_y: f32) {
        let Some(position) = self.comp.views[view].tree.scroll_pos_for_thumb(id, thumb_y) else {
            return;
        };
        let tree = &mut self.comp.views[view].tree;
        if let Some(state) = tree.scroll_state_mut(id)
            && state.position != position
        {
            state.position = position;
            state.set_target(position);
            tree.mark_place();
            tree.touch_bar(id);
        }
    }

    fn touch_bar(&mut self, view: usize, id: NodeId) {
        self.comp.views[view].tree.touch_bar(id);
    }

    fn step_bars(&mut self, dt: f32) {
        let now = Instant::now();
        for view in self.comp.active_views() {
            for id in self.comp.views[view].tree.scroll_nodes() {
                let engaged = self.bar_hover == Some((view, id))
                    || self.bar_drag.map(|(v, d, _)| (v, d)) == Some((view, id));
                let tree = &mut self.comp.views[view].tree;
                if tree.step_bar(id, engaged, dt, now) {
                    tree.mark_paint();
                }
            }
        }
    }

    fn bars_animating(&self) -> bool {
        let now = Instant::now();
        self.comp.active_views().into_iter().any(|view| {
            let tree = &self.comp.views[view].tree;
            tree.scroll_nodes()
                .iter()
                .any(|&id| tree.bar_animating(id, now))
        })
    }

    fn emit_scroll_events(&mut self, out: &mut Vec<EngineEvent>) {
        for view in self.comp.active_views() {
            for id in self.comp.views[view].tree.scroll_nodes() {
                let tree = &mut self.comp.views[view].tree;
                let Some((key, offset, max)) = tree.take_scroll_emit(id) else {
                    continue;
                };
                out.push(EngineEvent::Scroll {
                    view,
                    node: id,
                    key,
                    offset,
                    max,
                });
            }
        }
    }

    // Scrolls the nearest scrollable ancestor so `id` lands at its top edge.
    pub fn scroll_into_view(&mut self, view: usize, id: NodeId, smooth: bool) {
        if view >= self.comp.views.len() {
            return;
        }
        let fonts = &self.fonts;
        let base_px = self.base_px;
        self.comp.views[view].tree.flush_layout(fonts, base_px);
        let tree = &self.comp.views[view].tree;
        let Some(child) = tree.rect(id) else {
            return;
        };
        let mut current = tree.parent(id);
        while let Some(ancestor) = current {
            current = tree.parent(ancestor);
            let (Some(rect), Some(scroll)) = (tree.rect(ancestor), tree.scroll_state(ancestor))
            else {
                continue;
            };
            if tree.scroll_max(ancestor) <= 0.0 {
                continue;
            }
            let offset = scroll.position + child.y - rect.y - base_px * 0.5;
            self.scroll_to(view, ancestor, offset, smooth);
            return;
        }
    }

    pub fn scroll_to(&mut self, view: usize, id: NodeId, offset: f32, smooth: bool) {
        if view >= self.comp.views.len() {
            return;
        }
        let fonts = &self.fonts;
        let base_px = self.base_px;
        let tree = &mut self.comp.views[view].tree;
        tree.flush_layout(fonts, base_px);
        let max = tree.scroll_max(id);
        let offset = offset.clamp(0.0, max);
        if let Some(state) = tree.scroll_state_mut(id) {
            if smooth {
                state.set_target(offset);
            } else {
                state.position = offset;
                state.set_target(offset);
                tree.mark_place();
            }
            tree.touch_bar(id);
        }
    }

    /// Pull helper events into the gesture state machine: paired gestures
    /// queue for application, unpaired ones buffer until a wheel tick proves
    /// the pointer is over this pane (or the pair window expires).
    fn ingest_native(&mut self) {
        let Some(native) = &mut self.native else {
            return;
        };
        let deltas = native.drain();
        let scale = native.scale;
        if native.dead() {
            logging::warn("engine", "native scroll helper exited; falling back to wheel ticks");
            self.native = None;
            self.native_gesture = NativeGesture::Idle;
            self.native_buffer.clear();
            return;
        }
        if !self.use_native {
            return;
        }
        for delta in deltas {
            match delta {
                NativeDelta::Zoom { magnification } => {
                    self.pending_zoom *= 1.0 + magnification;
                }
                NativeDelta::Scroll {
                    delta_x,
                    delta_y,
                    precise,
                    phase,
                    ..
                } => {
                    // notch wheels carry no sub-cell information; their SGR
                    // ticks scroll with identical resolution on their own
                    if !precise {
                        continue;
                    }
                    if phase & crate::native::PHASE_BEGAN != 0 {
                        self.native_buffer.clear();
                        self.native_gesture = NativeGesture::Undecided {
                            since: Instant::now(),
                        };
                    }
                    let px = (delta_x * scale, delta_y * scale);
                    match self.native_gesture {
                        NativeGesture::Idle => {
                            self.native_gesture = NativeGesture::Undecided {
                                since: Instant::now(),
                            };
                            self.native_buffer.push(px);
                        }
                        NativeGesture::Undecided { .. } => self.native_buffer.push(px),
                        NativeGesture::Paired => self.native_ready.push(px),
                        NativeGesture::Dropped => {}
                    }
                }
            }
        }
        if let NativeGesture::Undecided { since } = self.native_gesture
            && since.elapsed() > NATIVE_PAIR_WINDOW
        {
            self.native_gesture = NativeGesture::Dropped;
            self.native_buffer.clear();
        }
    }

    fn drain_native(&mut self, out: &mut Vec<EngineEvent>) {
        self.ingest_native();
        let zoom = std::mem::replace(&mut self.pending_zoom, 1.0);
        let scrolls = std::mem::take(&mut self.native_ready);
        // Pinch has no terminal-side event to pair with (terminals do not
        // report it), so it settles for recent pointer activity over this
        // pane as hover evidence.
        let pinch_here = self
            .last_pointer_activity
            .is_some_and(|at| at.elapsed() < PINCH_HOVER_WINDOW);
        let magnification = zoom - 1.0;
        if (magnification == 0.0 || !pinch_here) && scrolls.is_empty() {
            return;
        }
        // Before any mouse motion has been seen, anchor at the window center —
        // scrolling right after launch must still work.
        let cursor = self.cursor.unwrap_or((
            self.comp.window.0 as f32 / 2.0,
            self.comp.window.1 as f32 / 2.0,
        ));
        let view = self.comp.view_at(cursor.0);
        self.mark_scroll(view);
        let local = self.comp.to_local(view, cursor);
        // Pinch arrives as a ctrl+precise wheel — the web convention for
        // pinch-zoom — so wheel subscribers get zoom-at-cursor for free.
        if magnification != 0.0 && pinch_here {
            self.emit_wheel(
                view,
                local,
                0.0,
                -magnification * PINCH_WHEEL_SCALE,
                true,
                Mods {
                    ctrl: true,
                    ..Mods::default()
                },
                out,
            );
        }
        if scrolls.is_empty() {
            return;
        }
        if self.last_native_scroll.is_none() {
            logging::info("engine", "native scroll delivering");
        }
        self.last_native_scroll = Some(Instant::now());
        if self.comp.views[view].tree.hit_wheel(local.0, local.1).is_some() {
            let mut delta_x = 0.0;
            let mut delta_y = 0.0;
            for (dx, dy) in &scrolls {
                delta_x -= dx;
                delta_y -= dy;
            }
            self.emit_wheel(view, local, delta_x, delta_y, true, Mods::default(), out);
            return;
        }
        let Some(area) = self.comp.views[view].tree.scroll_area_at(local.0, local.1) else {
            return;
        };
        let (node, max) = (area.node, area.max_scroll());
        let mut moved = false;
        if let Some(state) = self.comp.views[view].tree.scroll_state_mut(node) {
            for (_, dy) in scrolls {
                let next = (state.position - dy).clamp(0.0, max);
                if next != state.position {
                    state.position = next;
                    moved = true;
                }
                state.set_target(next);
            }
        }
        if moved {
            self.comp.views[view].tree.mark_place();
        }
        self.touch_bar(view, node);
    }

    fn step_scrolls(&mut self, dt: f32) {
        let profile = self.profile;
        for view in self.comp.active_views() {
            let tree = &mut self.comp.views[view].tree;
            for id in tree.scroll_nodes() {
                let max = tree.scroll_max(id);
                if let Some(state) = tree.scroll_state_mut(id)
                    && state.step(profile, dt, max)
                {
                    tree.mark_place();
                    tree.touch_bar(id);
                }
            }
        }
    }

    fn reveal_caret(&mut self) {
        let Some((view, focus)) = self.focused() else {
            return;
        };
        let fonts = &self.fonts;
        let base_px = self.base_px;
        self.comp.views[view].tree.flush_layout(fonts, base_px);
        let tree = &self.comp.views[view].tree;
        let Some(scroller) = tree.parent(focus).and_then(|p| tree.scroll_parent(p)) else {
            return;
        };
        let Some(area) = tree.scroll_area(scroller) else {
            return;
        };
        let Some(geometry) = tree.input_geometry(focus) else {
            return;
        };
        let Some(input) = tree.input(focus) else {
            return;
        };
        let text = input.text().to_string();
        let marks = input.marks().to_vec();
        let cursor = input.cursor();
        let Some(px) = tree.resolved_px(focus) else {
            return;
        };
        let caret = geometry.caret_rect(&text, &marks, cursor, &self.fonts);
        let margin = px * 1.1;
        let current = tree.scroll_state(scroller).map_or(0.0, |s| s.target);
        if let Some(target) = area.target_to_reveal(caret, current, margin)
            && let Some(state) = self.comp.views[view].tree.scroll_state_mut(scroller)
        {
            state.set_target(target);
        }
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

    fn draw_node_overlay(&mut self, view: usize, id: NodeId, area: HighlightArea, with_label: bool) {
        if !self.comp.is_active(view) {
            return;
        }
        let Some(v) = self.comp.views.get(view) else {
            return;
        };
        let Some(visible) = v.tree.visible_rect(id) else {
            return;
        };
        if visible.w <= 0.0 || visible.h <= 0.0 {
            return;
        }
        let Some(abs) = v.tree.rect(id) else {
            return;
        };
        let metrics = v.tree.box_metrics(id).unwrap_or_default();
        let key = v.tree.key_of(id).map(str::to_string);
        let clip = PxRect {
            x: v.origin_x as f32,
            y: 0.0,
            w: v.size.0 as f32,
            h: v.size.1 as f32,
        };
        let border_box = PxRect {
            x: abs.x + v.origin_x as f32,
            y: abs.y,
            w: abs.w,
            h: abs.h,
        };
        let padding_box = inset(border_box, metrics.border);
        let content_box = inset(padding_box, metrics.padding);
        let margin_box = outset(border_box, metrics.margin);
        let frame = &mut self.comp.frame;
        match area {
            HighlightArea::All => {
                fill_clipped(frame, content_box, clip, CONTENT_FILL);
                fill_ring(frame, padding_box, content_box, clip, PADDING_FILL);
                fill_ring(frame, border_box, padding_box, clip, BORDER_FILL);
                fill_ring(frame, margin_box, border_box, clip, MARGIN_FILL);
            }
            HighlightArea::Content => fill_clipped(frame, content_box, clip, CONTENT_FILL),
            HighlightArea::Padding => fill_ring(frame, padding_box, content_box, clip, PADDING_FILL),
            HighlightArea::Border => fill_ring(frame, border_box, padding_box, clip, BORDER_FILL),
            HighlightArea::Margin => fill_ring(frame, margin_box, border_box, clip, MARGIN_FILL),
        }
        if !with_label {
            return;
        }
        let px = self.base_px * 0.85;
        let label = match key {
            Some(key) => format!("{key}  {:.0} × {:.0}", abs.w, abs.h),
            None => format!("{:.0} × {:.0}", abs.w, abs.h),
        };
        let font = &self.fonts[0];
        let text_w = measure_text(font, &label, px);
        let line_h = crate::text_input::line_height(font, px);
        let pad = px * 0.4;
        let (w, h) = (text_w + pad * 2.0, line_h + pad);
        let lx = border_box.x.min(self.comp.window.0 as f32 - w).max(0.0);
        let mut ly = border_box.y + border_box.h + 4.0;
        if ly + h > self.comp.window.1 as f32 {
            ly = (border_box.y - h - 4.0).max(0.0);
        }
        self.comp.frame
            .fill_rounded_rect(lx, ly, w, h, [4.0; 4], [24, 26, 32, 245]);
        self.comp.frame
            .stroke_rounded_rect(lx, ly, w, h, [4.0; 4], 1.0, [72, 75, 86, 255]);
        if let Some(metrics) = font.horizontal_line_metrics(px) {
            self.comp.frame.draw_text(
                font,
                &label,
                (lx + pad) as i32,
                (ly + pad / 2.0 + metrics.ascent) as i32,
                px,
                [186, 210, 255, 255],
            );
        }
    }
}

fn inset(r: PxRect, e: Edges) -> PxRect {
    PxRect {
        x: r.x + e.left,
        y: r.y + e.top,
        w: (r.w - e.left - e.right).max(0.0),
        h: (r.h - e.top - e.bottom).max(0.0),
    }
}

fn outset(r: PxRect, e: Edges) -> PxRect {
    PxRect {
        x: r.x - e.left,
        y: r.y - e.top,
        w: r.w + e.left + e.right,
        h: r.h + e.top + e.bottom,
    }
}

fn fill_clipped(frame: &mut Canvas, rect: PxRect, clip: PxRect, color: Color) {
    let r = rect.intersect(clip);
    if r.w > 0.0 && r.h > 0.0 {
        frame.fill_rounded_rect(r.x, r.y, r.w, r.h, [0.0; 4], color);
    }
}

fn fill_ring(frame: &mut Canvas, outer: PxRect, inner: PxRect, clip: PxRect, color: Color) {
    let strips = [
        PxRect {
            x: outer.x,
            y: outer.y,
            w: outer.w,
            h: inner.y - outer.y,
        },
        PxRect {
            x: outer.x,
            y: inner.y + inner.h,
            w: outer.w,
            h: (outer.y + outer.h) - (inner.y + inner.h),
        },
        PxRect {
            x: outer.x,
            y: inner.y,
            w: inner.x - outer.x,
            h: inner.h,
        },
        PxRect {
            x: inner.x + inner.w,
            y: inner.y,
            w: (outer.x + outer.w) - (inner.x + inner.w),
            h: inner.h,
        },
    ];
    for strip in strips {
        fill_clipped(frame, strip, clip, color);
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

#[cfg(test)]
mod rich_clip_tests {
    use super::*;

    #[test]
    fn enrich_inlines_data_and_strips_dataless_sentinels() {
        let m = crate::text_input::MARK_CHAR;
        let text = format!("a{m}b{m}c");
        let slots = vec![
            RichSlot {
                offset: 1,
                data: Some("one".into()),
            },
            RichSlot {
                offset: 1 + m.len_utf8() + 1,
                data: None,
            },
        ];
        assert_eq!(
            enrich_clipboard_text(&text, &slots).unwrap(),
            format!("a{MARK_TOKEN_OPEN}one{MARK_TOKEN_CLOSE}bc")
        );
        let none = vec![RichSlot {
            offset: 1,
            data: None,
        }];
        assert!(enrich_clipboard_text(&text, &none).is_none());
    }

    #[test]
    fn parse_round_trips_and_tolerates_unmatched_delimiters() {
        let m = crate::text_input::MARK_CHAR;
        let pasted = format!("x{MARK_TOKEN_OPEN}one{MARK_TOKEN_CLOSE}y{MARK_TOKEN_OPEN}two{MARK_TOKEN_CLOSE}");
        let (text, marks) = parse_rich_paste(&pasted).unwrap();
        assert_eq!(text, format!("x{m}y{m}"));
        assert_eq!(marks, vec![(1, "one".into()), (2 + m.len_utf8(), "two".into())]);

        assert!(parse_rich_paste("plain text").is_none());
        let unmatched = format!("a{MARK_TOKEN_OPEN}never closed");
        assert!(parse_rich_paste(&unmatched).is_none(), "unmatched keeps text plain");
    }
}

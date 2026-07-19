mod canvas;
pub mod clipboard_image;
mod desc;
mod engine;
pub mod ghostty;
mod image_cache;
mod kitty;
pub mod logging;
mod menu;
mod native;
mod paint;
pub mod profiler;
mod scene;
mod scroll;
mod scrollbar;
mod selection;
mod style;
mod surfaces;
mod terminal;
mod text_input;
mod throttle;
mod tmux;
mod tree;
mod wrap;

pub use canvas::{Canvas, measure_text};
pub use desc::Desc;
pub use engine::{
    ChangeSource, DragPhase, Engine, EngineConfig, EngineEvent, FrameStats, HighlightArea, MarkRef,
    px_for_cell_height,
};
pub use kitty::kitty_transmit;
pub use logging::{LogEntry, LogLevel};
pub use menu::{CONTEXT_MENU_KEY, MenuEntry, MenuItem, MenuStyle, context_menu};
pub use native::{NativeDelta, NativeScroll};
pub use paint::paint;
pub use profiler::{CounterRecord, ProfileData, Profiler, SpanRecord};
pub use scene::{Camera, LineCap, LineJoin, PathCmd, Shape, ShapeProps, ShapeStroke, parse_path_data};
pub use scroll::profiles::{Glide, Smooth, Tui};
pub use scroll::{ScrollProfile, ScrollState};
pub use scrollbar::ScrollbarRects;
pub use selection::{DocPos, DocSelection};
pub use style::{
    Align, Border, BorderSide, Color, Dimension, Edges, FlexDirection, Inset, InsetValue, Justify,
    Overflow, Position, ScrollbarStyle, SelectionMode, Style,
};
pub use terminal::{
    Event, Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind, Terminal, TerminalColors, Waker,
    WindowSize,
};
pub use text_input::{
    Granularity, InputAction, InputGeometry, InputReply, MARK_CHAR, Mark, TextInput, line_height,
    offset_to_point, point_to_offset,
};
pub use throttle::CpuThrottle;
pub use tree::{
    BoxMetrics, Gutter, HitTarget, ImageProps, InputProps, NodeId, Props, PxRect, ScrollArea,
    SlotKind, TextSpan, Tree,
};
pub use wrap::{line_of_offset, wrap_lines};

pub use fontdue;

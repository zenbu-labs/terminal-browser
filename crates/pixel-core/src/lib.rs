mod canvas;
mod desc;
mod engine;
pub mod ghostty;
mod kitty;
pub mod logging;
mod menu;
mod native;
mod paint;
pub mod profiler;
mod scroll;
mod style;
mod terminal;
mod text_input;
mod throttle;
mod tree;
mod wrap;

pub use canvas::{Canvas, measure_text};
pub use desc::Desc;
pub use engine::{Engine, EngineConfig, EngineEvent, FrameStats, px_for_cell_height};
pub use kitty::kitty_transmit;
pub use logging::{LogEntry, LogLevel};
pub use menu::{CONTEXT_MENU_KEY, MenuEntry, MenuItem, MenuStyle, context_menu};
pub use native::{NativeDelta, NativeScroll};
pub use paint::paint;
pub use profiler::{CounterRecord, ProfileData, Profiler, SpanRecord};
pub use scroll::profiles::{Glide, Smooth, Tui};
pub use scroll::{ScrollProfile, ScrollState};
pub use style::{
    Align, Border, Color, Dimension, Edges, FlexDirection, Inset, Justify, Overflow, Position,
    ScrollbarStyle, Style,
};
pub use terminal::{
    Event, Key, KeyEvent, Mods, Mouse, MouseButton, MouseKind, Terminal, TerminalColors, Waker,
    WindowSize,
};
pub use text_input::{
    Granularity, InputAction, InputGeometry, InputReply, TextInput, line_height, offset_to_point,
    point_to_offset,
};
pub use throttle::CpuThrottle;
pub use tree::{HitTarget, InputProps, NodeId, Props, PxRect, ScrollArea, ScrollbarRects, Tree};
pub use wrap::{line_of_offset, wrap_lines};

pub use fontdue;

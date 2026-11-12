pub mod backend;
pub mod device;
pub mod text_metrics;
pub mod clipboard_image;
mod desc;
mod engine;
pub mod fonts;
pub mod image_cache;
mod input;
pub mod logging;
mod menu;
pub mod scene;
pub mod parallel;
pub mod profiler;
mod shape;
mod scroll;
mod scrollbar;
mod selection;
mod style;
pub mod surfaces;
pub mod system_fonts;
mod text_input;
pub(crate) mod throttle;
mod tree;
mod wrap;

pub use text_metrics::{FontMetrics, TextMetrics, measure_text};
pub use device::{ColorDepth, Device, Pointer};
pub use desc::Desc;
pub use engine::{
    ChangeSource, DragPhase, Engine, EngineConfig, EngineEvent, FrameStats, HighlightArea,
    MarkRef, px_for_cell_height,
};
pub use logging::{LogEntry, LogLevel};
pub use menu::{CONTEXT_MENU_KEY, MenuEntry, MenuItem, MenuStyle, context_menu};
mod record;
pub use record::record_scene;
pub use image_cache::scaled_rgba;
pub use shape::rounded_rect_path;
pub use profiler::{CounterRecord, ProfileData, SpanRecord};
pub use shape::{LineCap, LineJoin, PathCmd, ShapeProps, ShapeStroke, build_path, parse_path_data, skia_stroke};
pub use scroll::profiles::{Glide, Smooth, Step};
pub use scroll::{ScrollProfile, ScrollState};
pub use scrollbar::ScrollbarRects;
pub use selection::{DocPos, DocSelection};
pub use style::{
    Align, Border, BorderSide, Color, Dimension, Edges, FlexDirection, Inset, InsetValue, Justify,
    Layout, LinearGradient, Overflow, Paint, Position, ScrollAnchor, ScrollbarStyle, SelectionMode, Style,
};
pub use backend::{Backend, Event, HostColors, Metrics, Waker};
pub use input::{Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind};
pub use text_input::{
    caret_thickness, mark_advance_at, CaretShape, Granularity, InputAction, InputGeometry, InputReply, MARK_CHAR, Mark, TextInput,
    line_height, offset_to_point, point_to_offset,
};
pub use throttle::CpuThrottle;
pub use tree::{
    Placement, BoxMetrics, Gutter, HitTarget, ImageProps, InputProps, NodeId, Props, PxRect, ScrollArea,
    SlotKind, TextLayout, TextLeaf, TextLine, TextSpan, Tree,
};
pub use wrap::{WRAP_SLACK, line_of_offset, wrap_lines};

pub use fontdue;

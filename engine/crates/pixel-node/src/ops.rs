use std::collections::HashMap;

/**
 * interesting?
 * 
 * ah svg stuff suka suka
 */
use pixel_core::{
    Align, Border, BorderSide, Color, Dimension, Edges, Engine, FlexDirection, Gutter,
    HighlightArea, ImageProps, InputProps, Inset, InsetValue, Justify, LineCap, LineJoin, NodeId,
    Overflow, Position, Props, ScrollbarStyle, SelectionMode, ShapeProps, ShapeStroke,
    SlotKind, Style, TextSpan, parse_path_data,
};
use serde::Deserialize;

pub struct IdMap {
    to_node: HashMap<u32, NodeId>,
    to_ext: HashMap<NodeId, u32>,
}

impl IdMap {
    pub fn new(root: NodeId) -> Self {
        let mut map = Self {
            to_node: HashMap::new(),
            to_ext: HashMap::new(),
        };
        map.insert(0, root);
        map
    }

    fn insert(&mut self, ext: u32, node: NodeId) {
        self.to_node.insert(ext, node);
        self.to_ext.insert(node, ext);
    }

    fn forget(&mut self, ext: u32) {
        if let Some(node) = self.to_node.remove(&ext) {
            self.to_ext.remove(&node);
        }
    }

    pub fn node(&self, ext: u32) -> Option<NodeId> {
        self.to_node.get(&ext).copied()
    }

    pub fn ext(&self, node: NodeId) -> Option<u32> {
        self.to_ext.get(&node).copied()
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Op {
    Create {
        id: u32,
        props: PropsDto,
    },
    InsertBefore {
        parent: u32,
        child: u32,
        before: Option<u32>,
    },
    Remove {
        id: u32,
    },
    Forget {
        id: u32,
    },
    Update {
        id: u32,
        props: PropsDto,
    },
    Clear {
        id: u32,
    },
    Focus {
        id: Option<u32>,
    },
    ScrollIntoView {
        id: u32,
        #[serde(default)]
        smooth: bool,
    },
    ScrollTo {
        id: u32,
        offset: f32,
        #[serde(default)]
        smooth: bool,
    },
    SetClearColor {
        color: Color,
    },
    SetSplit {
        fraction: Option<f32>,
    },
    AddView {},
    SetPane {
        #[serde(default = "default_pane_slot")]
        slot: usize,
        view: usize,
    },
    SetInspectMode {
        on: bool,
        #[serde(default)]
        view: usize,
    },
    SetDefaultMenu {
        on: bool,
    },
    Highlight {
        view: usize,
        id: Option<u32>,
        #[serde(default)]
        area: Option<String>,
    },
    QueryLayout {},
    ProfileStart {},
    ProfileStop {},
    SetCpuThrottle {
        rate: f32,
    },
    RegisterFont {
        path: String,
    },
    SetKeyCapture {
        keys: Vec<String>,
    },
    SetPointerShape {
        shape: String,
    },
    InputSplice {
        id: u32,
        start: usize,
        end: usize,
        text: String,
    },
    InputSelectAll {
        id: u32,
    },
    InsertMark {
        id: u32,
        mark: u64,
        #[serde(default)]
        offset: Option<usize>,
    },
    RemoveMark {
        id: u32,
        mark: u64,
    },
    RichClipboard {
        token: u64,
        marks: Vec<RichClipMarkDto>,
    },
    RequestClipboardImage {},
    SetClipboard {
        text: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RichClipMarkDto {
    index: usize,
    data: String,
}

fn register_font(engine: &mut Engine, path: &str) -> String {
    let loaded = std::fs::read(path).map_err(|e| e.to_string()).and_then(|bytes| {
        pixel_core::fontdue::Font::from_bytes(bytes, pixel_core::fontdue::FontSettings::default())
            .map_err(str::to_string)
    });
    match loaded {
        Ok(font) => {
            let index = engine.add_font(font);
            serde_json::json!({ "type": "fontRegistered", "path": path, "font": index })
        }
        Err(error) => {
            serde_json::json!({ "type": "fontRegistered", "path": path, "error": error })
        }
    }
    .to_string()
}

fn default_pane_slot() -> usize {
    1
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(default)]
    view: usize,
    #[serde(default)]
    seq: Option<u64>,
    // we want to use slices instead of Value trees since batches can hold tens of thousands of ops 
    #[serde(borrow)]
    ops: Vec<&'a serde_json::value::RawValue>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct PropsDto {
    style: StyleDto,
    text: Option<String>,
    key: Option<String>,
    clickable: bool,
    hidden: bool,
    input: Option<InputDto>,
    image: Option<ImageDto>,
    surface: Option<u32>,
    slot: Option<String>,
    mark: Option<u64>,
    marks: Vec<MarkInitDto>,
    content_height: Option<f32>,
    shape: Option<ShapeDto>,
    scroll_events: bool,
    wheel_events: bool,
    pointer_events: bool,
    hover_events: bool,
    outside_click_events: bool,
    drag_events: bool,
    selection_events: bool,
    move_events: bool,
    spans: Vec<SpanDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StrokeDto {
    width: f32,
    color: Color,
    #[serde(default)]
    cap: Option<String>,
    #[serde(default)]
    join: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapeDto {
    d: String,
    stroke: StrokeDto,
    #[serde(default)]
    view_box: Option<f32>,
}

impl ShapeDto {
    fn into_props(self) -> ShapeProps {
        ShapeProps {
            cmds: parse_path_data(&self.d),
            view_box: self.view_box,
            stroke: ShapeStroke {
                width: self.stroke.width,
                color: self.stroke.color,
                cap: match self.stroke.cap.as_deref() {
                    Some("butt") => LineCap::Butt,
                    Some("square") => LineCap::Square,
                    _ => LineCap::Round,
                },
                join: match self.stroke.join.as_deref() {
                    Some("miter") => LineJoin::Miter,
                    Some("bevel") => LineJoin::Bevel,
                    _ => LineJoin::Round,
                },
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpanDto {
    start: usize,
    end: usize,
    color: Color,
    #[serde(default)]
    background: Option<Color>,
    #[serde(default)]
    bold: bool,
    #[serde(default)]
    italic: bool,
    #[serde(default)]
    underline: bool,
    #[serde(default)]
    strikethrough: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageDto {
    src: String,
    #[serde(default)]
    confirmed_equal_to: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct InputDto {
    initial: String,
    value: Option<String>,
    marks: Vec<MarkInitDto>,
    caret_color: Option<Color>,
    selection_color: Option<Color>,
    auto_focus: bool,
    submit: bool,
    gutter: Option<GutterDto>,
    active_line: Option<Color>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GutterDto {
    color: Color,
    active_color: Color,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkInitDto {
    id: u64,
    offset: usize,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum DimensionDto {
    Px(f32),
    Named(String),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum EdgesDto {
    All(f32),
    Sides {
        #[serde(default)]
        left: f32,
        #[serde(default)]
        right: f32,
        #[serde(default)]
        top: f32,
        #[serde(default)]
        bottom: f32,
    },
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct InsetDto {
    left: Option<DimensionDto>,
    top: Option<DimensionDto>,
    right: Option<DimensionDto>,
    bottom: Option<DimensionDto>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum BorderDto {
    Uniform {
        width: f32,
        color: Color,
    },
    Sides {
        #[serde(default)]
        top: Option<(f32, Color)>,
        #[serde(default)]
        right: Option<(f32, Color)>,
        #[serde(default)]
        bottom: Option<(f32, Color)>,
        #[serde(default)]
        left: Option<(f32, Color)>,
    },
}

impl BorderDto {
    fn into_border(self) -> Border {
        let side = |s: Option<(f32, Color)>| s.map(|(width, color)| BorderSide { width, color });
        match self {
            BorderDto::Uniform { width, color } => Border::all(width, color),
            BorderDto::Sides {
                top,
                right,
                bottom,
                left,
            } => Border {
                top: side(top),
                right: side(right),
                bottom: side(bottom),
                left: side(left),
            },
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ScrollbarDto {
    width: Option<f32>,
    hover_width: Option<f32>,
    margin: Option<f32>,
    min_thumb: Option<f32>,
    thumb_color: Option<Color>,
    thumb_hover_color: Option<Color>,
    track_color: Option<Color>,
}

impl ScrollbarDto {
    fn into_style(self, rem: f32) -> ScrollbarStyle {
        let defaults = ScrollbarStyle::for_rem(rem);
        ScrollbarStyle {
            width: self.width.unwrap_or(defaults.width),
            hover_width: self.hover_width.unwrap_or(defaults.hover_width),
            margin: self.margin.unwrap_or(defaults.margin),
            min_thumb: self.min_thumb.unwrap_or(defaults.min_thumb),
            thumb_color: self.thumb_color.unwrap_or(defaults.thumb_color),
            thumb_hover_color: self.thumb_hover_color.unwrap_or(defaults.thumb_hover_color),
            track_color: self.track_color.unwrap_or(defaults.track_color),
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CornerRadiusDto {
    Uniform(f32),
    #[serde(rename_all = "camelCase")]
    PerCorner {
        #[serde(default)]
        top_left: f32,
        #[serde(default)]
        top_right: f32,
        #[serde(default)]
        bottom_right: f32,
        #[serde(default)]
        bottom_left: f32,
    },
}

impl CornerRadiusDto {
    fn into_radii(self) -> [f32; 4] {
        match self {
            Self::Uniform(v) => [v; 4],
            Self::PerCorner {
                top_left,
                top_right,
                bottom_right,
                bottom_left,
            } => [top_left, top_right, bottom_right, bottom_left],
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct StyleDto {
    flex_direction: Option<String>,
    flex_grow: Option<f32>,
    flex_shrink: Option<f32>,
    flex_basis: Option<DimensionDto>,
    width: Option<DimensionDto>,
    height: Option<DimensionDto>,
    max_width: Option<DimensionDto>,
    max_height: Option<DimensionDto>,
    padding: Option<EdgesDto>,
    margin: Option<EdgesDto>,
    gap: Option<f32>,
    position: Option<String>,
    inset: Option<InsetDto>,
    overflow: Option<String>,
    justify_content: Option<String>,
    align_items: Option<String>,
    background: Option<Color>,
    corner_radius: Option<CornerRadiusDto>,
    border: Option<BorderDto>,
    color: Option<Color>,
    font_size: Option<f32>,
    font: Option<usize>,
    hover_background: Option<Color>,
    hover_color: Option<Color>,
    scrollbar: Option<ScrollbarDto>,
    wrap: Option<bool>,
    selectable: Option<bool>,
    selection_color: Option<Color>,
    selection_mode: Option<String>,
}

fn dimension(dto: Option<DimensionDto>) -> Dimension {
    match dto {
        None => Dimension::Auto,
        Some(DimensionDto::Px(v)) => Dimension::Px(v),
        Some(DimensionDto::Named(s)) => match s.strip_suffix('%') {
            Some(pct) => pct
                .parse::<f32>()
                .map_or(Dimension::Auto, |v| Dimension::Percent(v / 100.0)),
            None => Dimension::Auto,
        },
    }
}

fn inset_value(dto: Option<DimensionDto>) -> Option<InsetValue> {
    match dto? {
        DimensionDto::Px(v) => Some(InsetValue::Px(v)),
        DimensionDto::Named(s) => {
            let pct = s.strip_suffix('%')?.parse::<f32>().ok()?;
            Some(InsetValue::Percent(pct / 100.0))
        }
    }
}

fn edges(dto: Option<EdgesDto>) -> Edges {
    match dto {
        None => Edges::default(),
        Some(EdgesDto::All(v)) => Edges::all(v),
        Some(EdgesDto::Sides {
            left,
            right,
            top,
            bottom,
        }) => Edges {
            left,
            right,
            top,
            bottom,
        },
    }
}

impl StyleDto {
    fn into_style(self, rem: f32) -> Style {
        Style {
            flex_direction: match self.flex_direction.as_deref() {
                Some("column") => FlexDirection::Column,
                _ => FlexDirection::Row,
            },
            flex_grow: self.flex_grow.unwrap_or(0.0),
            flex_shrink: self.flex_shrink.unwrap_or(1.0),
            flex_basis: dimension(self.flex_basis),
            width: dimension(self.width),
            height: dimension(self.height),
            max_width: dimension(self.max_width),
            max_height: dimension(self.max_height),
            padding: edges(self.padding),
            margin: edges(self.margin),
            gap: self.gap.unwrap_or(0.0),
            position: match self.position.as_deref() {
                Some("absolute") => Position::Absolute,
                _ => Position::Flow,
            },
            inset: self.inset.map_or(Inset::default(), |i| Inset {
                left: inset_value(i.left),
                top: inset_value(i.top),
                right: inset_value(i.right),
                bottom: inset_value(i.bottom),
            }),
            overflow: match self.overflow.as_deref() {
                Some("hidden") => Overflow::Hidden,
                Some("scroll") => Overflow::Scroll,
                _ => Overflow::Visible,
            },
            justify_content: self.justify_content.as_deref().and_then(|j| match j {
                "start" => Some(Justify::Start),
                "center" => Some(Justify::Center),
                "end" => Some(Justify::End),
                "space-between" => Some(Justify::SpaceBetween),
                _ => None,
            }),
            align_items: self.align_items.as_deref().and_then(|a| match a {
                "start" => Some(Align::Start),
                "center" => Some(Align::Center),
                "end" => Some(Align::End),
                "stretch" => Some(Align::Stretch),
                _ => None,
            }),
            background: self.background,
            corner_radius: self.corner_radius.map_or([0.0; 4], CornerRadiusDto::into_radii),
            border: self.border.map(BorderDto::into_border),
            color: self.color,
            font_size: self.font_size,
            font: self.font,
            hover_background: self.hover_background,
            hover_color: self.hover_color,
            scrollbar: self.scrollbar.map(|s| s.into_style(rem)),
            wrap: self.wrap.unwrap_or(true),
            selectable: self.selectable,
            selection_color: self.selection_color,
            selection_mode: match self.selection_mode.as_deref() {
                Some("unified") => SelectionMode::Unified,
                _ => SelectionMode::Text,
            },
        }
    }
}

impl PropsDto {
    fn into_props(self, rem: f32) -> Props {
        Props {
            style: self.style.into_style(rem),
            text: self.text,
            key: self.key,
            clickable: self.clickable,
            hidden: self.hidden,
            input: self.input.map(|i| {
                let defaults = InputProps::default();
                InputProps {
                    initial: i.initial,
                    value: i.value,
                    marks: i.marks.iter().map(|m| (m.id, m.offset)).collect(),
                    caret_color: i.caret_color.unwrap_or(defaults.caret_color),
                    selection_color: i.selection_color.unwrap_or(defaults.selection_color),
                    auto_focus: i.auto_focus,
                    submit: i.submit,
                    gutter: i.gutter.map(|g| Gutter {
                        color: g.color,
                        active_color: g.active_color,
                    }),
                    active_line: i.active_line,
                }
            }),
            image: self.image.map(|i| ImageProps {
                src: i.src,
                equal_to: i.confirmed_equal_to,
            }),
            surface: self.surface,
            slot: match self.slot.as_deref() {
                Some("placeholder") => Some(SlotKind::Placeholder),
                Some("error") => Some(SlotKind::Error),
                _ => None,
            },
            mark: self.mark,
            marks: self.marks.iter().map(|m| (m.id, m.offset)).collect(),
            content_height: self.content_height,
            shape: self.shape.map(ShapeDto::into_props),
            scroll_events: self.scroll_events,
            wheel_events: self.wheel_events,
            pointer_events: self.pointer_events,
            hover_events: self.hover_events,
            outside_click_events: self.outside_click_events,
            drag_events: self.drag_events,
            selection_events: self.selection_events,
            move_events: self.move_events,
            spans: self
                .spans
                .into_iter()
                .map(|s| TextSpan {
                    start: s.start,
                    end: s.end,
                    color: s.color,
                    background: s.background,
                    bold: s.bold,
                    italic: s.italic,
                    underline: s.underline,
                    strikethrough: s.strikethrough,
                })
                .collect(),
        }
    }
}

pub struct OpOutcome {
    pub replies: Vec<String>,
    pub error: Option<String>,
}

pub fn apply_ops(engine: &mut Engine, ids: &mut Vec<IdMap>, json: &str) -> OpOutcome {
    let envelope: Envelope<'_> = match serde_json::from_str(json) {
        Ok(envelope) => envelope,
        Err(e) => {
            return OpOutcome {
                replies: Vec::new(),
                error: Some(e.to_string()),
            };
        }
    };
    let view = envelope.view.min(ids.len() - 1);
    let mut errors = Vec::new();
    let mut replies = Vec::new();
    pixel_core::profiler::span_arg("ops.apply", envelope.seq, || {
        for raw in envelope.ops {
            let op: Op = match serde_json::from_str(raw.get()) {
                Ok(op) => op,
                Err(e) => {
                    errors.push(e.to_string());
                    continue;
                }
            };
            apply_op(engine, ids, view, op, &mut replies);
        }
    });
    let error = if errors.is_empty() {
        None
    } else {
        Some(errors.join("; "))
    };
    OpOutcome { replies, error }
}

fn apply_op(
    engine: &mut Engine,
    ids: &mut Vec<IdMap>,
    view: usize,
    op: Op,
    replies: &mut Vec<String>,
) {
    if let Op::AddView {} = op {
        let new_view = engine.add_view();
        let root = engine.comp.views[new_view].tree.root();
        ids.push(IdMap::new(root));
        let reply = serde_json::json!({ "type": "viewCreated", "view": new_view });
        replies.push(reply.to_string());
        return;
    }
    if let Op::RegisterFont { path } = op {
        replies.push(register_font(engine, &path));
        return;
    }
    let base_px = engine.base_px;
    let map = &mut ids[view];
    let Some(tree) = engine.comp.views.get_mut(view).map(|v| &mut v.tree) else {
        return;
    };
    match op {
        Op::Create { id, props } => {
            let node = tree.create(props.into_props(base_px));
            map.insert(id, node);
        }
        Op::InsertBefore {
            parent,
            child,
            before,
        } => {
            let (Some(parent), Some(child)) = (map.node(parent), map.node(child)) else {
                return;
            };
            let before = before.and_then(|b| map.node(b));
            tree.insert_before(parent, child, before);
        }
        Op::Remove { id } => {
            if let Some(node) = map.node(id) {
                tree.remove(node);
            }
            map.forget(id);
        }
        Op::Forget { id } => map.forget(id),
        Op::Update { id, props } => {
            if let Some(node) = map.node(id) {
                let props = props.into_props(base_px);
                tree.update(node, props);
            }
        }
        Op::Clear { id } => {
            if let Some(node) = map.node(id) {
                tree.remove_children(node);
            }
        }
        Op::Focus { id } => {
            let node = id.and_then(|id| map.node(id));
            engine.set_focus(view, node);
        }
        Op::ScrollTo { id, offset, smooth } => {
            if let Some(node) = map.node(id) {
                engine.scroll_to(view, node, offset, smooth);
            }
        }
        Op::ScrollIntoView { id, smooth } => {
            if let Some(node) = map.node(id) {
                engine.scroll_into_view(view, node, smooth);
            }
        }
        Op::SetClearColor { color } => engine.set_clear_color(view, color),
        Op::SetSplit { fraction } => engine.set_split(fraction),
        Op::AddView {} => unreachable!("handled before the per-view bindings"),
        Op::SetPane { slot, view } => engine.set_pane(slot, view),
        Op::SetInspectMode { on, view } => {
            engine.set_inspect_view(view);
            engine.set_inspect_mode(on);
        }
        Op::SetDefaultMenu { on } => engine.set_default_menu(on),
        Op::Highlight {
            view: target_view,
            id,
            area,
        } => {
            let area = match area.as_deref() {
                Some("content") => HighlightArea::Content,
                Some("padding") => HighlightArea::Padding,
                Some("border") => HighlightArea::Border,
                Some("margin") => HighlightArea::Margin,
                _ => HighlightArea::All,
            };
            let target = id.and_then(|id| {
                ids.get(target_view)
                    .and_then(|m| m.node(id))
                    .map(|node| (target_view, node, area))
            });
            engine.set_highlight(target);
        }
        Op::QueryLayout {} => {
            engine.flush_view_layout(view);
            replies.push(layout_json(engine, &ids[view], view));
        }
        Op::ProfileStart {} => engine.profile_start(),
        Op::ProfileStop {} => engine.profile_stop(),
        Op::SetCpuThrottle { rate } => engine.set_cpu_throttle(rate),
        Op::RegisterFont { .. } => unreachable!("handled before the per-view bindings"),
        Op::SetKeyCapture { keys } => engine.key_capture = keys,
        Op::SetPointerShape { shape } => {
            let _ = engine.term.set_pointer_shape(&shape);
        }
        Op::InputSplice {
            id,
            start,
            end,
            text,
        } => {
            if let Some(node) = map.node(id) {
                engine.splice_input(view, node, start, end, &text);
            }
        }
        Op::InputSelectAll { id } => {
            if let Some(node) = map.node(id) {
                engine.select_all_input(view, node);
            }
        }
        Op::InsertMark { id, mark, offset } => {
            if let Some(node) = map.node(id) {
                engine.insert_input_mark(view, node, mark, offset);
            }
        }
        Op::RemoveMark { id, mark } => {
            if let Some(node) = map.node(id) {
                engine.remove_input_mark(view, node, mark);
            }
        }
        Op::RichClipboard { token, marks } => {
            engine.attach_rich_clipboard(
                token,
                marks.into_iter().map(|m| (m.index, m.data)).collect(),
            );
        }
        Op::RequestClipboardImage {} => engine.request_clipboard_image(view),
        Op::SetClipboard { text } => engine.set_clipboard(&text),
    }
}

fn layout_json(engine: &Engine, ids: &IdMap, view: usize) -> String {
    use serde_json::json;
    let mut nodes = Vec::new();
    if let Some(tree) = engine.comp.views.get(view).map(|v| &v.tree) {
        let mut stack = vec![tree.root()];
        while let Some(id) = stack.pop() {
            for &child in tree.children(id) {
                stack.push(child);
            }
            let Some(ext) = ids.ext(id) else {
                continue;
            };
            let Some(rect) = tree.rect(id) else {
                continue;
            };
            let visible = tree.visible_rect(id).unwrap_or(rect);
            let mut node = json!({
                "id": ext,
                "x": rect.x,
                "y": rect.y,
                "w": rect.w,
                "h": rect.h,
                "vw": visible.w,
                "vh": visible.h,
            });
            if let Some(state) = tree.scroll_state(id) {
                let max = tree.scroll_max(id);
                if max > 0.0 {
                    node["scroll"] = json!(state.position);
                    node["scrollMax"] = json!(max);
                }
            }
            if let Some(text) = tree.text_of(id) {
                node["text"] = json!(text.chars().take(120).collect::<String>());
            }
            if let Some(metrics) = tree.box_metrics(id) {
                let edges = |e: Edges| json!({ "l": e.left, "t": e.top, "r": e.right, "b": e.bottom });
                if metrics.padding != Edges::default() {
                    node["padding"] = edges(metrics.padding);
                }
                if metrics.border != Edges::default() {
                    node["border"] = edges(metrics.border);
                }
                if metrics.margin != Edges::default() {
                    node["margin"] = edges(metrics.margin);
                }
            }
            nodes.push(node);
        }
    }
    let stats = engine.stats;
    let size = engine.comp.views.get(view).map_or((0, 0), |v| v.size);
    json!({
        "type": "layout",
        "view": view,
        "width": size.0,
        "height": size.1,
        "split": engine.comp.split,
        "stats": { "frameMs": stats.frame_ms, "fps": stats.fps },
        "nodes": nodes,
    })
    .to_string()
}

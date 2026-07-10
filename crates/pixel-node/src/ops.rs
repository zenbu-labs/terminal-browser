use std::collections::HashMap;

use pixel_core::{
    Align, Border, Color, Dimension, Edges, Engine, FlexDirection, InputProps, Inset, Justify,
    NodeId, Overflow, Position, Props, ScrollbarStyle, Style,
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
    SetInspectMode {
        on: bool,
    },
    SetDefaultMenu {
        on: bool,
    },
    Highlight {
        view: usize,
        id: Option<u32>,
    },
    QueryLayout {},
    ProfileStart {},
    ProfileStop {},
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    view: usize,
    #[serde(default)]
    seq: Option<u64>,
    ops: Vec<serde_json::Value>,
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
    content_height: Option<f32>,
    scroll_events: bool,
    wheel_events: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct InputDto {
    initial: String,
    value: Option<String>,
    caret_color: Option<Color>,
    selection_color: Option<Color>,
    auto_focus: bool,
    submit: bool,
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
    left: Option<f32>,
    top: Option<f32>,
    right: Option<f32>,
    bottom: Option<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BorderDto {
    width: f32,
    color: Color,
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

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct StyleDto {
    flex_direction: Option<String>,
    flex_grow: Option<f32>,
    flex_shrink: Option<f32>,
    flex_basis: Option<DimensionDto>,
    width: Option<DimensionDto>,
    height: Option<DimensionDto>,
    padding: Option<EdgesDto>,
    margin: Option<EdgesDto>,
    gap: Option<f32>,
    position: Option<String>,
    inset: Option<InsetDto>,
    overflow: Option<String>,
    justify_content: Option<String>,
    align_items: Option<String>,
    background: Option<Color>,
    corner_radius: Option<f32>,
    border: Option<BorderDto>,
    color: Option<Color>,
    font_size: Option<f32>,
    font: Option<usize>,
    hover_background: Option<Color>,
    hover_color: Option<Color>,
    scrollbar: Option<ScrollbarDto>,
    wrap: Option<bool>,
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
            padding: edges(self.padding),
            margin: edges(self.margin),
            gap: self.gap.unwrap_or(0.0),
            position: match self.position.as_deref() {
                Some("absolute") => Position::Absolute,
                _ => Position::Flow,
            },
            inset: self.inset.map_or(Inset::default(), |i| Inset {
                left: i.left,
                top: i.top,
                right: i.right,
                bottom: i.bottom,
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
            corner_radius: self.corner_radius.unwrap_or(0.0),
            border: self.border.map(|b| Border {
                width: b.width,
                color: b.color,
            }),
            color: self.color,
            font_size: self.font_size,
            font: self.font,
            hover_background: self.hover_background,
            hover_color: self.hover_color,
            scrollbar: self.scrollbar.map(|s| s.into_style(rem)),
            wrap: self.wrap.unwrap_or(true),
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
                    caret_color: i.caret_color.unwrap_or(defaults.caret_color),
                    selection_color: i.selection_color.unwrap_or(defaults.selection_color),
                    auto_focus: i.auto_focus,
                    submit: i.submit,
                }
            }),
            content_height: self.content_height,
            scroll_events: self.scroll_events,
            wheel_events: self.wheel_events,
        }
    }
}

pub struct OpOutcome {
    pub replies: Vec<String>,
    pub error: Option<String>,
}

pub fn apply_ops(engine: &mut Engine, ids: &mut [IdMap], json: &str) -> OpOutcome {
    let envelope: Envelope = match serde_json::from_str(json) {
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
        for value in envelope.ops {
            let op: Op = match serde_json::from_value(value) {
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
    ids: &mut [IdMap],
    view: usize,
    op: Op,
    replies: &mut Vec<String>,
) {
    let base_px = engine.base_px();
    let map = &mut ids[view];
    let Some(tree) = engine.view_tree_mut(view) else {
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
        Op::SetClearColor { color } => engine.set_clear_color(view, color),
        Op::SetSplit { fraction } => engine.set_split(fraction),
        Op::SetInspectMode { on } => engine.set_inspect_mode(on),
        Op::SetDefaultMenu { on } => engine.set_default_menu(on),
        Op::Highlight {
            view: target_view,
            id,
        } => {
            let target = id.and_then(|id| {
                ids.get(target_view)
                    .and_then(|m| m.node(id))
                    .map(|node| (target_view, node))
            });
            engine.set_highlight(target);
        }
        Op::QueryLayout {} => {
            engine.flush_view_layout(view);
            replies.push(layout_json(engine, &ids[view], view));
        }
        Op::ProfileStart {} => engine.profile_start(),
        Op::ProfileStop {} => engine.profile_stop(),
    }
}

fn layout_json(engine: &Engine, ids: &IdMap, view: usize) -> String {
    use serde_json::json;
    let mut nodes = Vec::new();
    if let Some(tree) = engine.view_tree(view) {
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
            nodes.push(node);
        }
    }
    let stats = engine.stats();
    json!({
        "type": "layout",
        "view": view,
        "width": engine.view_size(view).0,
        "height": engine.view_size(view).1,
        "split": engine.split(),
        "stats": { "frameMs": stats.frame_ms, "fps": stats.fps },
        "nodes": nodes,
    })
    .to_string()
}

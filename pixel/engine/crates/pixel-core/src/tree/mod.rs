mod layout;
mod text_layout;

pub use text_layout::{TextLayout, TextLeaf, TextLine};

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use taffy::TaffyTree;
use taffy::prelude::TaffyMaxContent as _;

use layout::{MeasureCtx, to_taffy};

use crate::image_cache::ImageStatus;
use crate::shape::ShapeProps;
use crate::scroll::ScrollState;
use crate::scrollbar::{self, BarState, ScrollbarRects};
use crate::selection::{DocLayout, DocSelection, DocSelectionState};
use crate::style::{
    Color, DEFAULT_SELECTION_COLOR, Dimension, Edges, FlexDirection, InsetValue, Layout, Overflow,
    Position, ScrollAnchor, ScrollbarStyle, SelectionMode, Style,
};
use crate::text_input::{
    CaretShape, Granularity, InputGeometry, TextInput, line_height, offset_to_point,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId {
    index: u32,
    generation: u32,
}

impl NodeId {
    pub fn to_bits(self) -> u64 {
        (u64::from(self.generation) << 32) | u64::from(self.index)
    }

    pub fn from_bits(bits: u64) -> Self {
        Self {
            index: (bits & 0xffff_ffff) as u32,
            generation: (bits >> 32) as u32,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PxRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl PxRect {
    pub const ZERO: PxRect = PxRect {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    };

    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }

    pub fn intersect(&self, other: PxRect) -> PxRect {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        PxRect {
            x,
            y,
            w: ((self.x + self.w).min(other.x + other.w) - x).max(0.0),
            h: ((self.y + self.h).min(other.y + other.h) - y).max(0.0),
        }
    }
    pub fn intersects(&self, other: PxRect) -> bool {
        let cut = self.intersect(other);
        cut.w > 0.0 && cut.h > 0.0
    }

    fn is_empty(&self) -> bool {
        self.w <= 0.0 || self.h <= 0.0
    }

    fn union(self, other: PxRect) -> PxRect {
        if other.is_empty() {
            return self;
        }
        if self.is_empty() {
            return other;
        }
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        PxRect {
            x,
            y,
            w: (self.x + self.w).max(other.x + other.w) - x,
            h: (self.y + self.h).max(other.y + other.h) - y,
        }
    }

    fn offset(self, dx: f32, dy: f32) -> PxRect {
        PxRect { x: self.x + dx, y: self.y + dy, ..self }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BoxMetrics {
    pub padding: Edges,
    pub border: Edges,
    pub margin: Edges,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitTarget {
    Input(NodeId),
    Click(NodeId),
    Text(NodeId),
}

pub struct SelectionSnapshot {
    pub scope: NodeId,
    pub text: String,
    pub rect: PxRect,
    pub parts: Vec<(String, std::ops::Range<usize>)>,
}

#[derive(Debug, Clone, Copy)]
pub struct ScrollArea {
    pub node: NodeId,
    pub rect: PxRect,
    pub content_height: f32,
    pub offset: f32,
}

impl ScrollArea {
    pub fn max_scroll(&self) -> f32 {
        (self.content_height - self.rect.h).max(0.0)
    }

    pub fn target_to_reveal(&self, rect: PxRect, current: f32, margin: f32) -> Option<f32> {
        let top = rect.y - self.rect.y + self.offset - margin;
        let bottom = top + rect.h + 2.0 * margin;
        if top < current {
            Some(top.max(0.0))
        } else if bottom > current + self.rect.h {
            Some(bottom - self.rect.h)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct InputProps {
    pub initial: String,
    pub value: Option<String>,
    pub marks: Vec<(u64, usize)>,
    pub caret_color: Color,
    pub caret_shape: CaretShape,
    pub selection_color: Color,
    pub auto_focus: bool,
    pub submit: bool,
    pub gutter: Option<Gutter>,
    pub active_line: Option<Color>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gutter {
    pub color: Color,
    pub active_color: Color,
}

impl Default for InputProps {
    fn default() -> Self {
        Self {
            initial: String::new(),
            value: None,
            marks: Vec::new(),
            caret_color: [255, 255, 255, 255],
            caret_shape: CaretShape::Bar,
            selection_color: [90, 90, 140, 255],
            auto_focus: false,
            submit: false,
            gutter: None,
            active_line: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageProps {
    pub src: String,
    pub equal_to: Vec<String>,
    pub glyph: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    Placeholder,
    Error,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TextSpan {
    pub start: usize,
    pub end: usize,
    pub color: Color,
    pub background: Option<Color>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Props {
    pub style: Style,
    pub text: Option<String>,
    pub key: Option<String>,
    pub clickable: bool,
    pub hidden: bool,
    pub input: Option<InputProps>,
    pub image: Option<ImageProps>,
    pub surface: Option<u32>,
    pub slot: Option<SlotKind>,
    pub mark: Option<u64>,
    pub marks: Vec<(u64, usize)>,
    pub content_height: Option<f32>,
    pub shape: Option<ShapeProps>,
    pub scroll_events: bool,
    pub stick_events: bool,
    pub wheel_events: bool,
    pub pointer_events: bool,
    pub hover_events: bool,
    pub outside_click_events: bool,
    pub modal: bool,
    pub drag_events: bool,
    pub selection_events: bool,
    pub move_events: bool,
    pub spans: Vec<TextSpan>,
}

pub(crate) struct InputState {
    pub input: TextInput,
    pub caret_color: Color,
    pub caret_shape: CaretShape,
    pub selection_color: Color,
    pub submit: bool,
    pub gutter: Option<Gutter>,
    pub active_line: Option<Color>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Resolved {
    pub color: Color,
    pub px: f32,
    pub families: usize,
    pub weight: u16,
    pub italic: bool,
    pub font: usize,
    pub font_id: usize,
    pub selectable: bool,
    pub selection_color: Color,
}

pub(crate) struct RNode {
    pub style: Style,
    pub text: Option<String>,
    pub key: Option<String>,
    pub clickable: bool,
    // eh?
    pub hidden: bool,
    pub input: Option<InputState>,
    pub image: Option<ImageProps>,
    pub surface: Option<u32>,
    pub slot: Option<SlotKind>,
    pub slot_visible: bool,
    pub mark: Option<u64>,
    pub mark_visible: bool,
    // review me: i dont remember what static marks are for
    pub static_marks: Vec<crate::text_input::Mark>,
    pub parent: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub taffy: taffy::NodeId,
    pub scroll: ScrollState,
    pub scroll_max: f32,
    pub content_height: Option<f32>,
    pub shape: Option<ShapeProps>,
    pub scroll_events: bool,
    pub wheel_events: bool,
    pub pointer_events: bool,
    pub hover_events: bool,
    pub outside_click_events: bool,
    pub modal: bool,
    pub drag_events: bool,
    pub selection_events: bool,
    pub move_events: bool,
    pub spans: Vec<TextSpan>,
    pub last_scroll_emit: f32,
    pub bar: BarState,
    pub resolved: Resolved,
    pub abs: PxRect,
    pub visible: PxRect,
    pub extent: PxRect,
    pub offscreen: bool,
    pub list_y: f32,
    pub measured_width: f32,
    pub list_height: f32,
    list_width: f32,
    pub row_estimate: f32,
    pub placed_rows: std::ops::Range<usize>,
    pub stick_events: bool,
    pub stuck: bool,
    pub order: u32,
    pub text_offset_y: f32,
}

struct Slot {
    generation: u32,
    node: Option<RNode>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub abs: PxRect,
    pub visible: PxRect,
    pub offscreen: bool,
    pub stuck: bool,
}

fn snap(raw: PxRect, (x, y): (f32, f32), paints: bool) -> PxRect {
    if (x, y) == (1.0, 1.0) {
        return raw;
    }
    let edges = |start: f32, size: f32, unit: f32| {
        let from = (start / unit).round() * unit;
        let mut to = ((start + size) / unit).round() * unit;
        if paints && size > 0.0 && to <= from {
            to = from + unit;
        }
        (from, to - from)
    };
    let (left, w) = edges(raw.x, raw.w, x);
    let (top, h) = edges(raw.y, raw.h, y);
    PxRect { x: left, y: top, w, h }
}

impl RNode {
    fn paints(&self) -> bool {
        let background = match &self.style.background {
            Some(crate::style::Paint::Solid(color)) => color[3] > 0,
            Some(crate::style::Paint::Gradient(_)) => true,
            None => false,
        };
        let border = self.style.border.is_some_and(|b| [b.top, b.right, b.bottom, b.left].iter().flatten().any(|s| s.width > 0.0 && s.color[3] > 0));
        background || border || self.text.is_some() || self.image.is_some() || self.shape.is_some() || self.surface.is_some() || self.input.is_some()
    }

    fn cell_caret(&self) -> bool {
        self.input.as_ref().is_some_and(|state| state.caret_shape != CaretShape::Bar)
    }

    pub(crate) fn marks(&self) -> &[crate::text_input::Mark] {
        match &self.input {
            Some(state) => state.input.marks(),
            None => &self.static_marks,
        }
    }

    fn placed_children(&self) -> &[NodeId] {
        if self.style.layout == Layout::List {
            &self.children[self.placed_rows.start.min(self.children.len())..self.placed_rows.end.min(self.children.len())]
        } else {
            &self.children
        }
    }
}

pub struct Tree {
    slots: Vec<Slot>,
    free: Vec<u32>,
    root: NodeId,
    pub(crate) taffy: TaffyTree<MeasureCtx>,
    keys: HashMap<String, NodeId>,
    children_dirty: HashSet<NodeId>,
    lists_changed: HashSet<NodeId>,
    image_slot_parents: HashSet<NodeId>,
    mark_parents: HashSet<NodeId>,
    restyled: HashSet<NodeId>,
    reshaped: HashSet<NodeId>,
    touched: HashSet<NodeId>,
    resolve_all: bool,
    full_place: bool,
    order_stale: bool,
    paint_order: Vec<NodeId>,
    modal: Option<NodeId>,
    modals: HashSet<NodeId>,
    scrollables: HashSet<NodeId>,
    lists: HashSet<NodeId>,
    pending_lists: HashSet<NodeId>,
    stick_changes: Vec<(NodeId, bool)>,
    focus: Option<NodeId>,
    doc: DocSelectionState,
    base_px: f32,
    lattice: (f32, f32),
    needs_layout: bool,
    needs_place: bool,
    needs_paint: bool,
    changed_surfaces: Vec<u32>,
}

pub(crate) const DEFAULT_RESOLVED: Resolved = Resolved {
    color: [255, 255, 255, 255],
    px: 16.0,
    families: crate::fonts::DEFAULT_FAMILIES,
    weight: crate::fonts::REGULAR,
    italic: false,
    font: 0,
    font_id: usize::MAX,
    selectable: true,
    selection_color: DEFAULT_SELECTION_COLOR,
};

const LOOK_AHEAD_BUDGET: std::time::Duration = std::time::Duration::from_millis(2);
const RESERVED_NODES: usize = 1 << 20;

impl Tree {
    pub fn new(window: (f32, f32)) -> Self {
        let mut tree = Self {
            slots: Vec::with_capacity(RESERVED_NODES),
            free: Vec::new(),
            root: NodeId {
                index: 0,
                generation: 0,
            },
            taffy: TaffyTree::with_capacity(RESERVED_NODES),
            keys: HashMap::new(),
            children_dirty: HashSet::new(),
            lists_changed: HashSet::new(),
            image_slot_parents: HashSet::new(),
            mark_parents: HashSet::new(),
            restyled: HashSet::new(),
            reshaped: HashSet::new(),
            touched: HashSet::new(),
            resolve_all: true,
            full_place: true,
            order_stale: true,
            paint_order: Vec::new(),
            modal: None,
            modals: HashSet::new(),
            scrollables: HashSet::new(),
            lists: HashSet::new(),
            pending_lists: HashSet::new(),
            stick_changes: Vec::new(),
            focus: None,
            doc: DocSelectionState::default(),
            base_px: 16.0,
            lattice: (1.0, 1.0),
            needs_layout: true,
            needs_place: true,
            needs_paint: true,
            changed_surfaces: Vec::new(),
        };
        let root = tree.create(Props {
            style: Style {
                width: Dimension::Px(window.0),
                height: Dimension::Px(window.1),
                flex_direction: FlexDirection::Column,
                ..Style::default()
            },
            ..Props::default()
        });
        tree.root = root;
        tree
    }

    pub fn root(&self) -> NodeId {
        self.root
    }

    pub fn focus(&self) -> Option<NodeId> {
        self.focus
    }

    pub fn set_focus(&mut self, id: Option<NodeId>) {
        if let Some(id) = id
            && self.get(id).is_none_or(|n| n.input.is_none())
        {
            return;
        }
        if self.focus != id {
            if let Some(prev) = self.focus
                && let Some(input) = self.input_mut(prev)
            {
                input.set_scroll_x(0.0);
            }
            self.focus = id;
            self.needs_paint = true;
        }
    }

    pub fn contains(&self, id: NodeId) -> bool {
        self.get(id).is_some()
    }

    pub(crate) fn get(&self, id: NodeId) -> Option<&RNode> {
        let slot = self.slots.get(id.index as usize)?;
        if slot.generation != id.generation {
            return None;
        }
        slot.node.as_ref()
    }

    pub(crate) fn get_mut(&mut self, id: NodeId) -> Option<&mut RNode> {
        let slot = self.slots.get_mut(id.index as usize)?;
        if slot.generation != id.generation {
            return None;
        }
        slot.node.as_mut()
    }

    fn node(&self, id: NodeId) -> &RNode {
        self.get(id).expect("node id is live")
    }

    fn node_mut(&mut self, id: NodeId) -> &mut RNode {
        self.get_mut(id).expect("node id is live")
    }

    pub fn create(&mut self, props: Props) -> NodeId {
        let modal = props.modal;
        // A node born showing a webview is a swap from nothing, and the presenter needs to
        // hear about it the same way: as changed pixels, since no browser damage will say so.
        if let Some(surface) = props.surface {
            self.changed_surfaces.push(surface);
        }
        let taffy = self
            .taffy
            .new_leaf(to_taffy(&props.style, props.hidden, props.input.is_some(), self.lattice))
            .expect("taffy leaf");
        let (text, static_marks) = match (&props.input, props.text) {
            (Some(input), _) => (Some(input.initial.clone()), Vec::new()),
            (None, Some(text)) if !props.marks.is_empty() => {
                let (text, marks) = crate::text_input::claim_marks(&text, &props.marks);
                (Some(text), marks)
            }
            (None, text) => (text, Vec::new()),
        };
        let node = RNode {
            style: props.style,
            text,
            key: props.key.clone(),
            clickable: props.clickable,
            hidden: props.hidden,
            input: props.input.as_ref().map(|p| {
                let input = TextInput::with_marks(p.initial.clone(), &p.marks);
                InputState {
                    input,
                    caret_color: p.caret_color,
                    caret_shape: p.caret_shape,
                    selection_color: p.selection_color,
                    submit: p.submit,
                    gutter: p.gutter,
                    active_line: p.active_line,
                }
            }),
            image: props.image,
            surface: props.surface,
            slot: props.slot,
            slot_visible: false,
            mark: props.mark,
            mark_visible: false,
            static_marks,
            parent: None,
            children: Vec::new(),
            taffy,
            scroll: ScrollState::default(),
            scroll_max: 0.0,
            content_height: props.content_height,
            shape: props.shape,
            scroll_events: props.scroll_events,
            wheel_events: props.wheel_events,
            pointer_events: props.pointer_events,
            hover_events: props.hover_events,
            outside_click_events: props.outside_click_events,
            modal: props.modal,
            drag_events: props.drag_events,
            selection_events: props.selection_events,
            move_events: props.move_events,
            spans: props.spans,
            last_scroll_emit: 0.0,
            bar: BarState::default(),
            resolved: DEFAULT_RESOLVED,
            abs: PxRect::ZERO,
            visible: PxRect::ZERO,
            extent: PxRect::ZERO,
            offscreen: false,
            list_y: 0.0,
            measured_width: f32::NAN,
            list_height: 0.0,
            list_width: f32::NAN,
            row_estimate: 0.0,
            placed_rows: 0..0,
            stick_events: props.stick_events,
            stuck: false,
            order: 0,
            text_offset_y: 0.0,
        };
        let id = match self.free.pop() {
            Some(index) => {
                let slot = &mut self.slots[index as usize];
                slot.node = Some(node);
                NodeId {
                    index,
                    generation: slot.generation,
                }
            }
            None => {
                self.slots.push(Slot {
                    generation: 0,
                    node: Some(node),
                });
                NodeId {
                    index: (self.slots.len() - 1) as u32,
                    generation: 0,
                }
            }
        };
        if let Some(key) = props.key {
            self.keys.insert(key, id);
        }
        if self.node(id).style.overflow == Overflow::Scroll {
            self.scrollables.insert(id);
        }
        if self.node(id).style.layout == Layout::List {
            self.lists.insert(id);
        }
        if props.input.as_ref().is_some_and(|p| p.auto_focus) {
            self.focus = Some(id);
        }
        self.needs_layout = true;
        if modal {
            self.modals.insert(id);
            self.order_stale = true;
        }
        id
    }

    pub fn insert_before(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        assert!(child != self.root, "the root cannot be re-parented");
        self.detach(child);
        let index = match before {
            Some(before) => self
                .node(parent)
                .children
                .iter()
                .position(|&c| c == before)
                .unwrap_or(self.node(parent).children.len()),
            None => self.node(parent).children.len(),
        };
        self.node_mut(parent).children.insert(index, child);
        self.node_mut(child).parent = Some(parent);
        self.children_dirty.insert(parent);
        self.restyled.insert(child);
        self.reshaped.insert(parent);
        self.order_stale = true;
        self.needs_layout = true;
    }

    pub fn append(&mut self, parent: NodeId, child: NodeId) {
        self.insert_before(parent, child, None);
    }

    fn detach(&mut self, child: NodeId) {
        let Some(parent) = self.node(child).parent else {
            return;
        };
        self.node_mut(parent).children.retain(|&c| c != child);
        self.node_mut(child).parent = None;
        self.children_dirty.insert(parent);
        self.reshaped.insert(parent);
        self.order_stale = true;
    }
    fn sync_dirty_children(&mut self) {
        let dirty: Vec<NodeId> = self.children_dirty.drain().collect();
        for parent in dirty {
            if self.get(parent).is_none() {
                continue;
            }
            let rows_laid_out_alone = self.node(parent).style.layout == Layout::List;
            if rows_laid_out_alone {
                self.lists_changed.insert(parent);
            }
            let ids: Vec<taffy::NodeId> = self
                .node(parent)
                .children
                .iter()
                .filter(|&&c| {
                    let node = self.node(c);
                    !rows_laid_out_alone && node.slot.is_none() && node.mark.is_none()
                })
                .map(|&c| self.node(c).taffy)
                .collect();
            self.taffy
                .set_children(self.node(parent).taffy, &ids)
                .expect("taffy children");
        }
    }

    pub fn remove(&mut self, id: NodeId) {
        assert!(id != self.root, "the root cannot be removed");
        if self.get(id).is_none() {
            return;
        }
        self.detach(id);
        let mut stack = vec![id];
        while let Some(id) = stack.pop() {
            let node = self.node_mut(id);
            stack.append(&mut node.children);
            let taffy = node.taffy;
            let key = node.key.take();
            let slot = &mut self.slots[id.index as usize];
            slot.node = None;
            slot.generation = slot.generation.wrapping_add(1);
            self.free.push(id.index);
            let _ = self.taffy.remove(taffy);
            if let Some(key) = key
                && self.keys.get(&key) == Some(&id)
            {
                self.keys.remove(&key);
            }
            if self.focus == Some(id) {
                self.focus = None;
            }
            self.image_slot_parents.remove(&id);
            self.mark_parents.remove(&id);
            self.scrollables.remove(&id);
            self.lists.remove(&id);
            self.modals.remove(&id);
            if self.modal == Some(id) {
                self.modal = None;
            }
            self.doc.invalidate(id);
        }
        self.needs_layout = true;
    }

    pub fn remove_children(&mut self, id: NodeId) {
        let children = self.node(id).children.clone();
        for child in children {
            self.remove(child);
        }
    }

    pub fn update(&mut self, id: NodeId, props: Props) {
        let controlled_text = props.input.as_ref().and_then(|p| p.value.clone());
        let node = self.node_mut(id);
        let style_changed = node.style != props.style || node.hidden != props.hidden;
        let scrolls = props.style.overflow == Overflow::Scroll;
        let list = props.style.layout == Layout::List;
        let relisted = node.style.layout != props.style.layout;
        let mut changed = style_changed || node.clickable != props.clickable;
        if style_changed {
            let parent = node.parent;
            if list {
                self.lists_changed.insert(id);
            }
            if let Some(parent) = parent.filter(|&p| self.get(p).is_some_and(|n| n.style.layout == Layout::List)) {
                self.lists_changed.insert(parent);
            }
        }
        let node = self.node_mut(id);
        node.style = props.style;
        node.hidden = props.hidden;
        node.clickable = props.clickable;
        node.scroll_events = props.scroll_events;
        node.wheel_events = props.wheel_events;
        node.pointer_events = props.pointer_events;
        node.hover_events = props.hover_events;
        node.outside_click_events = props.outside_click_events;
        let modal_changed = node.modal != props.modal;
        node.modal = props.modal;
        node.drag_events = props.drag_events;
        node.selection_events = props.selection_events;
        node.move_events = props.move_events;
        node.stick_events = props.stick_events;
        let mut place_changed = false;
        if node.shape != props.shape {
            node.shape = props.shape;
            changed = true;
        }
        if node.spans != props.spans {
            node.spans = props.spans;
            changed = true;
        }
        let mut swapped_surface = None;
        let mut image_changed = false;
        if node.image != props.image {
            node.image = props.image;
            changed = true;
            image_changed = true;
        }
        if node.surface != props.surface {
            node.surface = props.surface;
            swapped_surface = props.surface;
            changed = true;
        }
        let slot_changed = node.slot != props.slot;
        if slot_changed {
            node.slot = props.slot;
            changed = true;
        }
        let mark_changed = node.mark != props.mark;
        if mark_changed {
            node.mark = props.mark;
            changed = true;
        }
        if node.content_height != props.content_height {
            node.content_height = props.content_height;
            changed = true;
            place_changed = true;
        }
        if place_changed {
            self.needs_place = true;
            self.full_place = true;
        }
        if modal_changed {
            self.order_stale = true;
            if props.modal {
                self.modals.insert(id);
            } else {
                self.modals.remove(&id);
            }
        }
        if image_changed {
            self.needs_layout = true;
        }
        if slot_changed || mark_changed {
            if let Some(parent) = self.node(id).parent {
                self.children_dirty.insert(parent);
                self.reshaped.insert(parent);
            }
            self.order_stale = true;
            self.needs_layout = true;
        }
        let node = self.node_mut(id);
        let mut input_removed = false;
        let mut caret_reshaped = false;
        match (&mut node.input, props.input) {
            (Some(state), Some(p)) => {
                caret_reshaped = state.caret_shape != p.caret_shape;
                changed |= state.caret_color != p.caret_color
                    || state.caret_shape != p.caret_shape
                    || state.selection_color != p.selection_color
                    || state.gutter != p.gutter
                    || state.active_line != p.active_line;
                state.caret_color = p.caret_color;
                state.caret_shape = p.caret_shape;
                state.selection_color = p.selection_color;
                state.submit = p.submit;
                state.gutter = p.gutter;
                state.active_line = p.active_line;
            }
            (state @ Some(_), None) => {
                *state = None;
                input_removed = true;
                changed = true;
            }
            (state @ None, Some(p)) => {
                let input = TextInput::with_marks(p.initial.clone(), &p.marks);
                *state = Some(InputState {
                    input,
                    caret_color: p.caret_color,
                    caret_shape: p.caret_shape,
                    selection_color: p.selection_color,
                    submit: p.submit,
                    gutter: p.gutter,
                    active_line: p.active_line,
                });
                node.text = Some(p.initial);
                changed = true;
                self.needs_layout = true;
            }
            (None, None) => {}
        }
        if input_removed && self.focus == Some(id) {
            self.focus = None;
        }
        if caret_reshaped {
            self.refresh_input_measure(id);
            self.needs_layout = true;
        }
        let node = self.node_mut(id);
        let mut text_changed = false;
        if node.input.is_none() {
            let (text, mut static_marks) = match props.text {
                Some(text) if !props.marks.is_empty() => {
                    let (text, marks) = crate::text_input::claim_marks(&text, &props.marks);
                    (Some(text), marks)
                }
                text => (text, Vec::new()),
            };
            if node.text != text {
                node.text = text;
                text_changed = true;
            }
            let same_marks = node.static_marks.len() == static_marks.len()
                && node
                    .static_marks
                    .iter()
                    .zip(&static_marks)
                    .all(|(a, b)| a.id == b.id && a.offset == b.offset);
            if !same_marks {
                for mark in &mut static_marks {
                    if let Some(old) = node.static_marks.iter().find(|o| o.id == mark.id) {
                        mark.advance = old.advance;
                    }
                }
                node.static_marks = static_marks;
                changed = true;
                text_changed = true;
            }
        }
        let old_key = node.key.clone();
        if text_changed {
            changed = true;
            self.needs_layout = true;
            self.doc.invalidate(id);
        }
        if old_key != props.key {
            self.node_mut(id).key = props.key.clone();
            if let Some(old) = old_key
                && self.keys.get(&old) == Some(&id)
            {
                self.keys.remove(&old);
            }
            if let Some(key) = props.key {
                self.keys.insert(key, id);
            }
        }
        if style_changed {
            let (taffy, style, hidden, input) = {
                let node = self.node(id);
                (node.taffy, node.style.clone(), node.hidden, node.input.is_some())
            };
            self.taffy
                .set_style(taffy, to_taffy(&style, hidden, input, self.lattice))
                .expect("taffy style");
            self.needs_layout = true;
        }
        if let Some(value) = controlled_text {
            self.set_input_text(id, &value);
        }
        if let Some(surface) = swapped_surface {
            self.changed_surfaces.push(surface);
        }
        if scrolls {
            self.scrollables.insert(id);
        } else {
            self.scrollables.remove(&id);
        }
        if list {
            self.lists.insert(id);
        } else {
            self.lists.remove(&id);
        }
        if relisted {
            self.children_dirty.insert(id);
            self.full_place = true;
        }
        if style_changed {
            self.restyled.insert(id);
            self.order_stale = true;
        } else if changed {
            self.reshaped.insert(id);
        }
        if changed {
            self.needs_paint = true;
        }
    }

    pub fn set_input_text(&mut self, id: NodeId, text: &str) {
        let node = self.node_mut(id);
        let Some(state) = &mut node.input else {
            return;
        };
        if state.input.text() == text {
            return;
        }
        state.input.replace_all(text);
        node.text = Some(text.to_string());
        self.reshaped.insert(id);
        self.needs_layout = true;
    }

    pub fn input_mut(&mut self, id: NodeId) -> Option<&mut TextInput> {
        self.get_mut(id)
            .and_then(|n| n.input.as_mut())
            .map(|s| &mut s.input)
    }

    pub fn input(&self, id: NodeId) -> Option<&TextInput> {
        self.get(id)?.input.as_ref().map(|s| &s.input)
    }

    pub fn edit_input(&mut self, id: NodeId, edit: impl FnOnce(&mut TextInput)) {
        if let Some(input) = self.input_mut(id) {
            edit(input);
            self.sync_input_text(id);
        }
    }

    pub fn input_text(&self, id: NodeId) -> Option<&str> {
        self.get(id)?.input.as_ref().map(|s| s.input.text())
    }

    pub(crate) fn sync_input_text(&mut self, id: NodeId) {
        let node = self.node_mut(id);
        if let Some(state) = &node.input {
            let text = state.input.text().to_string();
            if node.text.as_deref() != Some(text.as_str()) {
                node.text = Some(text);
                self.reshaped.insert(id);
                self.needs_layout = true;
            }
        }
        self.needs_paint = true;
    }

    pub fn text_of(&self, id: NodeId) -> Option<&str> {
        self.get(id)?.text.as_deref()
    }

    pub(crate) fn input_meta(&self, id: NodeId) -> Option<(Resolved, bool)> {
        let node = self.get(id)?;
        let submit = node.input.as_ref()?.submit;
        Some((node.resolved, submit))
    }

    pub(crate) fn resolved_px(&self, id: NodeId) -> Option<f32> {
        Some(self.get(id)?.resolved.px)
    }

    pub(crate) fn bar_opacity(&self, id: NodeId) -> f32 {
        self.get(id).map_or(0.0, |n| n.bar.opacity)
    }

    pub(crate) fn step_bar(&mut self, id: NodeId, engaged: bool, dt: f32, now: Instant) -> bool {
        let Some(node) = self.get_mut(id) else {
            return false;
        };
        let scroll_max = node.scroll_max;
        scrollbar::step(&mut node.bar, engaged, scroll_max, dt, now)
    }

    pub(crate) fn bar_animating(&self, id: NodeId, now: Instant) -> bool {
        self.get(id)
            .is_some_and(|node| scrollbar::animating(&node.bar, now))
    }

    pub(crate) fn touch_bar(&mut self, id: NodeId) {
        if let Some(node) = self.get_mut(id) {
            node.bar.last_move = Some(Instant::now());
        }
    }

    pub(crate) fn take_scroll_emit(&mut self, id: NodeId) -> Option<(Option<String>, f32, f32)> {
        let node = self.get(id)?;
        if !node.scroll_events {
            return None;
        }
        let (offset, max) = (node.scroll.position, node.scroll_max);
        if (offset - node.last_scroll_emit).abs() < 0.5 {
            return None;
        }
        let key = node.key.clone();
        self.get_mut(id)?.last_scroll_emit = offset;
        Some((key, offset, max))
    }

    pub fn find(&self, key: &str) -> Option<NodeId> {
        self.keys.get(key).copied()
    }

    pub fn key_of(&self, id: NodeId) -> Option<&str> {
        self.get(id)?.key.as_deref()
    }

    pub fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.get(id)?.parent
    }

    pub fn children(&self, id: NodeId) -> &[NodeId] {
        self.get(id).map_or(&[], |n| &n.children)
    }

    pub fn set_window(&mut self, window: (f32, f32)) {
        let root = self.root;
        let node = self.node_mut(root);
        node.style.width = Dimension::Px(window.0);
        node.style.height = Dimension::Px(window.1);
        let (taffy, style, hidden) = (node.taffy, node.style.clone(), node.hidden);
        self.taffy
            .set_style(taffy, to_taffy(&style, hidden, false, self.lattice))
            .expect("taffy style");
        self.needs_layout = true;
    }

    pub fn dirty(&self) -> bool {
        self.needs_layout || self.needs_place || self.needs_paint
    }

    pub fn uses_surface(&self, surface: u32) -> bool {
        self.slots
            .iter()
            .filter_map(|slot| slot.node.as_ref())
            .any(|node| node.surface == Some(surface))
    }

    pub fn surface_rects(&self, surface: u32) -> impl Iterator<Item = (PxRect, PxRect)> + '_ {
        self.slots
            .iter()
            .filter_map(|slot| slot.node.as_ref())
            .filter(move |node| node.surface == Some(surface))
            .map(|node| (node.abs, node.visible))
    }

    pub(crate) fn take_changed_surfaces(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.changed_surfaces)
    }

    pub(crate) fn mark_surface_changed(&mut self, surface: u32) {
        self.changed_surfaces.push(surface);
    }

    pub fn mark_paint(&mut self) {
        self.needs_paint = true;
    }

    pub(crate) fn clear_paint_flag(&mut self) {
        self.needs_paint = false;
    }

    pub fn mark_place(&mut self) {
        self.needs_place = true;
    }

    pub(crate) fn mark_layout(&mut self) {
        self.needs_layout = true;
        self.resolve_all = true;
        self.full_place = true;
        self.order_stale = true;
    }

    fn restyle_all(&mut self) {
        let nodes: Vec<(taffy::NodeId, Style, bool, bool)> = self
            .slots
            .iter()
            .filter_map(|slot| slot.node.as_ref())
            .map(|node| (node.taffy, node.style.clone(), node.hidden, node.input.is_some()))
            .collect();
        for (taffy, style, hidden, input) in nodes {
            self.taffy.set_style(taffy, to_taffy(&style, hidden, input, self.lattice)).expect("taffy style");
        }
        self.mark_layout();
    }

    pub fn lattice(&self) -> (f32, f32) {
        self.lattice
    }

    pub fn set_lattice(&mut self, lattice: (f32, f32)) {
        if lattice != self.lattice {
            self.lattice = lattice;
            self.restyle_all();
        }
    }

    pub fn flush_layout(&mut self, registry: &mut crate::fonts::FontRegistry, base_px: f32) {
        if base_px != self.base_px {
            self.mark_layout();
        }
        self.base_px = base_px;
        let fonts_needed = self.needs_layout;
        if self.needs_layout {
            crate::profiler::span("tree.sync", || self.sync_dirty_children());
            crate::profiler::span("tree.resolve", || self.resolve_changed(registry));
        }
        let fonts: &[crate::fonts::Font] = registry;
        if fonts_needed {
            crate::profiler::span("tree.widgets", || self.layout_mark_widgets(fonts));

            let root_taffy = self.node(self.root).taffy;
            crate::profiler::span("tree.layout", || {
                self.taffy
                    .compute_layout_with_measure(
                        root_taffy,
                        taffy::Size::MAX_CONTENT,
                        |known, available, _node, context, _style| {
                            layout::measure(known, available, context.as_deref(), fonts)
                        },
                    )
                    .expect("layout")
            });
            self.needs_layout = false;
            self.needs_place = true;
        }
        let mut measured = false;
        if self.needs_place && !self.lists.is_empty() {
            measured = crate::profiler::span("tree.lists", || self.lay_out_lists(fonts, fonts_needed, None));
        }
        if fonts_needed || measured {
            crate::profiler::span("tree.slots", || self.layout_slots(fonts));
        }
        if self.needs_place {
            let unchanged_offscreen = (!self.full_place).then(|| self.touched_paths());
            crate::profiler::span("tree.place", || self.place(fonts, unchanged_offscreen.as_ref()));
            self.needs_place = false;
            self.full_place = false;
            self.touched.clear();
            self.needs_paint = true;
        }
        if self.doc.has_selection() {
            self.ensure_order();
        }
        if !self.modals.is_empty() || self.modal.is_some() {
            self.ensure_order();
        }
    }

    pub(crate) fn ensure_order(&mut self) {
        if std::mem::take(&mut self.order_stale) {
            crate::profiler::span("tree.order", || self.rebuild_order());
        }
    }

    fn rebuild_order(&mut self) {
        self.paint_order.clear();
        self.modal = None;
        let mut stack = vec![self.root];
        while let Some(id) = stack.pop() {
            let node = self.node(id);
            let shown = !node.hidden
                && (node.mark.is_none() || node.mark_visible)
                && (node.slot.is_none() || node.slot_visible);
            if !shown {
                continue;
            }
            let modal = node.modal;
            stack.extend(node.children.iter().rev());
            if modal {
                self.modal = Some(id);
            }
            let order = self.paint_order.len() as u32;
            self.node_mut(id).order = order;
            self.paint_order.push(id);
        }
    }

    fn nodes_at(&self, x: f32, y: f32) -> Vec<NodeId> {
        let mut found = Vec::new();
        self.collect_at(self.modal.unwrap_or(self.root), x, y, &mut found);
        found
    }

    pub fn modal_root(&self) -> Option<NodeId> {
        self.modal
    }

    pub fn inert(&self, id: NodeId) -> bool {
        let Some(modal) = self.modal else {
            return false;
        };
        let mut current = Some(id);
        while let Some(node) = current {
            if node == modal {
                return false;
            }
            current = self.get(node).and_then(|n| n.parent);
        }
        true
    }

    pub(crate) fn paint_children(&self, id: NodeId) -> impl DoubleEndedIterator<Item = NodeId> + '_ {
        let children = self.get(id).map_or(&[][..], RNode::placed_children);
        let sticky = |child: &NodeId| self.get(*child).is_some_and(|n| n.style.position == Position::Sticky);
        children.iter().filter(move |c| !sticky(c)).chain(children.iter().filter(move |c| sticky(c))).copied()
    }

    fn collect_at(&self, id: NodeId, x: f32, y: f32, found: &mut Vec<NodeId>) {
        let Some(node) = self.get(id) else {
            return;
        };
        let hidden_child = |n: &RNode| n.hidden || (n.mark.is_some() && !n.mark_visible) || (n.slot.is_some() && !n.slot_visible);
        if hidden_child(node) || node.offscreen || !node.extent.offset(node.abs.x, node.abs.y).contains(x, y) {
            return;
        }
        for child in self.paint_children(id).rev() {
            self.collect_at(child, x, y, found);
        }
        if node.visible.contains(x, y) {
            found.push(id);
        }
    }

    fn resolve_changed(&mut self, registry: &mut crate::fonts::FontRegistry) {
        let base = Resolved { px: self.base_px, ..DEFAULT_RESOLVED };
        let restyled = std::mem::take(&mut self.restyled);
        let reshaped = std::mem::take(&mut self.reshaped);
        self.touched.extend(restyled.iter().chain(&reshaped).copied());
        if std::mem::take(&mut self.resolve_all) {
            self.image_slot_parents.clear();
            self.mark_parents.clear();
            self.resolve(self.root, base, registry, true);
            return;
        }
        for &id in &restyled {
            if self.ancestor_in(id, &restyled) == Some(false) {
                let inherited = self.inherited(id, base);
                self.resolve(id, inherited, registry, true);
            }
        }
        for &id in &reshaped {
            if !restyled.contains(&id) && self.ancestor_in(id, &restyled) == Some(false) {
                let inherited = self.inherited(id, base);
                self.resolve(id, inherited, registry, false);
            }
        }
    }

    pub fn rows_pending(&self) -> bool {
        !self.pending_lists.is_empty()
    }

    pub fn catch_up_rows(&mut self, fonts: &[crate::fonts::Font], until: Instant) -> bool {
        let measured = self.lay_out_lists(fonts, false, Some(until));
        if measured {
            self.layout_slots(fonts);
            self.needs_place = true;
        }
        measured
    }

    fn lay_out_lists(&mut self, fonts: &[crate::fonts::Font], relaid: bool, until: Option<Instant>) -> bool {
        let mut lists: Vec<(Vec<usize>, NodeId)> =
            self.lists.iter().filter_map(|&id| Some((self.path_from_root(id)?, id))).collect();
        lists.sort_by(|a, b| a.0.cmp(&b.0));
        let mut measured = false;
        self.pending_lists.retain(|id| self.lists.contains(id));
        self.lists_changed.retain(|id| self.lists.contains(id));
        for (_, id) in lists {
            measured |= self.lay_out_list(id, fonts, relaid, until);
        }
        measured
    }

    fn lay_out_list(&mut self, id: NodeId, fonts: &[crate::fonts::Font], relaid: bool, until: Option<Instant>) -> bool {
        let node = self.node(id);
        let layout = *self.taffy.layout(node.taffy).expect("layout");
        let width = (layout.size.width - layout.padding.left - layout.padding.right - layout.border.left - layout.border.right).max(0.0);
        let top = layout.padding.top + layout.border.top;
        let bottom = layout.padding.bottom + layout.border.bottom;
        let view = layout.size.height;
        let gap = node.style.gap;
        let rows = node.children.clone();
        let position = node.scroll.position;
        let follow_end = node.style.scroll_anchor == ScrollAnchor::End && position >= node.scroll_max - 0.5;
        let mut estimate = if node.row_estimate > 0.0 { node.row_estimate } else { self.base_px * 3.0 };
        let stale = |tree: &Self, row: NodeId| {
            let node = tree.node(row);
            !node.hidden && (node.measured_width != width || tree.taffy.dirty(node.taffy).unwrap_or(true))
        };
        let height = |tree: &Self, row: NodeId| {
            let node = tree.node(row);
            if node.hidden {
                0.0
            } else if node.measured_width.is_nan() {
                estimate
            } else {
                tree.taffy.layout(node.taffy).map_or(estimate, |l| l.size.height)
            }
        };
        let anchor = if follow_end {
            rows.len().saturating_sub(1)
        } else {
            rows.partition_point(|&row| {
                let node = self.node(row);
                node.list_y + height(self, row) <= position
            })
            .min(rows.len().saturating_sub(1))
        };
        let anchor_y = rows.get(anchor).map_or(0.0, |&row| self.node(row).list_y);
        let top_row = rows
            .partition_point(|&row| {
                let node = self.node(row);
                node.list_y + height(self, row) <= position
            })
            .min(rows.len().saturating_sub(1));
        let top_y = rows.get(top_row).map_or(0.0, |&row| self.node(row).list_y);
        let mut first_changed = usize::MAX;
        let mut measure = |tree: &mut Self, index: usize| {
            let row = rows[index];
            if stale(tree, row) {
                crate::profiler::span("tree.row", || tree.measure_row(row, width, fonts));
                first_changed = first_changed.min(index);
            }
            height(tree, row)
        };
        let (ahead, behind) = if follow_end { (0.25, 1.25) } else { (1.25, 0.25) };
        let (mut below, mut above) = (anchor, anchor);
        let ahead_until = Instant::now() + LOOK_AHEAD_BUDGET;
        let mut reach = if follow_end { 0.0 } else { anchor_y - position };
        while below < rows.len() && reach < view * ahead {
            if !follow_end && reach >= view && Instant::now() > ahead_until {
                break;
            }
            reach += measure(self, below);
            below += 1;
        }
        reach = 0.0;
        while above > 0 && reach < view * behind {
            if (!follow_end || reach >= view) && Instant::now() > ahead_until {
                break;
            }
            above -= 1;
            reach += measure(self, above);
        }
        if let Some(until) = until {
            while (above > 0 || below < rows.len()) && Instant::now() < until {
                if below < rows.len() {
                    measure(self, below);
                    below += 1;
                }
                if above > 0 {
                    above -= 1;
                    measure(self, above);
                }
            }
        }
        let rows_changed = self.lists_changed.contains(&id) || self.node(id).list_width != width;
        let measured = first_changed != usize::MAX;
        if !measured && !rows_changed {
            if relaid {
                self.pending_lists.insert(id);
            } else if until.is_some() && above == 0 && below >= rows.len() {
                self.pending_lists.remove(&id);
            }
            if relaid {
                let node = self.node_mut(id);
                let max = (node.content_height.unwrap_or(node.list_height) - view).max(0.0);
                node.scroll_max = max;
                let moved = if follow_end { max } else { position.min(max) };
                if moved != position {
                    node.scroll.position = moved;
                    node.scroll.target += moved - position;
                }
            }
            return false;
        }
        self.lists_changed.remove(&id);
        self.node_mut(id).list_width = width;
        let from = if rows_changed { 0 } else { first_changed };
        if from == 0 {
            let (mut sum, mut count) = (0.0, 0);
            for &row in &rows {
                let node = self.node(row);
                if !node.hidden && !node.measured_width.is_nan() {
                    sum += height(self, row);
                    count += 1;
                }
            }
            if count > 0 {
                estimate = sum / count as f32;
            }
        }
        let height = |tree: &Self, row: NodeId| {
            let node = tree.node(row);
            if node.hidden {
                0.0
            } else if node.measured_width.is_nan() {
                estimate
            } else {
                tree.taffy.layout(node.taffy).map_or(estimate, |l| l.size.height)
            }
        };
        let mut y = if from == 0 { top } else { self.node(rows[from]).list_y };
        let mut pending = false;
        let mut shown = usize::from(from > 0);
        for &row in &rows[from..] {
            pending |= stale(self, row);
            let h = height(self, row);
            self.node_mut(row).list_y = y;
            if !self.node(row).hidden {
                y += h + gap;
                shown += 1;
            }
        }
        if shown > 0 {
            y -= gap;
        }
        if pending {
            self.pending_lists.insert(id);
        } else if from == 0 {
            self.pending_lists.remove(&id);
        }
        let node = self.node_mut(id);
        node.list_height = y + bottom;
        node.row_estimate = estimate;
        node.scroll_max = (node.content_height.unwrap_or(node.list_height) - view).max(0.0);
        let new_position = if follow_end {
            (node.list_height - view).max(0.0)
        } else {
            rows.get(anchor).map_or(position, |&row| position + self.node(row).list_y - anchor_y)
        };
        let shift = rows.get(top_row).map_or(0.0, |&row| self.node(row).list_y - top_y);
        let node = self.node_mut(id);
        node.scroll.anchored += ((position + shift).round() - position.round()) as i64;
        if new_position != position {
            node.scroll.position = new_position;
            node.scroll.target += new_position - position;
        }
        measured
    }

    fn measure_row(&mut self, row: NodeId, width: f32, fonts: &[crate::fonts::Font]) {
        use taffy::prelude::length;
        let node = self.node(row);
        let taffy_id = node.taffy;
        let mut style = to_taffy(&node.style, node.hidden, node.input.is_some(), self.lattice);
        style.size.width = length(width);
        if self.taffy.style(taffy_id).ok() != Some(&style) {
            self.taffy.set_style(taffy_id, style).expect("taffy style");
        }
        self.taffy
            .compute_layout_with_measure(
                taffy_id,
                taffy::Size { width: taffy::AvailableSpace::Definite(width), height: taffy::AvailableSpace::MaxContent },
                |known, available, _node, context, _style| layout::measure(known, available, context.as_deref(), fonts),
            )
            .expect("row layout");
        self.node_mut(row).measured_width = width;
    }

    pub fn take_stick_changes(&mut self) -> Vec<(NodeId, bool)> {
        std::mem::take(&mut self.stick_changes)
    }

    fn sticky_y(&self, id: NodeId, rect: PxRect) -> Option<(f32, f32)> {
        let node = self.get(id)?;
        let parent = self.get(node.parent?)?;
        let mut current = node.parent;
        let port = loop {
            let at = self.get(current?)?;
            if at.style.overflow == Overflow::Scroll {
                break at.visible;
            }
            current = at.parent;
        };
        let inset = match node.style.inset.top? {
            InsetValue::Px(v) => v,
            InsetValue::Percent(f) => f * port.h,
        };
        let floor = parent.abs.y + parent.abs.h - rect.h;
        Some((rect.y.max((port.y + inset).min(floor)), port.y))
    }

    fn inherited(&self, id: NodeId, base: Resolved) -> Resolved {
        self.node(id).parent.map_or(base, |parent| self.node(parent).resolved)
    }

    fn ancestor_in(&self, id: NodeId, set: &HashSet<NodeId>) -> Option<bool> {
        let mut current = self.get(id)?.parent;
        let mut found = false;
        while let Some(at) = current {
            found |= set.contains(&at);
            if at == self.root {
                return Some(found);
            }
            current = self.get(at)?.parent;
        }
        (id == self.root).then_some(false)
    }

    fn touched_paths(&self) -> HashSet<NodeId> {
        let mut paths = HashSet::new();
        for &id in &self.touched {
            let mut current = Some(id);
            while let Some(at) = current {
                if !paths.insert(at) {
                    break;
                }
                current = self.get(at).and_then(|node| node.parent);
            }
        }
        paths
    }

    fn resolve(&mut self, id: NodeId, inherited: Resolved, registry: &mut crate::fonts::FontRegistry, deep: bool) {
        let node = self.node_mut(id);
        let families = node.style.font_family.unwrap_or(inherited.families);
        let weight = node.style.font_weight.unwrap_or(inherited.weight);
        let italic = node.style.font_italic.unwrap_or(inherited.italic);
        let font = if (families, weight, italic) == (inherited.families, inherited.weight, inherited.italic) && inherited.font_id != usize::MAX {
            inherited.font
        } else {
            registry.resolve(families, weight, italic)
        };
        let font_id = registry[font].id();
        let resolved = Resolved {
            color: node.style.color.unwrap_or(inherited.color),
            px: node.style.font_size.unwrap_or(inherited.px),
            families,
            weight,
            italic,
            font,
            font_id,
            selectable: node.style.selectable.unwrap_or(inherited.selectable),
            selection_color: node
                .style
                .selection_color
                .unwrap_or(inherited.selection_color),
        };
        node.resolved = resolved;
        let taffy = node.taffy;
        let children = node.children.clone();
        let image = node.image.clone();
        let wrap = node.style.wrap;
        let is_input = node.input.is_some();
        let cell_caret = node.cell_caret();
        let marks = node.marks().to_vec();
        let node_text = node.text.clone();
        let non_flow_only = children.iter().all(|&c| {
            let child = self.node(c);
            child.slot.is_some() || child.mark.is_some()
        });
        let text = if image.is_none() && non_flow_only {
            node_text
        } else {
            None
        };
        self.mark_parents.remove(&id);
        self.image_slot_parents.remove(&id);
        if (is_input || !marks.is_empty()) && children.iter().any(|&c| self.node(c).mark.is_some())
        {
            self.mark_parents.insert(id);
        }
        let want = if let Some(image) = image {
            if non_flow_only {
                if !children.is_empty() {
                    self.image_slot_parents.insert(id);
                }
                let status = crate::image_cache::status(&image.src, &image.equal_to);
                let size = crate::image_cache::image_size(&image.src, &image.equal_to)
                    .or((status == ImageStatus::Failed).then_some((32, 32)));
                Some(MeasureCtx::Image {
                    size,
                    src: image.src,
                })
            } else {
                None
            }
        } else { text.map(|text| MeasureCtx::Text {
                text,
                px: resolved.px,
                font: resolved.font,
                font_id: resolved.font_id,
                wrap,
                marks,
                cell_caret,
            }) };
        if self.taffy.get_node_context(taffy) != want.as_ref() {
            self.taffy
                .set_node_context(taffy, want)
                .expect("taffy context");
            let _ = self.taffy.mark_dirty(taffy);
        }
        if deep {
            for child in children {
                self.resolve(child, resolved, registry, true);
            }
        }
    }

    fn layout_slots(&mut self, fonts: &[crate::fonts::Font]) {
        use taffy::prelude::length;
        let parents: Vec<NodeId> = self.image_slot_parents.iter().copied().collect();
        for id in parents {
            let Some(node) = self.get(id) else { continue };
            let (image_taffy, children) = (node.taffy, node.children.clone());
            let size = self.taffy.layout(image_taffy).expect("layout").size;
            for child in children {
                let (child_taffy, style, hidden) = {
                    let child = self.node(child);
                    (child.taffy, child.style.clone(), child.hidden)
                };
                let mut taffy_style = to_taffy(&style, hidden, false, self.lattice);
                taffy_style.size = taffy::Size {
                    width: length(size.width),
                    height: length(size.height),
                };
                self.taffy
                    .set_style(child_taffy, taffy_style)
                    .expect("taffy style");
                self.taffy
                    .compute_layout_with_measure(
                        child_taffy,
                        taffy::Size {
                            width: taffy::AvailableSpace::Definite(size.width),
                            height: taffy::AvailableSpace::Definite(size.height),
                        },
                        |known, available, _node, context, _style| {
                            layout::measure(known, available, context.as_deref(), fonts)
                        },
                    )
                    .expect("slot layout");
            }
        }
    }

    fn layout_mark_widgets(&mut self, fonts: &[crate::fonts::Font]) {
        let parents: Vec<NodeId> = self.mark_parents.iter().copied().collect();
        for id in parents {
            let Some(node) = self.get(id) else { continue };
            let children = node.children.clone();
            let mut changed = false;
            for child in children {
                let (mark_id, child_taffy) = {
                    let child = self.node(child);
                    let Some(mark_id) = child.mark else { continue };
                    (mark_id, child.taffy)
                };
                self.taffy
                    .compute_layout_with_measure(
                        child_taffy,
                        taffy::Size::MAX_CONTENT,
                        |known, available, _node, context, _style| {
                            layout::measure(known, available, context.as_deref(), fonts)
                        },
                    )
                    .expect("widget layout");
                let size = self.taffy.layout(child_taffy).expect("layout").size;
                let Some(node) = self.get_mut(id) else {
                    continue;
                };
                changed |= match &mut node.input {
                    Some(state) => state.input.set_mark_advance(mark_id, size.width),
                    None => match node.static_marks.iter_mut().find(|m| m.id == mark_id) {
                        Some(mark) if (mark.advance - size.width).abs() >= 0.01 => {
                            mark.advance = size.width;
                            true
                        }
                        _ => false,
                    },
                };
            }
            if changed {
                self.refresh_input_measure(id);
            }
        }
    }

    fn refresh_input_measure(&mut self, id: NodeId) {
        self.touched.insert(id);
        let node = self.node(id);
        let ctx = MeasureCtx::Text {
            text: node.text.clone().unwrap_or_default(),
            px: node.resolved.px,
            font: node.resolved.font,
            font_id: node.resolved.font_id,
            wrap: node.style.wrap,
            marks: node.marks().to_vec(),
            cell_caret: node.cell_caret(),
        };
        let taffy = node.taffy;
        if self.taffy.get_node_context(taffy) != Some(&ctx) {
            self.taffy
                .set_node_context(taffy, Some(ctx))
                .expect("taffy context");
            let _ = self.taffy.mark_dirty(taffy);
        }
    }

    fn place(&mut self, fonts: &[crate::fonts::Font], skip: Option<&HashSet<NodeId>>) {
        let layout = self
            .taffy
            .layout(self.node(self.root).taffy)
            .expect("layout");
        let window = PxRect {
            x: 0.0,
            y: 0.0,
            w: layout.size.width,
            h: layout.size.height,
        };
        self.place_node(self.root, (0.0, 0.0), Some(window), fonts, skip);
    }

    fn single_line_offset(&self, id: NodeId, layout: &taffy::Layout, fonts: &[crate::fonts::Font]) -> f32 {
        let node = self.node(id);
        if node.input.is_none() || node.style.wrap {
            return 0.0;
        }
        let font = &fonts[node.resolved.font.min(fonts.len() - 1)];
        let content = layout.size.height - layout.padding.top - layout.padding.bottom - layout.border.top - layout.border.bottom;
        ((content - line_height(font, node.resolved.px)) / 2.0).max(0.0).round()
    }

    fn place_node(
        &mut self,
        id: NodeId,
        origin: (f32, f32),
        clip: Option<PxRect>,
        fonts: &[crate::fonts::Font],
        skip: Option<&HashSet<NodeId>>,
    ) -> PxRect {
        if self.node(id).hidden {
            self.zero_rects(id);
            return PxRect::ZERO;
        }
        let layout = *self.taffy.layout(self.node(id).taffy).expect("layout");
        let mut raw = PxRect {
            x: origin.0 + layout.location.x,
            y: origin.1 + layout.location.y,
            w: layout.size.width,
            h: layout.size.height,
        };
        if self.node(id).style.position == Position::Sticky
            && let Some((y, port_top)) = self.sticky_y(id, raw)
        {
            let stuck = y > raw.y + 0.5 && y + raw.h > port_top;
            raw.y = y;
            self.set_stuck(id, stuck);
        }
        let rect = snap(raw, self.lattice, self.node(id).paints());
        let visible = clip.map_or(rect, |c| rect.intersect(c));
        let moved_surface = {
            let node = self.node(id);
            node.surface.filter(|_| node.abs != rect || node.visible != visible)
        };
        if let Some(surface) = moved_surface {
            self.changed_surfaces.push(surface);
        }
        let text_offset_y = self.single_line_offset(id, &layout, fonts);
        let node = self.node_mut(id);
        node.abs = rect;
        node.visible = visible;
        node.text_offset_y = text_offset_y;
        let scrolls = node.style.overflow == Overflow::Scroll;
        if scrolls {
            let list = node.style.layout == Layout::List;
            let content = node.content_height.unwrap_or(if list { node.list_height } else { layout.content_size.height });
            let max = (content - rect.h).max(0.0);
            if node.style.scroll_anchor == ScrollAnchor::End && node.scroll.position >= node.scroll_max - 0.5 {
                if node.scroll.target >= node.scroll_max - 0.5 {
                    node.scroll.target = max;
                }
                node.scroll.position = max;
            }
            node.scroll_max = max;
            if node.scroll.position > max {
                node.scroll.position = max;
            }
            if node.scroll.target > max {
                node.scroll.target = max;
            }
        }

        let node = self.node(id);
        let child_origin = if scrolls {
            (raw.x, raw.y - node.scroll.shown())
        } else {
            (raw.x, raw.y)
        };
        let clips = node.style.overflow != Overflow::Visible;
        let row_x = (node.style.layout == Layout::List).then(|| raw.x + layout.padding.left + layout.border.left);
        let child_clip = if clips { Some(visible) } else { clip };
        let image_src = node.image.clone();
        let mut extent = rect;
        let children = match skip {
            Some(touched) if row_x.is_some() && !self.touched.contains(&id) => self.rows_to_place(id, touched),
            _ => {
                let children = node.children.clone();
                if row_x.is_some() {
                    self.node_mut(id).placed_rows = 0..children.len();
                }
                children
            }
        };
        for child in children {
            if let Some(mark_id) = self.node(child).mark {
                match self.mark_child_origin(id, child, mark_id, fonts) {
                    Some(at) => {
                        self.node_mut(child).mark_visible = true;
                        let placed = self.place_node(child, at, Some(visible), fonts, skip);
                        extent = extent.union(placed);
                    }
                    None => {
                        self.node_mut(child).mark_visible = false;
                        self.zero_rects(child);
                    }
                }
                continue;
            }
            match (self.node(child).slot, &image_src) {
                (Some(kind), Some(image)) => {
                    let status = crate::image_cache::status(&image.src, &image.equal_to);
                    let show = matches!(
                        (kind, status),
                        (SlotKind::Placeholder, ImageStatus::Pending)
                            | (SlotKind::Error, ImageStatus::Failed)
                    );
                    self.node_mut(child).slot_visible = show;
                    if show {
                        let placed = self.place_node(child, (raw.x, raw.y), Some(visible), fonts, skip);
                        extent = extent.union(placed);
                    } else {
                        self.zero_rects(child);
                    }
                }
                (Some(_), None) => {
                    self.node_mut(child).slot_visible = false;
                    self.zero_rects(child);
                }
                (None, _) => {
                    let origin = match row_x {
                        Some(x) => (x, child_origin.1 + self.node(child).list_y),
                        None => child_origin,
                    };
                    let placed = self.place_flow_child(child, origin, child_clip, fonts, skip);
                    extent = extent.union(placed);
                }
            }
        }
        if clips {
            extent = rect;
        }
        self.node_mut(id).extent = extent.offset(-rect.x, -rect.y);
        extent
    }

    fn rows_to_place(&mut self, id: NodeId, touched: &HashSet<NodeId>) -> Vec<NodeId> {
        let node = self.node(id);
        let rows = &node.children;
        let reach = node.abs.h / 2.0;
        let (top, bottom) = (node.scroll.position - reach, node.scroll.position + node.abs.h + reach);
        let first = rows.partition_point(|&row| self.node(row).list_y < top).saturating_sub(1);
        let last = rows.partition_point(|&row| self.node(row).list_y < bottom);
        let near = first..last;
        let previous = node.placed_rows.start.min(rows.len())..node.placed_rows.end.min(rows.len());
        let mut chosen: Vec<NodeId> = rows[near.clone()].to_vec();
        let touched_rows: Vec<NodeId> = touched.iter().copied().filter(|&row| self.get(row).is_some_and(|n| n.parent == Some(id))).collect();
        chosen.extend(touched_rows.into_iter().filter(|row| !rows[near.clone()].contains(row)));
        let left: Vec<NodeId> = previous.filter(|i| !near.contains(i)).map(|i| rows[i]).collect();
        self.node_mut(id).placed_rows = near;
        for row in left {
            if !self.node(row).offscreen && self.node(row).style.position != Position::Sticky {
                self.hide_offscreen(row);
                self.node_mut(row).offscreen = true;
            }
        }
        chosen
    }

    fn place_flow_child(
        &mut self,
        child: NodeId,
        origin: (f32, f32),
        clip: Option<PxRect>,
        fonts: &[crate::fonts::Font],
        skip: Option<&HashSet<NodeId>>,
    ) -> PxRect {
        if let Some(touched) = skip {
            let node = self.node(child);
            let layout = self.taffy.layout(node.taffy).expect("layout");
            let extent = node.extent.offset(origin.0 + layout.location.x, origin.1 + layout.location.y);
            let unchanged = !node.hidden
                && node.style.position != Position::Sticky
                && !touched.contains(&child)
                && (layout.size.width, layout.size.height) == (node.abs.w, node.abs.h);
            if unchanged && clip.is_some_and(|c| !extent.intersects(c)) {
                if !node.offscreen {
                    self.hide_offscreen(child);
                }
                self.node_mut(child).offscreen = true;
                return extent;
            }
        }
        let extent = self.place_node(child, origin, clip, fonts, skip);
        self.node_mut(child).offscreen = clip.is_some_and(|c| !extent.intersects(c));
        extent
    }

    fn set_stuck(&mut self, id: NodeId, stuck: bool) {
        let node = self.node_mut(id);
        if node.stuck != stuck {
            node.stuck = stuck;
            if node.stick_events {
                self.stick_changes.push((id, stuck));
            }
        }
    }

    fn hide_offscreen(&mut self, id: NodeId) {
        self.set_stuck(id, false);
        let node = self.node_mut(id);
        let hidden_surface = node.surface.filter(|_| node.visible != PxRect::ZERO);
        node.visible = PxRect::ZERO;
        if let Some(surface) = hidden_surface {
            self.changed_surfaces.push(surface);
        }
        for child in self.node(id).children.clone() {
            self.hide_offscreen(child);
        }
    }

    fn mark_child_origin(
        &self,
        parent: NodeId,
        child: NodeId,
        mark_id: u64,
        fonts: &[crate::fonts::Font],
    ) -> Option<(f32, f32)> {
        let node = self.get(parent)?;
        let text = node.text.as_deref()?;
        let mark = node.marks().iter().find(|m| m.id == mark_id)?;
        let geometry = self.text_geometry(parent)?;
        let font = &fonts[geometry.font.min(fonts.len() - 1)];
        let (x, y) = offset_to_point(
            text,
            mark.offset,
            font,
            geometry.px,
            geometry.max_width,
            node.marks(),
        );
        let size = self.taffy.layout(self.get(child)?.taffy).ok()?.size;
        let line_h = line_height(font, geometry.px);
        Some((
            geometry.origin.0 + x,
            geometry.origin.1 + y + (line_h - size.height) / 2.0,
        ))
    }

    fn zero_rects(&mut self, id: NodeId) {
        let node = self.node_mut(id);
        node.abs = PxRect::ZERO;
        node.visible = PxRect::ZERO;
        for child in node.children.clone() {
            self.zero_rects(child);
        }
    }

    pub fn content_y(&self, id: NodeId, ancestor: NodeId) -> Option<f32> {
        let mut y = 0.0;
        let mut current = id;
        while current != ancestor {
            let node = self.get(current)?;
            let parent = node.parent?;
            y += if node.mark.is_some() {
                node.abs.y - self.get(parent)?.abs.y
            } else if self.get(parent)?.style.layout == Layout::List {
                node.list_y
            } else {
                self.taffy.layout(node.taffy).ok()?.location.y
            };
            let parent_node = self.get(parent)?;
            if parent != ancestor && parent_node.style.overflow == Overflow::Scroll {
                y -= parent_node.scroll.shown();
            }
            current = parent;
        }
        Some(y)
    }

    pub fn placement(&self, id: NodeId) -> Option<Placement> {
        let node = self.get(id)?;
        Some(Placement { abs: node.abs, visible: node.visible, offscreen: node.offscreen, stuck: node.stuck })
    }

    pub fn rect(&self, id: NodeId) -> Option<PxRect> {
        let mut rect = self.get(id)?.abs;
        if let Some(y) = self.skipped_y(id) {
            rect.y = y;
        }
        Some(rect)
    }

    fn skipped_y(&self, id: NodeId) -> Option<f32> {
        let mut skipped = None;
        let mut current = Some(id);
        while let Some(at) = current {
            let node = self.get(at)?;
            if node.offscreen {
                skipped = Some(at);
            }
            current = node.parent;
        }
        let placed = self.get(skipped?)?.parent?;
        let parent = self.get(placed)?;
        let scroll = if parent.style.overflow == Overflow::Scroll { parent.scroll.shown() } else { 0.0 };
        Some(parent.abs.y - scroll + self.content_y(id, placed)?)
    }

    pub fn visible_rect(&self, id: NodeId) -> Option<PxRect> {
        Some(self.get(id)?.visible)
    }

    pub fn hit_wheel(&self, x: f32, y: f32) -> Option<NodeId> {
        self.nodes_at(x, y).into_iter().find(|&id| self.node(id).wheel_events)
    }

    // we may want to be more principled with event propagation than this
    pub fn hit_pointer(&self, x: f32, y: f32) -> Option<NodeId> {
        for id in self.nodes_at(x, y) {
            let node = self.node(id);
            if node.pointer_events {
                return Some(id);
            }
            if node.clickable || node.input.is_some() || node.drag_events {
                return None;
            }
        }
        None
    }

    pub fn hit_drag(&self, x: f32, y: f32) -> Option<NodeId> {
        self.nodes_at(x, y).into_iter().find(|&id| self.node(id).drag_events)
    }

    pub fn drawn_after(&self, a: NodeId, b: NodeId) -> bool {
        self.path_from_root(a) > self.path_from_root(b)
    }

    pub fn hit_move(&self, x: f32, y: f32) -> Option<NodeId> {
        self.nodes_at(x, y).into_iter().find(|&id| self.node(id).move_events)
    }

    pub fn hit_hover(&self, x: f32, y: f32) -> Option<NodeId> {
        self.nodes_at(x, y).into_iter().find(|&id| self.node(id).hover_events)
    }

    pub fn box_metrics(&self, id: NodeId) -> Option<BoxMetrics> {
        let node = self.get(id)?;
        let side = |s: Option<crate::style::BorderSide>| s.map_or(0.0, |s| s.width);
        let border = node.style.border.unwrap_or_default();
        Some(BoxMetrics {
            padding: node.style.padding,
            margin: node.style.margin,
            border: Edges {
                left: side(border.left),
                right: side(border.right),
                top: side(border.top),
                bottom: side(border.bottom),
            },
        })
    }

    pub fn hit_any(&self, x: f32, y: f32) -> Option<NodeId> {
        self.nodes_at(x, y).into_iter().next()
    }

    pub fn pointer_shape_at(&self, x: f32, y: f32) -> &str {
        let mut current = self.hit_any(x, y).filter(|&id| !self.inert(id));
        let mut over_text = false;
        while let Some(id) = current {
            let Some(node) = self.get(id) else {
                break;
            };
            if let Some(shape) = &node.style.pointer_shape {
                return shape;
            }
            if node.input.is_some() {
                return "text";
            }
            if self.selectable_text_leaf(id) {
                over_text = true;
            }
            if node.clickable {
                over_text = false;
            }
            current = node.parent;
        }
        if over_text { "text" } else { "default" }
    }

    pub fn hit_click(&self, x: f32, y: f32) -> Option<NodeId> {
        self.nodes_at(x, y).into_iter().find(|&id| self.node(id).clickable)
    }

    pub fn outside_click_targets(&self, x: f32, y: f32) -> Vec<NodeId> {
        let mut targets = Vec::new();
        let mut stack = vec![self.root];
        while let Some(id) = stack.pop() {
            let Some(node) = self.get(id) else { continue };
            if node.hidden {
                continue;
            }
            if node.outside_click_events && !node.visible.contains(x, y) {
                targets.push(id);
            }
            stack.extend(node.children.iter().rev());
        }
        targets
    }

    pub fn hover_at(&self, x: f32, y: f32) -> Option<NodeId> {
        self.nodes_at(x, y).into_iter().find(|&id| {
            let node = self.node(id);
            node.style.hover_background.is_some() || node.style.hover_color.is_some()
        })
    }

    pub fn hit_target(&self, x: f32, y: f32) -> Option<HitTarget> {
        for id in self.nodes_at(x, y) {
            let node = self.node(id);
            if node.input.is_some() {
                return Some(HitTarget::Input(id));
            }
            if node.clickable {
                return Some(HitTarget::Click(id));
            }
            if self.selectable_text_leaf(id) {
                return Some(self.interactive_ancestor(id).unwrap_or(HitTarget::Text(id)));
            }
            if node.style.overflow == Overflow::Scroll
                && let Some(input) = self.descendant_input(id)
            {
                return Some(HitTarget::Input(input));
            }
        }
        self.modal_root()
            .filter(|&id| self.get(id).is_some_and(|node| node.clickable))
            .map(HitTarget::Click)
    }

    pub fn surface_at(&self, x: f32, y: f32) -> bool {
        self.nodes_at(x, y).into_iter().any(|id| self.node(id).surface.is_some())
    }

    pub fn selectable_text_leaf(&self, id: NodeId) -> bool {
        let Some(node) = self.get(id) else {
            return false;
        };
        node.text.is_some()
            && node.children.iter().all(|&c| {
                self.get(c)
                    .is_some_and(|n| n.mark.is_some() || n.slot.is_some())
            })
            && node.input.is_none()
            && !node.hidden
            && node.resolved.selectable
    }

    fn interactive_ancestor(&self, id: NodeId) -> Option<HitTarget> {
        let mut current = self.get(id)?.parent;
        while let Some(cur) = current {
            let node = self.get(cur)?;
            if node.input.is_some() {
                return Some(HitTarget::Input(cur));
            }
            if node.clickable {
                return Some(HitTarget::Click(cur));
            }
            current = node.parent;
        }
        None
    }

    fn descendant_input(&self, id: NodeId) -> Option<NodeId> {
        let node = self.get(id)?;
        for &child in &node.children {
            let Some(node) = self.get(child) else {
                continue;
            };
            if node.hidden {
                continue;
            }
            if node.input.is_some() {
                return Some(child);
            }
            if let Some(found) = self.descendant_input(child) {
                return Some(found);
            }
        }
        None
    }

    pub fn scroll_area_at(&self, x: f32, y: f32) -> Option<ScrollArea> {
        self.scroll_nodes()
            .into_iter()
            .rev()
            .find(|&id| !self.inert(id) && self.get(id).is_some_and(|node| node.visible.contains(x, y)))
            .and_then(|id| self.scroll_area(id))
    }

    pub fn scroll_area(&self, id: NodeId) -> Option<ScrollArea> {
        let node = self.get(id)?;
        if node.style.overflow != Overflow::Scroll {
            return None;
        }
        Some(ScrollArea {
            node: id,
            rect: node.visible,
            content_height: node.scroll_max + node.visible.h,
            offset: node.scroll.position,
        })
    }

    pub(crate) fn scroll_nodes(&self) -> Vec<NodeId> {
        let mut nodes: Vec<(Vec<usize>, NodeId)> =
            self.scrollables.iter().filter_map(|&id| Some((self.path_from_root(id)?, id))).collect();
        nodes.sort_by(|a, b| a.0.cmp(&b.0));
        nodes.into_iter().map(|(_, id)| id).collect()
    }

    fn path_from_root(&self, id: NodeId) -> Option<Vec<usize>> {
        let mut path = Vec::new();
        let mut current = id;
        while current != self.root {
            let parent = self.get(current)?.parent?;
            path.push(self.get(parent)?.children.iter().position(|&c| c == current)?);
            current = parent;
        }
        path.reverse();
        Some(path)
    }

    pub fn scroll_state(&self, id: NodeId) -> Option<&ScrollState> {
        self.get(id).map(|n| &n.scroll)
    }

    pub fn scroll_state_mut(&mut self, id: NodeId) -> Option<&mut ScrollState> {
        self.get_mut(id).map(|n| &mut n.scroll)
    }

    pub fn scroll_max(&self, id: NodeId) -> f32 {
        self.get(id).map_or(0.0, |n| n.scroll_max)
    }

    pub(crate) fn scrollbar_style(&self, id: NodeId) -> Option<ScrollbarStyle> {
        let node = self.get(id)?;
        Some(
            node.style
                .scrollbar
                .unwrap_or_else(|| ScrollbarStyle::for_rem(self.base_px)),
        )
    }

    pub fn scrollbar_rects(&self, id: NodeId) -> Option<ScrollbarRects> {
        let node = self.get(id)?;
        if node.style.overflow != Overflow::Scroll || node.scroll_max <= 0.0 {
            return None;
        }
        let bar = self.scrollbar_style(id)?;
        scrollbar::rects(
            &bar,
            node.visible,
            node.abs.h,
            node.scroll_max,
            node.scroll.position,
            node.bar.expand,
        )
    }

    pub fn scroll_pos_for_thumb(&self, id: NodeId, thumb_y: f32) -> Option<f32> {
        let rects = self.scrollbar_rects(id)?;
        let node = self.get(id)?;
        Some(scrollbar::pos_for_thumb(&rects, node.scroll_max, thumb_y))
    }

    pub fn scroll_parent(&self, id: NodeId) -> Option<NodeId> {
        let mut current = Some(id);
        while let Some(id) = current {
            let node = self.get(id)?;
            if node.style.overflow == Overflow::Scroll {
                return Some(id);
            }
            current = node.parent;
        }
        None
    }

    pub fn input_geometry(&self, id: NodeId) -> Option<InputGeometry> {
        let state = self.get(id)?.input.as_ref()?;
        let mut geometry = self.text_geometry(id)?;
        geometry.origin.0 -= state.input.scroll_x();
        geometry.caret = state.caret_shape;
        Some(geometry)
    }

    pub(crate) fn content_width(&self, id: NodeId) -> Option<f32> {
        let node = self.get(id)?;
        let layout = self.taffy.layout(node.taffy).ok()?;
        Some((layout.size.width - layout.padding.left - layout.padding.right - layout.border.left - layout.border.right).max(0.0))
    }

    pub fn text_geometry(&self, id: NodeId) -> Option<InputGeometry> {
        let node = self.get(id)?;
        let layout = self.taffy.layout(node.taffy).ok()?;
        let rect = self.rect(id)?;
        Some(InputGeometry {
            origin: (
                rect.x + layout.padding.left + layout.border.left,
                rect.y + layout.padding.top + layout.border.top + node.text_offset_y,
            ),
            font: node.resolved.font,
            px: node.resolved.px,
            caret: CaretShape::Bar,
            max_width: node.style.wrap.then(|| {
                (layout.size.width - layout.padding.left - layout.padding.right - layout.border.left - layout.border.right).max(0.0)
                    + crate::wrap::WRAP_SLACK
            }),
        })
    }

    pub fn offset_at_point(
        &self,
        id: NodeId,
        point: (f32, f32),
        fonts: &[crate::fonts::Font],
    ) -> Option<usize> {
        let text = Tree::text_of(self, id)?;
        let geometry = self.text_geometry(id)?;
        let font = fonts.get(geometry.font).or_else(|| fonts.first())?;
        let marks = self.get(id)?.marks();
        Some(crate::text_input::point_to_offset(
            text,
            point.0 - geometry.origin.0,
            point.1 - geometry.origin.1,
            font,
            geometry.px,
            geometry.max_width,
            marks,
        ))
    }

    pub fn doc_selection(&self) -> Option<DocSelection> {
        self.doc.selection(self)
    }

    pub fn selection_events(&self, id: NodeId) -> bool {
        self.get(id).is_some_and(|node| node.selection_events)
    }

    pub fn doc_scope(&self) -> Option<NodeId> {
        self.doc.scope()
    }

    pub fn doc_selection_snapshot(&self, fonts: &[crate::fonts::Font]) -> Option<SelectionSnapshot> {
        let sel = self.doc_selection()?;
        if sel.is_collapsed() {
            return None;
        }
        let scope = self.doc.scope()?;
        let union = |a: Option<PxRect>, b: PxRect| {
            Some(match a {
                None => b,
                Some(a) => {
                    let x = a.x.min(b.x);
                    let y = a.y.min(b.y);
                    PxRect {
                        x,
                        y,
                        w: (a.x + a.w).max(b.x + b.w) - x,
                        h: (a.y + a.h).max(b.y + b.h) - y,
                    }
                }
            })
        };
        let mut parts = Vec::new();
        let mut rect: Option<PxRect> = None;
        for &id in &self.paint_order {
            let Some(range) = self.doc_selection_range(id) else {
                continue;
            };
            if let Some(v) = self.visible_rect(id)
                && v.w > 0.0
                && v.h > 0.0
            {
                rect = union(rect, v);
            }
            if let Some(key) = self.key_of(id) {
                parts.push((key.to_string(), range));
            }
        }
        let mut bands: Option<PxRect> = None;
        for (_, group, _) in self.doc_selection_blocks(fonts) {
            for band in group {
                bands = union(bands, band);
            }
        }
        Some(SelectionSnapshot {
            scope,
            text: self.doc_selected_text().unwrap_or_default(),
            rect: bands.or(rect)?,
            parts,
        })
    }

    pub fn doc_selection_range(&self, id: NodeId) -> Option<std::ops::Range<usize>> {
        self.doc.selection_range(self, id)
    }

    pub fn doc_selected_text(&self) -> Option<String> {
        self.doc.selected_text(self)
    }

    pub(crate) fn doc_selected_rich(&self) -> Option<crate::selection::RichSelection> {
        self.doc.selected_rich(self)
    }

    pub fn doc_selection_blocks(
        &self,
        fonts: &[crate::fonts::Font],
    ) -> Vec<(NodeId, Vec<PxRect>, Color)> {
        self.doc.blocks(self, fonts)
    }

    fn with_doc<R>(&mut self, f: impl FnOnce(&mut DocSelectionState, &Self) -> R) -> R {
        self.ensure_order();
        self.with_doc_unordered(f)
    }

    fn with_doc_unordered<R>(&mut self, f: impl FnOnce(&mut DocSelectionState, &Self) -> R) -> R {
        let mut doc = std::mem::take(&mut self.doc);
        let out = f(&mut doc, self);
        self.doc = doc;
        out
    }

    pub fn doc_select_down(&mut self, point: (f32, f32), fonts: &[crate::fonts::Font]) -> bool {
        let selected = self.with_doc_unordered(|doc, tree| doc.select_down(tree, point, fonts));
        if self.doc.has_selection() {
            self.ensure_order();
        }
        if selected {
            self.needs_paint = true;
        }
        selected
    }

    pub fn doc_select_down_near(&mut self, point: (f32, f32), fonts: &[crate::fonts::Font]) -> bool {
        let selected = self.with_doc_unordered(|doc, tree| doc.select_down_near(tree, point, fonts));
        if selected {
            self.needs_paint = true;
        }
        selected
    }

    pub fn doc_select_drag(&mut self, point: (f32, f32), fonts: &[crate::fonts::Font]) {
        if self.with_doc(|doc, tree| doc.select_drag(tree, point, fonts)) {
            self.needs_paint = true;
        }
    }

    pub fn doc_select_up(&mut self) {
        self.doc.select_up();
    }

    pub fn doc_select_all(&mut self) -> bool {
        let selected = self.with_doc(|doc, tree| doc.select_all(tree));
        if selected {
            self.needs_paint = true;
        }
        selected
    }

    pub fn doc_collapse(&mut self) -> bool {
        let (had, changed) = if self.doc.has_selection() {
            self.with_doc(|doc, tree| doc.collapse(tree))
        } else {
            self.with_doc_unordered(|doc, tree| doc.collapse(tree))
        };
        if changed {
            self.needs_paint = true;
        }
        had
    }

    pub fn doc_extend(&mut self, left: bool, granularity: Granularity) -> bool {
        let moved = self.with_doc(|doc, tree| doc.extend(tree, left, granularity));
        if moved {
            self.needs_paint = true;
        }
        moved
    }

    pub fn doc_extend_edge(&mut self, up: bool) -> bool {
        let moved = self.with_doc(|doc, tree| doc.extend_edge(tree, up));
        if moved {
            self.needs_paint = true;
        }
        moved
    }

    pub fn doc_extend_vertical(&mut self, up: bool, fonts: &[crate::fonts::Font]) -> bool {
        let moved = self.with_doc(|doc, tree| doc.extend_vertical(tree, up, fonts));
        if moved {
            self.needs_paint = true;
        }
        moved
    }
}

impl DocLayout for Tree {
    fn marks_of(&self, id: NodeId) -> &[crate::text_input::Mark] {
        self.get(id).map_or(&[], |node| node.marks())
    }

    fn paint_order(&self) -> &[NodeId] {
        &self.paint_order
    }

    fn is_text_leaf(&self, id: NodeId) -> bool {
        self.selectable_text_leaf(id)
    }

    fn text_of(&self, id: NodeId) -> Option<&str> {
        Tree::text_of(self, id)
    }

    fn text_geometry(&self, id: NodeId) -> Option<InputGeometry> {
        Tree::text_geometry(self, id)
    }

    fn abs_rect(&self, id: NodeId) -> Option<PxRect> {
        self.rect(id)
    }

    fn visible_rect(&self, id: NodeId) -> Option<PxRect> {
        Tree::visible_rect(self, id)
    }

    fn order_of(&self, id: NodeId) -> Option<u32> {
        Some(self.get(id)?.order)
    }

    fn unified_ancestor(&self, id: NodeId) -> Option<NodeId> {
        let modal = self.modal_root();
        let mut inside_modal = false;
        let mut current = Some(id);
        while let Some(cur) = current {
            let node = self.get(cur)?;
            if node.style.selection_mode == SelectionMode::Unified {
                return Some(if inside_modal { modal? } else { cur });
            }
            inside_modal |= modal == Some(cur);
            current = node.parent;
        }
        None
    }

    fn selection_scope(&self, id: NodeId) -> Option<NodeId> {
        let mut current = Some(id);
        while let Some(cur) = current {
            let node = self.get(cur)?;
            if node.style.overflow == Overflow::Scroll {
                return Some(cur);
            }
            current = node.parent;
        }
        Some(self.root())
    }

    fn scope_at(&self, point: (f32, f32)) -> Option<NodeId> {
        self.nodes_at(point.0, point.1)
            .into_iter()
            .find(|&id| self.node(id).style.overflow == Overflow::Scroll)
            .or_else(|| Some(self.root()))
    }

    fn nodes_at(&self, point: (f32, f32)) -> Vec<NodeId> {
        Tree::nodes_at(self, point.0, point.1)
    }

    fn text_leaves_on_screen(&self) -> Vec<NodeId> {
        let mut leaves = Vec::new();
        let mut stack = vec![self.root];
        while let Some(id) = stack.pop() {
            let node = self.node(id);
            let shown = !node.hidden && !node.offscreen && (node.mark.is_none() || node.mark_visible) && (node.slot.is_none() || node.slot_visible);
            if !shown {
                continue;
            }
            if self.is_text_leaf(id) {
                leaves.push(id);
            }
            stack.extend(node.placed_children().iter().rev());
        }
        leaves
    }

    fn selection_color_of(&self, id: NodeId) -> Option<Color> {
        Some(self.get(id)?.resolved.selection_color)
    }
}
#[cfg(test)]
mod tests;

mod layout;

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
    Color, DEFAULT_SELECTION_COLOR, Dimension, Edges, FlexDirection, Overflow, ScrollbarStyle,
    SelectionMode, Style,
};
use crate::text_input::{Granularity, InputGeometry, TextInput, line_height, offset_to_point};

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

#[derive(Debug, Clone, Copy, PartialEq)]
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
    pub wheel_events: bool,
    pub pointer_events: bool,
    pub hover_events: bool,
    pub outside_click_events: bool,
    pub drag_events: bool,
    pub selection_events: bool,
    pub move_events: bool,
    pub spans: Vec<TextSpan>,
}

pub(crate) struct InputState {
    pub input: TextInput,
    pub caret_color: Color,
    pub selection_color: Color,
    pub submit: bool,
    pub gutter: Option<Gutter>,
    pub active_line: Option<Color>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Resolved {
    pub color: Color,
    pub px: f32,
    pub font: usize,
    pub selectable: bool,
    pub selection_color: Color,
}

pub(crate) struct RNode {
    pub style: Style,
    pub text: Option<String>,
    pub key: Option<String>,
    pub clickable: bool,
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
    pub drag_events: bool,
    pub selection_events: bool,
    pub move_events: bool,
    pub spans: Vec<TextSpan>,
    pub last_scroll_emit: f32,
    pub bar: BarState,
    pub resolved: Resolved,
    pub abs: PxRect,
    pub visible: PxRect,
    pub order: u32,
}

struct Slot {
    generation: u32,
    node: Option<RNode>,
}

impl RNode {
    pub(crate) fn marks(&self) -> &[crate::text_input::Mark] {
        match &self.input {
            Some(state) => state.input.marks(),
            None => &self.static_marks,
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
    image_slot_parents: Vec<NodeId>,
    mark_parents: Vec<NodeId>,
    paint_order: Vec<NodeId>,
    scrollables: Vec<NodeId>,
    focus: Option<NodeId>,
    doc: DocSelectionState,
    base_px: f32,
    needs_layout: bool,
    needs_place: bool,
    needs_paint: bool,
}

pub(crate) const DEFAULT_RESOLVED: Resolved = Resolved {
    color: [255, 255, 255, 255],
    px: 16.0,
    font: 0,
    selectable: true,
    selection_color: DEFAULT_SELECTION_COLOR,
};

impl Tree {
    pub fn new(window: (f32, f32)) -> Self {
        let mut tree = Self {
            slots: Vec::new(),
            free: Vec::new(),
            root: NodeId {
                index: 0,
                generation: 0,
            },
            taffy: TaffyTree::new(),
            keys: HashMap::new(),
            children_dirty: HashSet::new(),
            image_slot_parents: Vec::new(),
            mark_parents: Vec::new(),
            paint_order: Vec::new(),
            scrollables: Vec::new(),
            focus: None,
            doc: DocSelectionState::default(),
            base_px: 16.0,
            needs_layout: true,
            needs_place: true,
            needs_paint: true,
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
        let taffy = self
            .taffy
            .new_leaf(to_taffy(&props.style, props.hidden))
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
            drag_events: props.drag_events,
            selection_events: props.selection_events,
            move_events: props.move_events,
            spans: props.spans,
            last_scroll_emit: 0.0,
            bar: BarState::default(),
            resolved: DEFAULT_RESOLVED,
            abs: PxRect::ZERO,
            visible: PxRect::ZERO,
            order: 0,
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
        if props.input.as_ref().is_some_and(|p| p.auto_focus) {
            self.focus = Some(id);
        }
        self.needs_layout = true;
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
    }
    fn sync_dirty_children(&mut self) {
        let dirty: Vec<NodeId> = self.children_dirty.drain().collect();
        for parent in dirty {
            if self.get(parent).is_none() {
                continue;
            }
            let ids: Vec<taffy::NodeId> = self
                .node(parent)
                .children
                .iter()
                .filter(|&&c| {
                    let node = self.node(c);
                    node.slot.is_none() && node.mark.is_none()
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
        let mut changed = style_changed || node.clickable != props.clickable;
        node.style = props.style;
        node.hidden = props.hidden;
        node.clickable = props.clickable;
        node.scroll_events = props.scroll_events;
        node.wheel_events = props.wheel_events;
        node.pointer_events = props.pointer_events;
        node.hover_events = props.hover_events;
        node.outside_click_events = props.outside_click_events;
        node.drag_events = props.drag_events;
        node.selection_events = props.selection_events;
        node.move_events = props.move_events;
        let mut place_changed = false;
        if node.shape != props.shape {
            node.shape = props.shape;
            changed = true;
        }
        if node.spans != props.spans {
            node.spans = props.spans;
            changed = true;
        }
        let mut image_changed = false;
        if node.image != props.image {
            node.image = props.image;
            changed = true;
            image_changed = true;
        }
        if node.surface != props.surface {
            node.surface = props.surface;
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
        }
        if image_changed {
            self.needs_layout = true;
        }
        if slot_changed || mark_changed {
            if let Some(parent) = self.node(id).parent {
                self.children_dirty.insert(parent);
            }
            self.needs_layout = true;
        }
        let node = self.node_mut(id);
        let mut input_removed = false;
        match (&mut node.input, props.input) {
            (Some(state), Some(p)) => {
                changed |= state.caret_color != p.caret_color
                    || state.selection_color != p.selection_color
                    || state.gutter != p.gutter
                    || state.active_line != p.active_line;
                state.caret_color = p.caret_color;
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
            let (taffy, style, hidden) = {
                let node = self.node(id);
                (node.taffy, node.style.clone(), node.hidden)
            };
            self.taffy
                .set_style(taffy, to_taffy(&style, hidden))
                .expect("taffy style");
            self.needs_layout = true;
        }
        if let Some(value) = controlled_text {
            self.set_input_text(id, &value);
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
        self.needs_layout = true;
    }

    pub(crate) fn input_mut(&mut self, id: NodeId) -> Option<&mut TextInput> {
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
            .set_style(taffy, to_taffy(&style, hidden))
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

    pub(crate) fn mark_paint(&mut self) {
        self.needs_paint = true;
    }

    pub(crate) fn clear_paint_flag(&mut self) {
        self.needs_paint = false;
    }

    pub(crate) fn mark_place(&mut self) {
        self.needs_place = true;
    }

    pub(crate) fn mark_layout(&mut self) {
        self.needs_layout = true;
    }

    pub fn flush_layout(&mut self, fonts: &[fontdue::Font], base_px: f32) {
        assert!(!fonts.is_empty());
        self.base_px = base_px;
        if self.needs_layout {
            crate::profiler::span("tree.sync", || self.sync_dirty_children());
            self.image_slot_parents.clear();
            self.mark_parents.clear();
            crate::profiler::span("tree.resolve", || {
                self.resolve(
                    self.root,
                    Resolved {
                        px: base_px,
                        ..DEFAULT_RESOLVED
                    },
                )
            });
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
            crate::profiler::span("tree.slots", || self.layout_slots(fonts));
            self.needs_layout = false;
            self.needs_place = true;
        }
        if self.needs_place {
            crate::profiler::span("tree.place", || self.place(fonts));
            self.needs_place = false;
            self.needs_paint = true;
        }
    }

    fn resolve(&mut self, id: NodeId, inherited: Resolved) {
        let node = self.node_mut(id);
        let resolved = Resolved {
            color: node.style.color.unwrap_or(inherited.color),
            px: node.style.font_size.unwrap_or(inherited.px),
            font: node.style.font.unwrap_or(inherited.font),
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
        if (is_input || !marks.is_empty()) && children.iter().any(|&c| self.node(c).mark.is_some())
        {
            self.mark_parents.push(id);
        }
        let want = if let Some(image) = image {
            if non_flow_only {
                if !children.is_empty() {
                    self.image_slot_parents.push(id);
                }
                let has_placeholder = children
                    .iter()
                    .any(|&c| self.node(c).slot == Some(SlotKind::Placeholder));
                let status = crate::image_cache::status(&image.src, &image.equal_to);
                let size = if !has_placeholder && status == ImageStatus::Pending {
                    None
                } else {
                    crate::image_cache::image_size(&image.src, &image.equal_to)
                        .or((status == ImageStatus::Failed).then_some((32, 32)))
                };
                Some(MeasureCtx::Image {
                    size,
                    src: image.src,
                })
            } else {
                None
            }
        } else if let Some(text) = text {
            Some(MeasureCtx::Text {
                text,
                px: resolved.px,
                font: resolved.font,
                wrap,
                marks,
            })
        } else {
            None
        };
        if self.taffy.get_node_context(taffy) != want.as_ref() {
            self.taffy
                .set_node_context(taffy, want)
                .expect("taffy context");
            let _ = self.taffy.mark_dirty(taffy);
        }
        for child in children {
            self.resolve(child, resolved);
        }
    }

    fn layout_slots(&mut self, fonts: &[fontdue::Font]) {
        use taffy::prelude::length;
        let parents = self.image_slot_parents.clone();
        for id in parents {
            let Some(node) = self.get(id) else { continue };
            let (image_taffy, children) = (node.taffy, node.children.clone());
            let size = self.taffy.layout(image_taffy).expect("layout").size;
            for child in children {
                let (child_taffy, style, hidden) = {
                    let child = self.node(child);
                    (child.taffy, child.style.clone(), child.hidden)
                };
                let mut taffy_style = to_taffy(&style, hidden);
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

    fn layout_mark_widgets(&mut self, fonts: &[fontdue::Font]) {
        let parents = self.mark_parents.clone();
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
        let node = self.node(id);
        let ctx = MeasureCtx::Text {
            text: node.text.clone().unwrap_or_default(),
            px: node.resolved.px,
            font: node.resolved.font,
            wrap: node.style.wrap,
            marks: node.marks().to_vec(),
        };
        let taffy = node.taffy;
        if self.taffy.get_node_context(taffy) != Some(&ctx) {
            self.taffy
                .set_node_context(taffy, Some(ctx))
                .expect("taffy context");
            let _ = self.taffy.mark_dirty(taffy);
        }
    }

    fn place(&mut self, fonts: &[fontdue::Font]) {
        self.paint_order.clear();
        self.scrollables.clear();
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
        self.place_node(self.root, (0.0, 0.0), Some(window), fonts);
    }

    fn place_node(
        &mut self,
        id: NodeId,
        origin: (f32, f32),
        clip: Option<PxRect>,
        fonts: &[fontdue::Font],
    ) {
        if self.node(id).hidden {
            self.zero_rects(id);
            return;
        }
        let layout = *self.taffy.layout(self.node(id).taffy).expect("layout");
        let rect = PxRect {
            x: origin.0 + layout.location.x,
            y: origin.1 + layout.location.y,
            w: layout.size.width,
            h: layout.size.height,
        };
        let visible = clip.map_or(rect, |c| rect.intersect(c));
        let node = self.node_mut(id);
        node.abs = rect;
        node.visible = visible;
        let scrolls = node.style.overflow == Overflow::Scroll;
        if scrolls {
            let content = node.content_height.unwrap_or(layout.content_size.height);
            node.scroll_max = (content - rect.h).max(0.0);
            let max = node.scroll_max;
            if node.scroll.position > max {
                node.scroll.position = max;
            }
            if node.scroll.target > max {
                node.scroll.target = max;
            }
            self.scrollables.push(id);
        }
        self.node_mut(id).order = self.paint_order.len() as u32;
        self.paint_order.push(id);

        let node = self.node(id);
        let child_origin = if scrolls {
            (rect.x, rect.y - node.scroll.position)
        } else {
            (rect.x, rect.y)
        };
        let child_clip = if node.style.overflow != Overflow::Visible {
            Some(visible)
        } else {
            clip
        };
        let image_src = node.image.clone();
        for child in node.children.clone() {
            if let Some(mark_id) = self.node(child).mark {
                match self.mark_child_origin(id, child, mark_id, fonts) {
                    Some(at) => {
                        self.node_mut(child).mark_visible = true;
                        self.place_node(child, at, Some(visible), fonts);
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
                        self.place_node(child, (rect.x, rect.y), Some(visible), fonts);
                    } else {
                        self.zero_rects(child);
                    }
                }
                (Some(_), None) => {
                    self.node_mut(child).slot_visible = false;
                    self.zero_rects(child);
                }
                (None, _) => self.place_node(child, child_origin, child_clip, fonts),
            }
        }
    }

    fn mark_child_origin(
        &self,
        parent: NodeId,
        child: NodeId,
        mark_id: u64,
        fonts: &[fontdue::Font],
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

    pub fn rect(&self, id: NodeId) -> Option<PxRect> {
        Some(self.get(id)?.abs)
    }

    pub fn visible_rect(&self, id: NodeId) -> Option<PxRect> {
        Some(self.get(id)?.visible)
    }

    pub fn hit_wheel(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id)
                .is_some_and(|node| node.wheel_events && node.visible.contains(x, y))
        })
    }

    // we may want to be more principled with event propagation than this
    pub fn hit_pointer(&self, x: f32, y: f32) -> Option<NodeId> {
        for &id in self.paint_order.iter().rev() {
            let Some(node) = self.get(id) else {
                continue;
            };
            if !node.visible.contains(x, y) {
                continue;
            }
            if node.pointer_events {
                return Some(id);
            }
            if node.clickable || node.input.is_some() {
                return None;
            }
        }
        None
    }

    pub fn hit_drag(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id)
                .is_some_and(|node| node.drag_events && node.visible.contains(x, y))
        })
    }

    pub fn paint_order_of(&self, id: NodeId) -> Option<u32> {
        Some(self.get(id)?.order)
    }

    pub fn hit_move(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id)
                .is_some_and(|node| node.move_events && node.visible.contains(x, y))
        })
    }

    pub fn hit_hover(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id)
                .is_some_and(|node| node.hover_events && node.visible.contains(x, y))
        })
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
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id)
                .is_some_and(|node| node.visible.w > 0.0 && node.visible.contains(x, y))
        })
    }

    pub fn hit_click(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id)
                .is_some_and(|node| node.clickable && node.visible.contains(x, y))
        })
    }

    pub fn outside_click_targets(&self, x: f32, y: f32) -> Vec<NodeId> {
        self.paint_order
            .iter()
            .copied()
            .filter(|&id| {
                self.get(id)
                    .is_some_and(|node| node.outside_click_events && !node.visible.contains(x, y))
            })
            .collect()
    }

    pub fn hover_at(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id).is_some_and(|node| {
                (node.style.hover_background.is_some() || node.style.hover_color.is_some())
                    && node.visible.contains(x, y)
            })
        })
    }

    pub fn hit_target(&self, x: f32, y: f32) -> Option<HitTarget> {
        for &id in self.paint_order.iter().rev() {
            let Some(node) = self.get(id) else {
                continue;
            };
            if !node.visible.contains(x, y) {
                continue;
            }
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
        None
    }

    pub(crate) fn selectable_text_leaf(&self, id: NodeId) -> bool {
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
        self.scrollables
            .iter()
            .rev()
            .copied()
            .find(|&id| self.get(id).is_some_and(|node| node.visible.contains(x, y)))
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
        self.scrollables.clone()
    }

    pub fn scroll_state(&self, id: NodeId) -> Option<&ScrollState> {
        self.get(id).map(|n| &n.scroll)
    }

    pub(crate) fn scroll_state_mut(&mut self, id: NodeId) -> Option<&mut ScrollState> {
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
        self.get(id)?.input.as_ref()?;
        self.text_geometry(id)
    }

    pub fn text_geometry(&self, id: NodeId) -> Option<InputGeometry> {
        let node = self.get(id)?;
        let layout = self.taffy.layout(node.taffy).ok()?;
        Some(InputGeometry {
            origin: (
                node.abs.x + layout.padding.left,
                node.abs.y + layout.padding.top,
            ),
            font: node.resolved.font,
            px: node.resolved.px,
            max_width: node.style.wrap.then(|| {
                (layout.size.width - layout.padding.left - layout.padding.right).max(0.0)
                    + crate::wrap::WRAP_SLACK
            }),
        })
    }

    pub fn offset_at_point(
        &self,
        id: NodeId,
        point: (f32, f32),
        fonts: &[fontdue::Font],
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

    pub fn doc_selection_snapshot(&self, fonts: &[fontdue::Font]) -> Option<SelectionSnapshot> {
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
        fonts: &[fontdue::Font],
    ) -> Vec<(NodeId, Vec<PxRect>, Color)> {
        self.doc.blocks(self, fonts)
    }

    fn with_doc<R>(&mut self, f: impl FnOnce(&mut DocSelectionState, &Self) -> R) -> R {
        let mut doc = std::mem::take(&mut self.doc);
        let out = f(&mut doc, self);
        self.doc = doc;
        out
    }

    pub fn doc_select_down(&mut self, point: (f32, f32), fonts: &[fontdue::Font]) -> bool {
        let selected = self.with_doc(|doc, tree| doc.select_down(tree, point, fonts));
        if selected {
            self.needs_paint = true;
        }
        selected
    }

    pub fn doc_select_down_near(&mut self, point: (f32, f32), fonts: &[fontdue::Font]) -> bool {
        let selected = self.with_doc(|doc, tree| doc.select_down_near(tree, point, fonts));
        if selected {
            self.needs_paint = true;
        }
        selected
    }

    pub fn doc_select_drag(&mut self, point: (f32, f32), fonts: &[fontdue::Font]) {
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
        let (had, changed) = self.with_doc(|doc, tree| doc.collapse(tree));
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

    pub fn doc_extend_vertical(&mut self, up: bool, fonts: &[fontdue::Font]) -> bool {
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
        let mut current = Some(id);
        while let Some(cur) = current {
            let node = self.get(cur)?;
            if node.style.selection_mode == SelectionMode::Unified {
                return Some(cur);
            }
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
        self.paint_order
            .iter()
            .rev()
            .copied()
            .find(|&id| {
                self.get(id).is_some_and(|node| {
                    node.style.overflow == Overflow::Scroll
                        && node.visible.contains(point.0, point.1)
                })
            })
            .or_else(|| Some(self.root()))
    }

    fn selection_color_of(&self, id: NodeId) -> Option<Color> {
        Some(self.get(id)?.resolved.selection_color)
    }
}
#[cfg(test)]
mod tests;

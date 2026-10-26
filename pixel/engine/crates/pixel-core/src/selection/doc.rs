use std::ops::Range;
use std::time::Instant;

use crate::canvas::measure_marked;
use crate::selection::{
    ClickGesture, ClickTracker, DocPos, DocSelection, line_end, line_range_at, line_start,
    next_char, next_word_boundary, prev_char, prev_word_boundary, word_range_at,
};
use crate::style::Color;
use crate::text_input::{
    Granularity, InputGeometry, MARK_CHAR, Mark, line_height, offset_to_point, point_to_offset,
};
use crate::tree::{NodeId, PxRect};
use crate::wrap::{line_of_offset, wrap_lines};

pub(crate) struct RichSelection {
    pub text: String,
    pub marks: Vec<(NodeId, u64, usize, Option<String>)>,
}

pub(crate) trait DocLayout {
    fn paint_order(&self) -> &[NodeId];
    fn marks_of(&self, id: NodeId) -> &[Mark];
    fn is_text_leaf(&self, id: NodeId) -> bool;
    fn text_of(&self, id: NodeId) -> Option<&str>;
    fn text_geometry(&self, id: NodeId) -> Option<InputGeometry>;
    fn abs_rect(&self, id: NodeId) -> Option<PxRect>;
    fn visible_rect(&self, id: NodeId) -> Option<PxRect>;
    fn order_of(&self, id: NodeId) -> Option<u32>;
    fn unified_ancestor(&self, id: NodeId) -> Option<NodeId>;
    fn selection_scope(&self, id: NodeId) -> Option<NodeId>;
    fn scope_at(&self, point: (f32, f32)) -> Option<NodeId>;
    fn selection_color_of(&self, id: NodeId) -> Option<Color>;
}

#[derive(Default)]
pub(crate) struct DocSelectionState {
    selection: Option<DocSelection>,
    clicks: ClickTracker,
    selecting: bool,
    goal_x: Option<f32>,
    scope: Option<NodeId>,
}

impl DocSelectionState {
    pub(crate) fn scope(&self) -> Option<NodeId> {
        self.scope
    }

    pub(crate) fn selection(&self, doc: &impl DocLayout) -> Option<DocSelection> {
        let sel = self.selection?;
        let valid = |pos: DocPos| doc.text_of(pos.node).is_some_and(|t| pos.offset <= t.len());
        (valid(sel.anchor) && valid(sel.focus)).then_some(sel)
    }

    fn range(&self, doc: &impl DocLayout) -> Option<(DocPos, DocPos)> {
        let sel = self.selection(doc)?;
        if sel.is_collapsed() {
            return None;
        }
        let key = |pos: DocPos| (doc.order_of(pos.node).unwrap_or(0), pos.offset);
        Some(if key(sel.anchor) <= key(sel.focus) {
            (sel.anchor, sel.focus)
        } else {
            (sel.focus, sel.anchor)
        })
    }

    pub(crate) fn selection_range(&self, doc: &impl DocLayout, id: NodeId) -> Option<Range<usize>> {
        let (start, end) = self.range(doc)?;
        let text = doc.text_of(id)?;
        let order = doc.order_of(id)?;
        if order < doc.order_of(start.node)? || order > doc.order_of(end.node)? {
            return None;
        }
        if id != start.node && id != end.node && !doc.is_text_leaf(id) {
            return None;
        }
        if self.scope.is_some() && doc.selection_scope(id) != self.scope {
            return None;
        }
        let from = if id == start.node { start.offset } else { 0 };
        let to = if id == end.node {
            end.offset
        } else {
            text.len()
        };
        (from < to).then_some(from..to)
    }

    pub(crate) fn selected_text(&self, doc: &impl DocLayout) -> Option<String> {
        self.selected_rich(doc).map(|rich| {
            rich.text
                .chars()
                .filter(|&c| c != MARK_CHAR)
                .collect::<String>()
        })
    }

    pub(crate) fn selected_rich(&self, doc: &impl DocLayout) -> Option<RichSelection> {
        self.range(doc)?;
        let mut text = String::new();
        let mut marks = Vec::new();
        let mut prev: Option<PxRect> = None;
        for &id in doc.paint_order() {
            let Some(range) = self.selection_range(doc, id) else {
                continue;
            };
            let Some(rect) = doc.abs_rect(id) else {
                continue;
            };
            if let Some(prev) = prev {
                let same_row = rect.y < prev.y + prev.h && rect.y + rect.h > prev.y;
                if !same_row {
                    text.push('\n');
                }
            }
            let base = text.len();
            let node_text = doc.text_of(id).unwrap_or_default();
            text.push_str(&node_text[range.clone()]);
            for mark in doc.marks_of(id) {
                if mark.offset >= range.start && mark.offset < range.end {
                    marks.push((id, mark.id, base + mark.offset - range.start, mark.data.clone()));
                }
            }
            prev = Some(rect);
        }
        (!text.is_empty()).then_some(RichSelection { text, marks })
    }

    pub(crate) fn select_down(
        &mut self,
        doc: &impl DocLayout,
        point: (f32, f32),
        fonts: &[crate::fonts::Font],
    ) -> bool {
        let scope = doc.scope_at(point);
        let Some(pos) = pos_hit(doc, point, fonts, scope) else {
            return false;
        };
        self.scope = scope;
        let gesture = ClickGesture::from_count(self.clicks.register(point, Instant::now()));
        let range = {
            let text = doc.text_of(pos.node).unwrap_or_default();
            match gesture {
                ClickGesture::Place => None,
                ClickGesture::Word => word_range_at(text, pos.offset),
                ClickGesture::Line => Some(line_range_at(text, pos.offset)),
            }
        };
        self.selection = Some(match range {
            Some(range) => DocSelection {
                anchor: DocPos {
                    node: pos.node,
                    offset: range.start,
                },
                focus: DocPos {
                    node: pos.node,
                    offset: range.end,
                },
            },
            None => DocSelection::collapsed(pos),
        });
        self.selecting = gesture == ClickGesture::Place;
        self.goal_x = None;
        true
    }

    pub(crate) fn select_down_near(
        &mut self,
        doc: &impl DocLayout,
        point: (f32, f32),
        fonts: &[crate::fonts::Font],
    ) -> bool {
        let scope = doc.scope_at(point);
        let Some(pos) = pos_near(doc, point, fonts, true, scope) else {
            return false;
        };
        self.scope = scope;
        self.clicks.register(point, Instant::now());
        self.selection = Some(DocSelection::collapsed(pos));
        self.selecting = true;
        self.goal_x = None;
        true
    }

    pub(crate) fn select_drag(
        &mut self,
        doc: &impl DocLayout,
        point: (f32, f32),
        fonts: &[crate::fonts::Font],
    ) -> bool {
        if !self.selecting {
            return false;
        }
        let Some(pos) = pos_near(doc, point, fonts, true, self.scope) else {
            return false;
        };
        if let Some(sel) = &mut self.selection
            && sel.focus != pos
        {
            sel.focus = pos;
            return true;
        }
        false
    }

    pub(crate) fn select_up(&mut self) {
        self.selecting = false;
    }

    pub(crate) fn select_all(&mut self, doc: &impl DocLayout) -> bool {
        let leaves: Vec<NodeId> = doc
            .paint_order()
            .iter()
            .copied()
            .filter(|&id| doc.is_text_leaf(id))
            .collect();
        let (Some(&first), Some(&last)) = (leaves.first(), leaves.last()) else {
            return false;
        };
        let end = doc.text_of(last).map_or(0, str::len);
        self.selection = Some(DocSelection {
            anchor: DocPos {
                node: first,
                offset: 0,
            },
            focus: DocPos {
                node: last,
                offset: end,
            },
        });
        self.goal_x = None;
        self.scope = None;
        true
    }

    pub(crate) fn collapse(&mut self, doc: &impl DocLayout) -> (bool, bool) {
        let had = self.range(doc).is_some();
        let changed = self.selection.take().is_some();
        self.selecting = false;
        self.goal_x = None;
        self.scope = None;
        (had, changed)
    }

    pub(crate) fn invalidate(&mut self, id: NodeId) {
        if let Some(sel) = self.selection
            && (sel.anchor.node == id || sel.focus.node == id)
        {
            self.selection = None;
        }
    }

    pub(crate) fn extend(
        &mut self,
        doc: &impl DocLayout,
        left: bool,
        granularity: Granularity,
    ) -> bool {
        let Some(sel) = self.selection(doc) else {
            return false;
        };
        let focus = sel.focus;
        let text = doc.text_of(focus.node).unwrap_or_default();
        let target = if left {
            if focus.offset > 0 {
                let offset = match granularity {
                    Granularity::Char => prev_char(text, focus.offset),
                    Granularity::Word => prev_word_boundary(text, focus.offset),
                    Granularity::Line => line_start(text, focus.offset),
                };
                Some(DocPos {
                    node: focus.node,
                    offset,
                })
            } else if granularity == Granularity::Line {
                None
            } else {
                adjacent_leaf(doc, focus.node, false).map(|node| {
                    let text = doc.text_of(node).unwrap_or_default();
                    let offset = match granularity {
                        Granularity::Word => prev_word_boundary(text, text.len()),
                        _ => text.len(),
                    };
                    DocPos { node, offset }
                })
            }
        } else if focus.offset < text.len() {
            let offset = match granularity {
                Granularity::Char => next_char(text, focus.offset),
                Granularity::Word => next_word_boundary(text, focus.offset),
                Granularity::Line => line_end(text, focus.offset),
            };
            Some(DocPos {
                node: focus.node,
                offset,
            })
        } else if granularity == Granularity::Line {
            None
        } else {
            adjacent_leaf(doc, focus.node, true).map(|node| {
                let text = doc.text_of(node).unwrap_or_default();
                let offset = match granularity {
                    Granularity::Word => next_word_boundary(text, 0),
                    _ => 0,
                };
                DocPos { node, offset }
            })
        };
        self.move_focus(target)
    }

    pub(crate) fn extend_edge(&mut self, doc: &impl DocLayout, up: bool) -> bool {
        if self.selection(doc).is_none() {
            return false;
        }
        let edge = if up {
            doc.paint_order()
                .iter()
                .copied()
                .find(|&id| doc.is_text_leaf(id))
                .map(|node| DocPos { node, offset: 0 })
        } else {
            doc.paint_order()
                .iter()
                .rev()
                .copied()
                .find(|&id| doc.is_text_leaf(id))
                .map(|node| DocPos {
                    node,
                    offset: doc.text_of(node).map_or(0, str::len),
                })
        };
        self.move_focus(edge)
    }

    pub(crate) fn extend_vertical(
        &mut self,
        doc: &impl DocLayout,
        up: bool,
        fonts: &[crate::fonts::Font],
    ) -> bool {
        let Some(sel) = self.selection(doc) else {
            return false;
        };
        let focus = sel.focus;
        let Some(geometry) = doc.text_geometry(focus.node) else {
            return false;
        };
        let Some(text) = doc.text_of(focus.node) else {
            return false;
        };
        let font = &fonts[geometry.font.min(fonts.len() - 1)];
        let px = geometry.px;
        let marks = doc.marks_of(focus.node);
        let lines = wrap_lines(text, font, px, geometry.max_width, marks);
        let line = line_of_offset(&lines, focus.offset);
        let line_h = line_height(font, px);
        let local_x = measure_marked(font, text, lines[line].start..focus.offset, px, marks);
        let goal_x = self.goal_x.unwrap_or(geometry.origin.0 + local_x);
        let within = if up { line > 0 } else { line + 1 < lines.len() };
        let target = if within {
            let target_line = if up { line - 1 } else { line + 1 };
            let y = (target_line as f32 + 0.5) * line_h;
            Some(DocPos {
                node: focus.node,
                offset: point_to_offset(
                    text,
                    goal_x - geometry.origin.0,
                    y,
                    font,
                    px,
                    geometry.max_width,
                    marks,
                ),
            })
        } else {
            let Some(rect) = doc.abs_rect(focus.node) else {
                return false;
            };
            let y = if up {
                rect.y - line_h * 0.5
            } else {
                rect.y + rect.h + line_h * 0.5
            };
            match pos_near(doc, (goal_x, y), fonts, false, self.scope) {
                Some(pos) if pos.node != focus.node => Some(pos),
                _ => Some(DocPos {
                    node: focus.node,
                    offset: if up { 0 } else { text.len() },
                }),
            }
        };
        if !self.move_focus(target) {
            return false;
        }
        self.goal_x = Some(goal_x);
        true
    }

    fn move_focus(&mut self, target: Option<DocPos>) -> bool {
        let Some(target) = target else {
            return false;
        };
        let Some(sel) = &mut self.selection else {
            return false;
        };
        if sel.focus == target {
            return false;
        }
        sel.focus = target;
        self.goal_x = None;
        true
    }

    pub(crate) fn blocks(
        &self,
        doc: &impl DocLayout,
        fonts: &[crate::fonts::Font],
    ) -> Vec<(NodeId, Vec<PxRect>, Color)> {
        let Some((start, end)) = self.range(doc) else {
            return Vec::new();
        };
        let mut groups: Vec<(NodeId, DocPos, DocPos)> = Vec::new();
        for &id in doc.paint_order() {
            let Some(range) = self.selection_range(doc, id) else {
                continue;
            };
            let Some(container) = doc.unified_ancestor(id) else {
                continue;
            };
            let last = DocPos {
                node: id,
                offset: range.end,
            };
            match groups.iter_mut().find(|(c, _, _)| *c == container) {
                Some((_, _, group_last)) => *group_last = last,
                None => groups.push((
                    container,
                    DocPos {
                        node: id,
                        offset: range.start,
                    },
                    last,
                )),
            }
        }
        groups
            .into_iter()
            .filter_map(|(container, first, last)| {
                let rect = doc.abs_rect(container)?;
                let color = doc.selection_color_of(container)?;
                let (cx1, y1, h1) = caret_point(doc, first, fonts)?;
                let (cx2, y2, h2) = caret_point(doc, last, fonts)?;
                let x1 = if first == start { cx1 } else { rect.x };
                let x2 = if last == end { cx2 } else { rect.x + rect.w };
                let mut bands = Vec::new();
                if (y1 - y2).abs() < 0.5 {
                    bands.push(PxRect {
                        x: x1,
                        y: y1,
                        w: (x2 - x1).max(1.0),
                        h: h1.max(h2),
                    });
                } else {
                    bands.push(PxRect {
                        x: x1,
                        y: y1,
                        w: (rect.x + rect.w - x1).max(0.0),
                        h: h1,
                    });
                    if y2 > y1 + h1 {
                        bands.push(PxRect {
                            x: rect.x,
                            y: y1 + h1,
                            w: rect.w,
                            h: y2 - (y1 + h1),
                        });
                    }
                    bands.push(PxRect {
                        x: rect.x,
                        y: y2,
                        w: (x2 - rect.x).max(0.0),
                        h: h2,
                    });
                }
                Some((container, bands, color))
            })
            .collect()
    }
}

fn offset_at(doc: &impl DocLayout, id: NodeId, point: (f32, f32), fonts: &[crate::fonts::Font]) -> usize {
    match (doc.text_geometry(id), doc.text_of(id)) {
        (Some(geometry), Some(text)) => geometry.offset_at(text, doc.marks_of(id), point, fonts),
        _ => 0,
    }
}

fn pos_hit(
    doc: &impl DocLayout,
    point: (f32, f32),
    fonts: &[crate::fonts::Font],
    scope: Option<NodeId>,
) -> Option<DocPos> {
    let id = doc.paint_order().iter().rev().copied().find(|&id| {
        doc.is_text_leaf(id)
            && (scope.is_none() || doc.selection_scope(id) == scope)
            && doc
                .visible_rect(id)
                .is_some_and(|v| v.contains(point.0, point.1))
    })?;
    Some(DocPos {
        node: id,
        offset: offset_at(doc, id, point, fonts),
    })
}

fn pos_near(
    doc: &impl DocLayout,
    point: (f32, f32),
    fonts: &[crate::fonts::Font],
    clamp_to_ends: bool,
    scope: Option<NodeId>,
) -> Option<DocPos> {
    if let Some(pos) = pos_hit(doc, point, fonts, scope) {
        return Some(pos);
    }
    let mut best: Option<(f32, f32, NodeId)> = None;
    for &id in doc.paint_order() {
        if !doc.is_text_leaf(id) {
            continue;
        }
        if scope.is_some() && doc.selection_scope(id) != scope {
            continue;
        }
        let Some(v) = doc.visible_rect(id) else {
            continue;
        };
        if v.w <= 0.0 || v.h <= 0.0 {
            continue;
        }
        let dy = (v.y - point.1).max(point.1 - (v.y + v.h)).max(0.0);
        let dx = (v.x - point.0).max(point.0 - (v.x + v.w)).max(0.0);
        let closer = best.is_none_or(|(by, bx, _)| dy < by || (dy == by && dx < bx));
        if closer {
            best = Some((dy, dx, id));
        }
    }
    let (_, _, id) = best?;
    let v = doc.visible_rect(id)?;
    let offset = if clamp_to_ends && point.1 >= v.y + v.h {
        doc.text_of(id).map_or(0, str::len)
    } else if clamp_to_ends && point.1 < v.y {
        0
    } else {
        offset_at(doc, id, point, fonts)
    };
    Some(DocPos { node: id, offset })
}

fn adjacent_leaf(doc: &impl DocLayout, id: NodeId, forward: bool) -> Option<NodeId> {
    let order = doc.paint_order();
    let at = order.iter().position(|&n| n == id)?;
    if forward {
        order[at + 1..]
            .iter()
            .copied()
            .find(|&n| doc.is_text_leaf(n))
    } else {
        order[..at]
            .iter()
            .rev()
            .copied()
            .find(|&n| doc.is_text_leaf(n))
    }
}

fn caret_point(doc: &impl DocLayout, pos: DocPos, fonts: &[crate::fonts::Font]) -> Option<(f32, f32, f32)> {
    let geometry = doc.text_geometry(pos.node)?;
    let text = doc.text_of(pos.node)?;
    let font = &fonts[geometry.font.min(fonts.len() - 1)];
    let (x, y) = offset_to_point(
        text,
        pos.offset,
        font,
        geometry.px,
        geometry.max_width,
        doc.marks_of(pos.node),
    );
    Some((
        geometry.origin.0 + x,
        geometry.origin.1 + y,
        line_height(font, geometry.px),
    ))
}

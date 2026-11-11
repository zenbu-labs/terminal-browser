use std::time::Instant;

use super::{Engine, EngineEvent};
use crate::input::Mods;
use crate::tree::NodeId;

const PINCH_WHEEL_SCALE: f32 = 100.0;

impl Engine {
    pub(super) fn animating(&self) -> bool {
        let scrolling = self.comp.active_views().into_iter().any(|view| {
            let tree = &self.comp.views[view].tree;
            tree.scroll_nodes()
                .iter()
                .any(|&id| tree.scroll_state(id).is_some_and(|s| !s.settled()))
        });
        scrolling || self.bars_animating() || self.backend.animating() || self.backend.pending_present()
    }

    pub(super) fn moving(&self) -> bool {
        self.comp.active_views().into_iter().any(|view| {
            let tree = &self.comp.views[view].tree;
            tree.scroll_nodes().iter().any(|&id| {
                let fading = tree.bar_opacity(id) > 0.0 && tree.bar_opacity(id) < 1.0;
                fading || tree.scroll_state(id).is_some_and(|s| !s.settled())
            })
        }) || self.backend.animating()
    }

    pub(super) fn bar_at(&self, view: usize, point: (f32, f32)) -> Option<NodeId> {
        let tree = &self.comp.views[view].tree;
        tree.scroll_nodes().into_iter().rev().find(|&id| {
            !tree.inert(id)
                && tree.bar_opacity(id) > 0.1
                && tree
                    .scrollbar_rects(id)
                    .is_some_and(|r| r.zone.contains(point.0, point.1))
        })
    }

    pub(super) fn begin_bar_drag(&mut self, view: usize, point: (f32, f32)) -> bool {
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

    pub(super) fn drag_bar_to(&mut self, view: usize, id: NodeId, thumb_y: f32) {
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

    pub(super) fn step_bars(&mut self, dt: f32) {
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

    pub(super) fn rows_pending(&self) -> bool {
        self.comp.active_views().into_iter().any(|view| self.comp.views[view].tree.rows_pending())
    }

    pub(super) fn catch_up_rows(&mut self, busy: bool) {
        let until = if busy {
            self.frame_slot + self.frame_interval().saturating_sub(super::ROW_CATCH_UP_MARGIN)
        } else {
            Instant::now() + super::ROW_CATCH_UP_BUDGET
        };
        if until <= Instant::now() {
            return;
        }
        for view in self.comp.active_views() {
            let tree = &mut self.comp.views[view].tree;
            if tree.rows_pending() {
                tree.catch_up_rows(&self.fonts, until);
            }
        }
    }

    pub(super) fn give_spare_time(&mut self, busy: bool) {
        let until = if busy {
            self.frame_slot + self.frame_interval().saturating_sub(super::ROW_CATCH_UP_MARGIN)
        } else {
            Instant::now() + super::ROW_CATCH_UP_BUDGET
        };
        if until > Instant::now() {
            self.backend.spare(&self.fonts, until);
        }
    }

    pub(super) fn emit_scroll_events(&mut self, out: &mut Vec<EngineEvent>) {
        for view in self.comp.active_views() {
            let tree = &mut self.comp.views[view].tree;
            for (node, stuck) in tree.take_stick_changes() {
                let key = tree.key_of(node).map(str::to_string);
                out.push(EngineEvent::Stick { view, node, key, stuck });
            }
        }
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

    pub fn scroll_into_view(&mut self, view: usize, id: NodeId, smooth: bool) {
        self.scroll_requests.push((view, ScrollRequest::IntoView(id), smooth));
    }

    pub fn scroll_to(&mut self, view: usize, id: NodeId, offset: f32, smooth: bool) {
        self.scroll_requests.push((view, ScrollRequest::To(id, offset), smooth));
    }

    pub fn scroll_by(&mut self, view: usize, id: NodeId, delta: f32) {
        self.scroll_requests.push((view, ScrollRequest::By(id, delta), false));
    }

    pub(super) fn apply_scroll_requests(&mut self) {
        for (view, request, smooth) in std::mem::take(&mut self.scroll_requests) {
            if view >= self.comp.views.len() {
                continue;
            }
            let fonts = &mut self.fonts;
            let base_px = self.base_px;
            let tree = &mut self.comp.views[view].tree;
            tree.flush_layout(fonts, base_px);
            match request {
                ScrollRequest::IntoView(id) => {
                    if let Some((ancestor, y)) = scroll_ancestor_offset(tree, id) {
                        set_scroll(tree, ancestor, y - base_px * 0.5, smooth);
                    }
                }
                ScrollRequest::To(id, offset) => set_scroll(tree, id, offset, smooth),
                ScrollRequest::By(id, delta) => scroll_by(tree, id, delta),
            }
        }
    }

    pub(super) fn pinch(&mut self, at: Option<(f32, f32)>, magnification: f32, out: &mut Vec<EngineEvent>) {
        let point = self.pointer_or_center(at);
        let view = self.comp.view_at(point.0);
        self.mark_scroll(view);
        let local = self.comp.to_local(view, point);
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

    pub(super) fn wheel_steps(
        &mut self,
        at: Option<(f32, f32)>,
        steps: &[(f32, f32)],
        mods: Mods,
        out: &mut Vec<EngineEvent>,
    ) {
        if steps.is_empty() {
            return;
        }
        let point = self.pointer_or_center(at);
        let view = self.comp.view_at(point.0);
        self.mark_scroll(view);
        let local = self.comp.to_local(view, point);
        let delta = steps.iter().fold((0.0, 0.0), |sum, step| (sum.0 + step.0, sum.1 + step.1));
        if self.emit_wheel(view, local, delta.0, delta.1, true, mods, out) {
            return;
        }
        let Some(area) = self.comp.views[view].tree.scroll_area_at(local.0, local.1) else {
            return;
        };
        let (node, max) = (area.node, area.max_scroll());
        let mut moved = false;
        if let Some(state) = self.comp.views[view].tree.scroll_state_mut(node) {
            for (_, dy) in steps {
                let next = (state.position + dy).clamp(0.0, max);
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

    fn pointer_or_center(&self, at: Option<(f32, f32)>) -> (f32, f32) {
        at.or(self.cursor).unwrap_or((
            self.comp.window.0 as f32 / 2.0,
            self.comp.window.1 as f32 / 2.0,
        ))
    }

    pub(super) fn step_scrolls(&mut self, dt: f32) {
        let profile = self.profile.clone();
        for view in self.comp.active_views() {
            let tree = &mut self.comp.views[view].tree;
            for id in tree.scroll_nodes() {
                let max = tree.scroll_max(id);
                if let Some(state) = tree.scroll_state_mut(id)
                    && state.step(profile.as_ref(), dt, max)
                {
                    tree.mark_place();
                    tree.touch_bar(id);
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) enum ScrollRequest {
    IntoView(NodeId),
    To(NodeId, f32),
    By(NodeId, f32),
}

fn scroll_ancestor_offset(tree: &crate::tree::Tree, id: NodeId) -> Option<(NodeId, f32)> {
    let mut current = tree.parent(id);
    while let Some(ancestor) = current {
        current = tree.parent(ancestor);
        if tree.scroll_max(ancestor) > 0.0 {
            return Some((ancestor, tree.content_y(id, ancestor)?));
        }
    }
    None
}

fn scroll_by(tree: &mut crate::tree::Tree, id: NodeId, delta: f32) {
    if let Some(position) = tree.scroll_state(id).map(|state| state.position) {
        set_scroll(tree, id, position + delta, false);
    }
}

fn set_scroll(tree: &mut crate::tree::Tree, id: NodeId, offset: f32, smooth: bool) {
    let offset = offset.clamp(0.0, tree.scroll_max(id));
    let view = tree.rect(id).map_or(0.0, |r| r.h);
    if let Some(state) = tree.scroll_state_mut(id) {
        if smooth {
            if (offset - state.position).abs() > view {
                state.position = offset - view.copysign(offset - state.position);
                tree.mark_place();
            }
            let Some(state) = tree.scroll_state_mut(id) else { return };
            state.set_target(offset);
        } else {
            state.position = offset;
            state.set_target(offset);
            tree.mark_place();
        }
        tree.touch_bar(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desc::Desc;
    use crate::style::{Dimension, Layout, Overflow, Style};

    #[test]
    fn a_smooth_scroll_to_a_far_target_starts_a_viewport_away_from_it() {
        let mut tree = crate::tree::Tree::new((40.0, 100.0));
        let row = |i: usize| Desc { style: Style { height: Dimension::Px(20.0), ..Style::default() }, key: Some(format!("row{i}")), ..Desc::default() };
        tree.reconcile(Desc {
            children: vec![Desc {
                style: Style { width: Dimension::Px(40.0), height: Dimension::Px(100.0), overflow: Overflow::Scroll, layout: Layout::List, ..Style::default() },
                key: Some("list".into()),
                children: (0..100).map(row).collect(),
                ..Desc::default()
            }],
            ..Desc::default()
        });
        let mut fonts = crate::fonts::FontRegistry::bundled();
        tree.flush_layout(&mut fonts, 16.0);
        let list = tree.find("list").unwrap();
        set_scroll(&mut tree, list, 1900.0, true);
        let state = tree.scroll_state(list).unwrap();
        assert_eq!((state.position, state.target), (1800.0, 1900.0));
        set_scroll(&mut tree, list, 1850.0, true);
        assert_eq!(tree.scroll_state(list).unwrap().position, 1800.0, "near targets animate the whole way");
    }

    #[test]
    fn scrolls_by_add_up_from_where_the_list_is() {
        let mut tree = crate::tree::Tree::new((40.0, 100.0));
        let row = |i: usize| Desc { style: Style { height: Dimension::Px(20.0), ..Style::default() }, key: Some(format!("row{i}")), ..Desc::default() };
        tree.reconcile(Desc {
            children: vec![Desc {
                style: Style { width: Dimension::Px(40.0), height: Dimension::Px(100.0), overflow: Overflow::Scroll, layout: Layout::List, ..Style::default() },
                key: Some("list".into()),
                children: (0..10).map(row).collect(),
                ..Desc::default()
            }],
            ..Desc::default()
        });
        let mut fonts = crate::fonts::FontRegistry::bundled();
        tree.flush_layout(&mut fonts, 16.0);
        let list = tree.find("list").unwrap();
        set_scroll(&mut tree, list, 30.0, false);
        scroll_by(&mut tree, list, 25.0);
        scroll_by(&mut tree, list, 25.0);
        assert_eq!(tree.scroll_state(list).unwrap().position, 80.0);
        scroll_by(&mut tree, list, 500.0);
        assert_eq!(tree.scroll_state(list).unwrap().position, 100.0, "stops at the end");
    }
}

use std::time::{Duration, Instant};

use super::hover::Verdict;
use super::{Engine, EngineEvent};
use crate::logging;
use crate::terminal::Mods;
use crate::tree::NodeId;

const PINCH_HOVER_WINDOW: Duration = Duration::from_millis(2000);
const PINCH_WHEEL_SCALE: f32 = 100.0;

impl Engine {
    pub(super) fn animating(&self) -> bool {
        let scrolling = self.comp.active_views().into_iter().any(|view| {
            let tree = &self.comp.views[view].tree;
            tree.scroll_nodes()
                .iter()
                .any(|&id| tree.scroll_state(id).is_some_and(|s| !s.settled()))
        });
        scrolling || self.bars_animating()
    }

    pub(super) fn bar_at(&self, view: usize, point: (f32, f32)) -> Option<NodeId> {
        let tree = &self.comp.views[view].tree;
        tree.scroll_nodes().into_iter().rev().find(|&id| {
            tree.bar_opacity(id) > 0.1
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

    pub(super) fn emit_scroll_events(&mut self, out: &mut Vec<EngineEvent>) {
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

    fn pane_extent(&self) -> ((f32, f32), (f32, f32)) {
        (
            (self.comp.window.0 as f32, self.comp.window.1 as f32),
            (self.cell.0 as f32, self.cell.1 as f32),
        )
    }

    pub(super) fn ingest_native(&mut self) {
        let Some(native) = &mut self.native else {
            return;
        };
        let events = native.drain();
        let scale = native.scale;
        if native.dead() {
            logging::warn(
                "engine",
                "native scroll helper exited; falling back to wheel ticks",
            );
            self.native = None;
            self.pairing.reset();
            self.hover_oracle.invalidate();
            return;
        }
        if !self.use_native {
            return;
        }
        let now = Instant::now();
        let (pane, pad) = self.pane_extent();
        self.pairing
            .ingest(events, scale, now, &mut self.hover_oracle, pane, pad);
        let wants_cursor = self.pixel_mouse && self.hover_oracle.wants_cursor(now);
        if let Some(native) = &mut self.native {
            native.request_positions(wants_cursor);
        }
    }

    pub(super) fn drain_native(&mut self, out: &mut Vec<EngineEvent>) {
        self.ingest_native();
        let (zoom, scrolls) = self.pairing.take();
        let (pane, pad) = self.pane_extent();
        let pinch_here = match self.hover_oracle.verdict(Instant::now(), pane, pad) {
            Verdict::Deliver => true,
            Verdict::Discard => false,
            Verdict::Unknown => self
                .last_pointer_activity
                .is_some_and(|at| at.elapsed() < PINCH_HOVER_WINDOW),
        };
        let magnification = zoom - 1.0;
        if (magnification == 0.0 || !pinch_here) && scrolls.is_empty() {
            return;
        }
        let cursor = self.cursor.unwrap_or((
            self.comp.window.0 as f32 / 2.0,
            self.comp.window.1 as f32 / 2.0,
        ));
        let view = self.comp.view_at(cursor.0);
        self.mark_scroll(view);
        let local = self.comp.to_local(view, cursor);
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
        if self.comp.views[view]
            .tree
            .hit_wheel(local.0, local.1)
            .is_some()
        {
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

    pub(super) fn step_scrolls(&mut self, dt: f32) {
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
}

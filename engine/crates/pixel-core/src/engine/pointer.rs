use std::io;
use std::time::Instant;

use super::{DragPhase, Engine, EngineEvent};
use crate::menu::MenuClick;
use crate::terminal::{Mods, Mouse, MouseButton, MouseKind};
use crate::tree::{HitTarget, NodeId};

const WHEEL_ECHO_WINDOW: std::time::Duration = std::time::Duration::from_millis(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DragTarget {
    Input(NodeId),
    Text,
    Node(NodeId),
}

impl Engine {
    pub(super) fn handle_mouse(
        &mut self,
        mouse: Mouse,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let point = (mouse.x as f32, mouse.y as f32);
        self.cursor = Some(point);
        let now = Instant::now();
        self.last_pointer_activity = Some(now);
        if matches!(mouse.kind, MouseKind::Down | MouseKind::Up) {
            self.focus_click = None;
            self.last_pointer_click = Some(now);
        }
        let scrolling = matches!(
            mouse.kind,
            MouseKind::ScrollUp
                | MouseKind::ScrollDown
                | MouseKind::ScrollLeft
                | MouseKind::ScrollRight
        );
        // this is a weird case that I observed where inside kitty 2 scroll events
        // were being emitted per scroll tick. This is very suspicious and makes me
        // suspicious that something else was the casue of this, but this is a temporary
        // work around for now
        if scrolling {
            let echo = !self.wheel_echo_consumed
                && self.last_wheel_tick.is_some_and(|(at, kind, x, y, mods)| {
                    kind == mouse.kind
                        && x == mouse.x
                        && y == mouse.y
                        && mods == mouse.mods
                        && now.duration_since(at) < WHEEL_ECHO_WINDOW
                });
            if echo {
                self.wheel_echo_consumed = true;
                return Ok(());
            }
            self.wheel_echo_consumed = false;
            self.last_wheel_tick = Some((now, mouse.kind, mouse.x, mouse.y, mouse.mods));
        }
        if self.use_native && self.native.is_some() {
            self.ingest_native();
            let located = self.pixel_mouse.then_some(point);
            if scrolling && mouse.mods == Mods::default() {
                if self
                    .pairing
                    .on_wheel_tick(located, now, &mut self.hover_oracle)
                {
                    return Ok(());
                }
            } else if let Some(located) = located {
                self.hover_oracle.note_local(located, now);
            }
        }
        if matches!(
            mouse.kind,
            MouseKind::Down | MouseKind::Up | MouseKind::Move
        ) && self.forward_pointer(mouse, point, out)
        {
            return Ok(());
        }
        if mouse.kind == MouseKind::Down {
            self.key_passthrough = false;
        }
        match mouse.kind {
            MouseKind::Down if mouse.button == MouseButton::Left => {
                self.mark_pointer("click", point);
                if self.handle_menu_click(point, out)? {
                    return Ok(());
                }
                if self.comp.on_divider(point.0) {
                    if crate::profiler::is_recording() {
                        crate::profiler::mark("drag", 0, "divider drag".into());
                    }
                    self.comp.divider_drag = true;
                    self.comp.dirty = true;
                    return Ok(());
                }
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                self.active_view = view;
                if let Some((focus_view, _)) = self.focused()
                    && focus_view != view
                {
                    self.comp.views[focus_view].tree.set_focus(None);
                }
                if self.inspect_mode && view == self.inspect_view {
                    self.finish_inspect(local, out);
                    return Ok(());
                }
                for node in self.comp.views[view]
                    .tree
                    .outside_click_targets(local.0, local.1)
                {
                    out.push(EngineEvent::ClickOutside {
                        view,
                        node,
                        key: self.comp.views[view].tree.key_of(node).map(str::to_string),
                        x: local.0,
                        y: local.1,
                    });
                }
                if self.begin_bar_drag(view, local) {
                    return Ok(());
                }
                let drag_node = self.comp.views[view]
                    .tree
                    .hit_drag(local.0, local.1)
                    .filter(|&id| {
                        let tree = &self.comp.views[view].tree;
                        let drag_order = tree.paint_order_of(id).unwrap_or(0);
                        let covered = match tree.hit_target(local.0, local.1) {
                            Some(HitTarget::Input(t)) | Some(HitTarget::Click(t)) => {
                                tree.paint_order_of(t).unwrap_or(0) > drag_order
                            }
                            _ => false,
                        };
                        !covered
                    });
                if let Some(id) = drag_node {
                    self.drag = Some((view, DragTarget::Node(id)));
                    out.push(EngineEvent::Drag {
                        view,
                        node: id,
                        key: self.comp.views[view].tree.key_of(id).map(str::to_string),
                        phase: DragPhase::Start,
                        x: local.0,
                        y: local.1,
                        mods: mouse.mods,
                    });
                    return Ok(());
                }
                let node = match self.comp.views[view].tree.hit_target(local.0, local.1) {
                    Some(HitTarget::Input(id)) => {
                        self.clear_doc_selections(None);
                        self.set_focus(view, Some(id));
                        self.drag = Some((view, DragTarget::Input(id)));
                        self.forward_mouse(view, id, &mouse, out)?;
                        Some(id)
                    }
                    Some(HitTarget::Click(id)) => {
                        self.begin_text_selection(view, local);
                        Some(id)
                    }
                    Some(HitTarget::Text(_)) => {
                        self.begin_text_selection(view, local);
                        None
                    }
                    None => {
                        self.begin_text_selection(view, local);
                        None
                    }
                };
                if let Some(node) = node {
                    out.push(EngineEvent::Click {
                        view,
                        node,
                        key: self.comp.views[view].tree.key_of(node).map(str::to_string),
                        x: local.0,
                        y: local.1,
                        offset: self.comp.views[view].tree.offset_at_point(
                            node,
                            local,
                            &self.fonts,
                        ),
                    });
                }
            }
            MouseKind::Down if mouse.button == MouseButton::Right => {
                self.mark_pointer("right-click", point);
                self.close_menu();
                if self.comp.on_divider(point.0) {
                    return Ok(());
                }
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                self.active_view = view;
                if self.default_menu {
                    self.open_menu(view, local);
                }
                out.push(EngineEvent::RightClick {
                    view,
                    x: local.0,
                    y: local.1,
                });
            }
            MouseKind::Move => {
                if self.comp.divider_drag {
                    let resized = self.comp.drag_divider(point.0);
                    self.push_resizes(resized);
                    return Ok(());
                }
                let divider_hover = self.comp.on_divider(point.0);
                self.comp.set_divider_hover(divider_hover);
                if let Some((view, id, grab)) = self.bar_drag {
                    let local = self.comp.to_local(view, point);
                    self.drag_bar_to(view, id, local.1 - grab);
                    return Ok(());
                }
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                if self.inspect_mode {
                    let over = (view == self.inspect_view)
                        .then(|| self.comp.views[view].tree.hit_any(local.0, local.1))
                        .flatten();
                    if over != self.inspect_hover {
                        self.inspect_hover = over;
                        self.comp.dirty = true;
                    }
                }
                let bar_hover = self.bar_at(view, local).map(|id| (view, id));
                if bar_hover != self.bar_hover {
                    self.bar_hover = bar_hover;
                    self.comp.views[view].tree.mark_paint();
                }
                let hover = self.comp.views[view]
                    .tree
                    .hover_at(local.0, local.1)
                    .map(|id| (view, id));
                if hover != self.hover {
                    if let Some((old, _)) = self.hover {
                        self.comp.views[old].tree.mark_paint();
                    }
                    if let Some((new, _)) = hover {
                        self.comp.views[new].tree.mark_paint();
                    }
                    self.hover = hover;
                }
                self.update_hover_target(view, local, out);
                if let Some(id) = self.comp.views[view].tree.hit_move(local.0, local.1) {
                    out.push(EngineEvent::MouseMove {
                        view,
                        node: id,
                        key: self.comp.views[view].tree.key_of(id).map(str::to_string),
                        x: local.0,
                        y: local.1,
                    });
                }
                if let Some((view, target)) = self.drag {
                    let local = self.comp.to_local(view, point);
                    match target {
                        DragTarget::Input(id) => {
                            let translated = Mouse {
                                x: local.0.max(0.0) as u32,
                                y: local.1.max(0.0) as u32,
                                ..mouse
                            };
                            self.forward_mouse(view, id, &translated, out)?;
                        }
                        DragTarget::Text => {
                            let fonts = &self.fonts;
                            self.comp.views[view]
                                .tree
                                .doc_select_drag((local.0, local.1), fonts);
                            if let Some((focus_view, _)) = self.focused()
                                && self.comp.views[view]
                                    .tree
                                    .doc_selection()
                                    .is_some_and(|sel| !sel.is_collapsed())
                            {
                                self.comp.views[focus_view].tree.set_focus(None);
                            }
                        }
                        DragTarget::Node(id) => {
                            out.push(EngineEvent::Drag {
                                view,
                                node: id,
                                key: self.comp.views[view].tree.key_of(id).map(str::to_string),
                                phase: DragPhase::Move,
                                x: local.0,
                                y: local.1,
                                mods: mouse.mods,
                            });
                        }
                    }
                }
            }
            MouseKind::Up => {
                self.comp.divider_drag = false;
                self.bar_drag = None;
                if let Some((view, target)) = self.drag.take() {
                    match target {
                        DragTarget::Input(id) => {
                            let local = self.comp.to_local(view, point);
                            let translated = Mouse {
                                x: local.0.max(0.0) as u32,
                                y: local.1.max(0.0) as u32,
                                ..mouse
                            };
                            self.forward_mouse(view, id, &translated, out)?;
                        }
                        DragTarget::Text => self.comp.views[view].tree.doc_select_up(),
                        DragTarget::Node(id) => {
                            let local = self.comp.to_local(view, point);
                            out.push(EngineEvent::Drag {
                                view,
                                node: id,
                                key: self.comp.views[view].tree.key_of(id).map(str::to_string),
                                phase: DragPhase::End,
                                x: local.0,
                                y: local.1,
                                mods: mouse.mods,
                            });
                        }
                    }
                }
            }
            MouseKind::ScrollLeft | MouseKind::ScrollRight => {
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                let delta = if mouse.kind == MouseKind::ScrollLeft {
                    -(self.cell.0 as f32)
                } else {
                    self.cell.0 as f32
                };
                self.emit_wheel(view, local, delta, 0.0, false, mouse.mods, out);
            }
            // Reaching here means the tick was not consumed as pairing
            // signal: no native gesture (headless, synthetic input) or a
            // modified scroll (e.g. ctrl+wheel zoom), which always rides the
            // terminal events — the helper cannot report modifiers.
            MouseKind::ScrollUp | MouseKind::ScrollDown => {
                let view = self.comp.view_at(point.0);
                self.mark_scroll(view);
                let local = self.comp.to_local(view, point);
                let delta = if mouse.kind == MouseKind::ScrollUp {
                    -(self.cell.1 as f32)
                } else {
                    self.cell.1 as f32
                };
                if self.emit_wheel(view, local, 0.0, delta, false, mouse.mods, out) {
                    return Ok(());
                }
                if let Some(area) = self.comp.views[view].tree.scroll_area_at(local.0, local.1) {
                    let max = area.max_scroll();
                    let node = area.node;
                    let profile = self.profile;
                    if let Some(state) = self.comp.views[view].tree.scroll_state_mut(node) {
                        state.tick(profile, delta, max);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn update_hover_target(
        &mut self,
        view: usize,
        local: (f32, f32),
        out: &mut Vec<EngineEvent>,
    ) {
        let hover_target = self.comp.views[view]
            .tree
            .hit_hover(local.0, local.1)
            .map(|id| (view, id));
        if hover_target == self.hover_target {
            return;
        }
        if let Some((v, node)) = self.hover_target {
            out.push(EngineEvent::HoverLeave {
                view: v,
                node,
                key: self.comp.views[v].tree.key_of(node).map(str::to_string),
            });
        }
        if let Some((v, node)) = hover_target {
            out.push(EngineEvent::HoverEnter {
                view: v,
                node,
                key: self.comp.views[v].tree.key_of(node).map(str::to_string),
            });
        }
        self.hover_target = hover_target;
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn emit_wheel(
        &mut self,
        view: usize,
        local: (f32, f32),
        delta_x: f32,
        delta_y: f32,
        precise: bool,
        mods: Mods,
        out: &mut Vec<EngineEvent>,
    ) -> bool {
        let tree = &self.comp.views[view].tree;
        let Some(node) = tree.hit_wheel(local.0, local.1) else {
            return false;
        };
        let rect = tree.rect(node).unwrap_or(crate::tree::PxRect::ZERO);
        out.push(EngineEvent::Wheel {
            view,
            node,
            key: tree.key_of(node).map(str::to_string),
            x: local.0 - rect.x,
            y: local.1 - rect.y,
            delta_x,
            delta_y,
            precise,
            mods,
        });
        true
    }

    fn mark_pointer(&mut self, name: &'static str, point: (f32, f32)) {
        if !crate::profiler::is_recording() {
            return;
        }
        let view = self.comp.view_at(point.0);
        let local = self.comp.to_local(view, point);
        let target = self.comp.views[view]
            .tree
            .hit_click(local.0, local.1)
            .and_then(|id| self.comp.views[view].tree.key_of(id))
            .map(str::to_string);
        let label = match target {
            Some(key) => format!("{name} #{key}"),
            None => format!("{name} {},{}", local.0 as i32, local.1 as i32),
        };
        crate::profiler::mark(name, view as u32, label);
    }

    pub(super) fn mark_scroll(&mut self, view: usize) {
        if !crate::profiler::is_recording() {
            return;
        }
        let now = Instant::now();
        let burst = self
            .last_scroll_mark
            .is_some_and(|at| now.duration_since(at).as_millis() < 350);
        self.scroll_burst = if burst { self.scroll_burst + 1 } else { 1 };
        self.last_scroll_mark = Some(now);
        crate::profiler::mark_or_extend(
            "scroll",
            view as u32,
            format!("scroll x{}", self.scroll_burst),
            350.0,
        );
    }

    fn open_menu(&mut self, view: usize, at: (f32, f32)) {
        let size = self.comp.views[view].size;
        let style = crate::menu::MenuStyle::from_terminal(&self.colors);
        let focus = self.menu.open(
            &mut self.comp.views[view].tree,
            view,
            at,
            (size.0 as f32, size.1 as f32),
            self.base_px,
            &self.fonts[0],
            view == self.inspect_view,
            &style,
        );
        if let Some(id) = focus {
            self.set_focus(view, Some(id));
        }
    }

    pub(super) fn close_menu(&mut self) {
        if let Some(view) = self.menu.view() {
            self.menu.close(&mut self.comp.views[view].tree);
        }
    }

    fn handle_menu_click(
        &mut self,
        point: (f32, f32),
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<bool> {
        let Some(view) = self.menu.view() else {
            return Ok(false);
        };
        if self.comp.view_at(point.0) != view {
            self.close_menu();
            return Ok(true);
        }
        let local = self.comp.to_local(view, point);
        match self.menu.click(&mut self.comp.views[view].tree, local) {
            MenuClick::KeepOpen | MenuClick::Dismissed => {}
            MenuClick::Action(action) => self.apply_input_action(action, out)?,
            MenuClick::Devtools { target, at } => {
                if let Some(node) = target {
                    out.push(EngineEvent::Inspect {
                        view,
                        node,
                        key: self.comp.views[view].tree.key_of(node).map(str::to_string),
                        x: at.0,
                        y: at.1,
                    });
                }
            }
        }
        Ok(true)
    }
}

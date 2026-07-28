use std::io;

use super::{Engine, EngineEvent};
use crate::surfaces::Rect;
use crate::terminal::{Mouse, MouseKind};
use crate::tree::PxRect;

fn offset(rect: Rect, abs: PxRect, visible: PxRect) -> Rect {
    let x1 = (abs.x.max(0.0) as u32 + rect.x).max(visible.x.max(0.0) as u32);
    let y1 = (abs.y.max(0.0) as u32 + rect.y).max(visible.y.max(0.0) as u32);
    let x2 = (abs.x.max(0.0) as u32 + rect.x + rect.w).min((visible.x + visible.w).max(0.0) as u32);
    let y2 = (abs.y.max(0.0) as u32 + rect.y + rect.h).min((visible.y + visible.h).max(0.0) as u32);
    if x2 <= x1 || y2 <= y1 {
        return Rect::default();
    }
    Rect {
        x: x1,
        y: y1,
        w: x2 - x1,
        h: y2 - y1,
    }
}

impl Engine {
    pub fn draw_surface(
        &mut self,
        surface: u32,
        width: u32,
        height: u32,
        bgra: &[u8],
        stride: usize,
        damage: Option<Rect>,
    ) -> io::Result<usize> {
        let row_bytes = width as usize * 4;
        if width == 0 || height == 0 || stride < row_bytes || bgra.len() < stride * height as usize
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "surface dimensions do not match its pixels",
            ));
        }
        let changed = crate::profiler::span("surface.convert", || {
            crate::surfaces::write(surface, width, height, damage, bgra, stride)
        });
        crate::profiler::count("surface.rows", u64::from(changed.h));
        self.damage_surface_views(surface, changed);
        Ok(row_bytes * height as usize)
    }

    pub fn delete_surface(&mut self, surface: u32) -> io::Result<()> {
        crate::surfaces::remove(surface);
        for view in self.comp.active_views() {
            let tree = &mut self.comp.views[view].tree;
            if tree.uses_surface(surface) {
                tree.mark_paint();
            }
        }
        Ok(())
    }

    fn damage_surface_views(&mut self, surface: u32, changed: Rect) {
        let size = crate::surfaces::with(surface, |s| (s.width, s.height));
        let Some((surface_w, surface_h)) = size else {
            return;
        };
        for view in self.comp.active_views() {
            let view_size = self.comp.views[view].size;
            let tree = &self.comp.views[view].tree;
            let mut damage = Rect::default();
            let mut scaled = false;
            for (abs, visible) in tree.surface_rects(surface) {
                if abs.w.round() as u32 != surface_w || abs.h.round() as u32 != surface_h {
                    scaled = true;
                    break;
                }
                damage = damage.union(offset(changed, abs, visible));
            }
            if scaled {
                self.comp.views[view].tree.mark_paint();
                continue;
            }
            let damage = damage.clamped(view_size.0, view_size.1);
            if !damage.is_empty() {
                self.comp.views[view].damage = self.comp.views[view].damage.union(damage);
            }
        }
    }

    pub(super) fn forward_pointer(
        &mut self,
        mouse: Mouse,
        point: (f32, f32),
        out: &mut Vec<EngineEvent>,
    ) -> bool {
        if self.drag.is_some() {
            return false;
        }
        let target = match mouse.kind {
            MouseKind::Down => {
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1) else {
                    return false;
                };
                self.active_view = view;
                self.set_focus(view, None);
                self.key_passthrough = true;
                self.pointer_capture = Some((view, node));
                (view, node)
            }
            MouseKind::Move => match self.pointer_capture {
                Some(target) => target,
                None => {
                    let view = self.comp.view_at(point.0);
                    let local = self.comp.to_local(view, point);
                    self.update_hover_target(view, local, out);
                    let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1)
                    else {
                        return false;
                    };
                    (view, node)
                }
            },
            MouseKind::Up => match self.pointer_capture.take() {
                Some(target) => target,
                None => {
                    let view = self.comp.view_at(point.0);
                    let local = self.comp.to_local(view, point);
                    let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1)
                    else {
                        return false;
                    };
                    (view, node)
                }
            },
            _ => return false,
        };
        let (view, node) = target;
        let local = self.comp.to_local(view, point);
        let rect = self.comp.views[view]
            .tree
            .rect(node)
            .unwrap_or(PxRect::ZERO);
        out.push(EngineEvent::Pointer {
            view,
            node,
            key: self.comp.views[view].tree.key_of(node).map(str::to_string),
            kind: mouse.kind,
            button: mouse.button,
            mods: mouse.mods,
            x: local.0 - rect.x,
            y: local.1 - rect.y,
        });
        true
    }
}

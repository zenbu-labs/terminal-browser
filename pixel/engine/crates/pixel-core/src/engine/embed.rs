use std::io;

use super::{Engine, EngineEvent};
use crate::surfaces::Rect;
use crate::terminal::{Mouse, MouseKind};
use crate::tree::PxRect;

pub(super) fn offset(rect: Rect, abs: PxRect, visible: PxRect) -> Rect {
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
    pub fn ingest_surface(
        &mut self,
        surface: u32,
        width: u32,
        height: u32,
        bgra: &[u8],
        stride: usize,
        damage: Option<&[Rect]>,
    ) -> io::Result<usize> {
        let row_bytes = width as usize * 4;
        if width == 0 || height == 0 || stride < row_bytes || bgra.len() < stride * height as usize {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "surface dimensions do not match its pixels",
            ));
        }
        let incoming: u64 = damage.map_or(u64::from(width) * u64::from(height), |rects| {
            rects.iter().map(|r| r.clamped(width, height).area()).sum()
        });
        crate::profiler::count("surface.damage_px", || incoming);
        let cpu = crate::profiler::cpu_us();
        let changed = crate::profiler::span("surface.convert", || {
            crate::surfaces::write(surface, width, height, damage, bgra, stride)
        });
        if let Some((thread_before, _)) = cpu
            && let Some((thread_after, _)) = crate::profiler::cpu_us()
        {
            crate::profiler::count("cpu.convert_thread_us", || thread_after - thread_before);
        }
        crate::profiler::count("surface.rows", || changed.iter().map(|r| u64::from(r.h)).sum());
        crate::profiler::count("surface.changed_px", || changed.iter().map(|r| r.area()).sum());
        self.damage_surface_views(surface, &changed);
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

    fn damage_surface_views(&mut self, surface: u32, parts: &[Rect]) {
        let size = crate::surfaces::with(surface, |s| (s.width, s.height));
        let Some((surface_w, surface_h)) = size else {
            return;
        };
        for view in self.comp.active_views() {
            let view_size = self.comp.views[view].size;
            let tree = &self.comp.views[view].tree;
            let mut mapped: Vec<Rect> = Vec::new();
            let mut whole_node = false;
            for (abs, visible) in tree.surface_rects(surface) {
                if abs.w.round() as u32 != surface_w || abs.h.round() as u32 != surface_h {
                    whole_node = true;
                    continue;
                }
                for &part in parts {
                    let rect = offset(part, abs, visible).clamped(view_size.0, view_size.1);
                    if !rect.is_empty() {
                        mapped.push(rect);
                    }
                }
            }
            let view = &mut self.comp.views[view];
            if whole_node {
                view.tree.mark_surface_changed(surface);
                view.tree.mark_paint();
            }
            for rect in mapped {
                view.add_damage(rect);
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
                    self.track_hover(view, local);
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

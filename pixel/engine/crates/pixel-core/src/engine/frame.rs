use std::io;
use std::time::{Duration, Instant};

use super::compositor::Painted;
use super::{Engine, HighlightArea};
use crate::canvas::Canvas;
use crate::logging;
use crate::paint::paint;
use crate::surfaces::Rect;

const INLINE_FRAME_BUDGET_MB_PER_SEC: f32 = 3.0;
pub(super) const DEFAULT_MAX_FPS: f32 = 0.0;

impl Engine {
    pub fn set_max_fps(&mut self, fps: f32) {
        self.max_fps = fps.max(0.0);
        logging::info("engine", format!("max fps {}", if self.max_fps > 0.0 { self.max_fps.to_string() } else { "uncapped".to_string() }));
    }

    pub fn set_frame_events(&mut self, on: bool) {
        if on {
            self.io.set_overlay_font(self.fonts[0].clone());
        } else if let Err(error) = self.io.overlay_off() {
            logging::warn("engine", format!("could not clear the presenter overlay: {error}"));
        }
        logging::info("engine", if on { "showing presenter events on screen" } else { "presenter events hidden" });
    }

    pub fn note(&mut self, text: String) {
        self.io.note(text);
    }

    pub(super) fn frame_debt(&self) -> Duration {
        let interval = if self.max_fps > 0.0 {
            Duration::from_secs_f32(1.0 / self.max_fps)
        } else {
            Duration::ZERO
        };
        if !self.io.frames_are_inline() {
            return interval;
        }
        let budget = INLINE_FRAME_BUDGET_MB_PER_SEC * 1_000_000.0;
        interval.max(Duration::from_secs_f32((self.last_frame_bytes as f32 / budget).min(0.2)))
    }

    pub(super) fn draws_something(&self) -> bool {
        self.comp.dirty
            || self.comp.active_views().iter().any(|&i| {
                let view = &self.comp.views[i];
                view.tree.dirty()
                    || !view.damage_parts.is_empty()
                    || (view.canvas.width, view.canvas.height) != view.size
            })
    }

    pub(super) fn frame(&mut self) -> io::Result<()> {
        let debt = self.frame_debt();
        let now = Instant::now();
        if !debt.is_zero() && now.duration_since(self.last_frame) < debt {
            self.frame_deferred = self.draws_something();
            if self.frame_deferred {
                self.frame_due = Some(self.last_frame + debt);
                return Ok(());
            }
        } else {
            self.frame_deferred = false;
        }
        self.frame_due = None;
        self.io.tick_highlights()?;
        self.io.draw_overlay()?;
        if !self.draws_something() {
            self.io.flatten_if_idle(self.comp.frame())?;
        }
        let active = self.comp.active_views();
        let work: Vec<(usize, bool)> = active
            .iter()
            .filter_map(|&i| {
                let view = &self.comp.views[i];
                if view.tree.dirty() || (view.canvas.width, view.canvas.height) != view.size {
                    Some((i, true))
                } else if view.damage_parts.is_empty() {
                    None
                } else {
                    Some((i, false))
                }
            })
            .collect();
        if work.is_empty() && !self.comp.dirty {
            return Ok(());
        }
        let cpu = crate::profiler::cpu_us();
        crate::profiler::span("frame", || -> io::Result<()> {
            let start = Instant::now();
            let mut painted: Vec<Painted> = Vec::new();
            let mut frame_kind = FrameKind::Damaged;
            for (i, whole) in work {
                let size = self.comp.views[i].size;
                if size.0 == 0 || size.1 == 0 {
                    continue;
                }
                crate::profiler::set_view(i as u32);
                let cursor = self
                    .cursor
                    .filter(|&(x, _)| self.comp.view_at(x) == i)
                    .map(|c| self.comp.to_local(i, c));
                let fonts = &mut self.fonts;
                let base_px = self.base_px;
                let incremental = self.incremental;
                let view = &mut self.comp.views[i];
                if (view.canvas.width, view.canvas.height) != size {
                    view.canvas = Canvas::new(size.0, size.1);
                    view.painted = false;
                }
                let painted_before = view.painted;
                let patchable = incremental && whole && painted_before && view.tree.only_nodes_changed();
                let scrolled_only = patchable && view.tree.only_scrolled();
                view.tree.set_whole_pixel_scroll(incremental);
                view.tree.flush_layout(fonts, base_px);
                let built = if !whole {
                    Err(FrameKind::Damaged)
                } else if !painted_before {
                    Err(FrameKind::First)
                } else if !patchable {
                    Err(FrameKind::Everything)
                } else {
                    patch_frame(view, size, scrolled_only)
                };
                frame_kind = frame_kind.max(match &built {
                    Ok(_) => FrameKind::Patched,
                    Err(kind) => *kind,
                });
                let blit = built.ok();
                let whole = whole && blit.is_none();
                let mut moves = Vec::new();
                let mut parts = std::mem::take(&mut view.damage_parts);
                let mut surface_parts = Vec::new();
                if whole {
                    surface_parts = std::mem::take(&mut parts);
                    surface_parts.retain(|r| !r.is_empty());
                    parts.push(Rect::sized(size.0, size.1));
                } else if let Some((moved, damage)) = blit {
                    moves.extend(moved);
                    parts.extend(damage);
                }
                for surface in view.tree.take_changed_surfaces() {
                    for (abs, visible) in view.tree.surface_rects(surface) {
                        let whole_node = Rect::sized(abs.w.max(0.0) as u32, abs.h.max(0.0) as u32);
                        let rect = super::embed::offset(whole_node, abs, visible).clamped(size.0, size.1);
                        if !rect.is_empty() {
                            if whole { surface_parts.push(rect) } else { parts.push(rect) }
                        }
                    }
                }
                let parts = if whole || !incremental {
                    parts
                } else {
                    merge_damage(enclose_paths(parts, &view.tree.path_painted_extents(), size), size)
                };
                crate::profiler::count("paint.px", || parts.iter().map(|p| p.area()).sum());
                for part in &parts {
                    view.canvas.set_region(Some(*part));
                    paint(
                        &view.tree,
                        &mut view.canvas,
                        fonts,
                        cursor,
                        Some((*part, view.clear_color)),
                    );
                }
                view.canvas.set_region(None);
                view.tree.clear_paint_flag();
                view.tree.mark_scrolls_painted();
                view.tree.mark_nodes_painted();
                view.painted = true;
                let opaque = crate::paint::opaque_areas(&view.tree);
                view.opaque = opaque.areas;
                view.ui_over_surfaces = opaque.ui_over_surfaces;
                painted.push(Painted {
                    view: i,
                    parts,
                    whole,
                    surface_parts,
                    moves,
                });
                self.comp.dirty = true;
            }
            crate::profiler::set_view(0);
            if !self.comp.dirty {
                return Ok(());
            }
            let direct = self.io.draws_locally();
            self.comp.keeps_frames = self.io.keeps_frames();
            self.compose(&painted, direct);
            self.comp.work_ms = start.elapsed().as_secs_f32() * 1000.0;
            self.comp.kind = frame_kind as u8;
            let bytes = crate::profiler::span("draw", || self.io.draw(self.comp.frame()))?;
            crate::profiler::count("bytes", || bytes as u64);
            if let Some((thread_before, process_before)) = cpu
                && let Some((thread_after, process_after)) = crate::profiler::cpu_us()
            {
                crate::profiler::count("cpu.frame_thread_us", || thread_after - thread_before);
                crate::profiler::count("cpu.frame_process_us", || process_after - process_before);
            }
            self.last_frame_bytes = bytes;

            let gap = start.duration_since(self.last_frame).as_secs_f32();
            self.last_frame = start;
            let ema = |old: f32, new: f32| {
                if old == 0.0 {
                    new
                } else {
                    old * 0.9 + new * 0.1
                }
            };
            self.stats.frame_ms = ema(self.stats.frame_ms, start.elapsed().as_secs_f32() * 1000.0);
            if gap < 0.25 {
                self.stats.fps = ema(self.stats.fps, 1.0 / gap);
            }
            Ok(())
        })
    }

    pub(super) fn compose(&mut self, painted: &[Painted], direct: bool) {
        let overlays = self.highlight.is_some() || self.inspect_mode;
        crate::profiler::span("compose", || {
            self.comp.compose(painted, overlays, direct);
            if let Some((view, id, area)) = self.highlight {
                self.draw_node_overlay(view, id, area, false);
            }
            if self.inspect_mode
                && let Some(id) = self.inspect_hover
            {
                self.draw_node_overlay(self.inspect_view, id, HighlightArea::All, true);
            }
        });
        self.comp.dirty = false;
    }
}

const PATCH_LIMIT: f32 = 0.6;

fn patch_frame(view: &mut super::compositor::View, size: (u32, u32), scrolled_only: bool) -> Result<(Option<crate::canvas::Move>, Vec<Rect>), FrameKind> {
    let shifts = view.tree.scroll_shifts();
    let (moved, mut damage, shift) = match shifts.as_slice() {
        [] => (None, Vec::new(), None),
        [(id, area, dy)] => {
            let (moved, damage) = shift_scroll(view, size, *id, *area, *dy).ok_or(FrameKind::FarScroll)?;
            (Some(moved), damage, Some((*id, *dy)))
        }
        _ => return Err(FrameKind::ManyScrolls),
    };
    if !scrolled_only {
        for rect in view.tree.node_damage(shift) {
            damage.push(Rect::covering(rect.outset(DAMAGE_MARGIN)).clamped(size.0, size.1));
        }
    }
    let damage = merge_damage(enclose_paths(damage, &view.tree.path_painted_extents(), size), size);
    let area: u64 = damage.iter().map(|r| r.area()).sum();
    if area as f32 > PATCH_LIMIT * (size.0 * size.1) as f32 {
        return Err(FrameKind::TooMuchChanged);
    }
    Ok((moved, damage))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FrameKind {
    Damaged = 0,
    Patched = 1,
    TooMuchChanged = 2,
    ManyScrolls = 3,
    FarScroll = 4,
    Everything = 5,
    First = 6,
}

const DAMAGE_MARGIN: f32 = 4.0;
const PATH_PAD: f32 = 2.0;


fn shift_scroll(view: &mut super::compositor::View, size: (u32, u32), id: crate::tree::NodeId, area: crate::tree::PxRect, dy: i32) -> Option<(crate::canvas::Move, Vec<Rect>)> {
    let region = Rect {
        x: area.x.round().max(0.0) as u32,
        y: area.y.round().max(0.0) as u32,
        w: area.w.round().max(0.0) as u32,
        h: area.h.round().max(0.0) as u32,
    }
    .clamped(size.0, size.1);
    let distance = dy.unsigned_abs();
    if region.is_empty() || distance == 0 || distance >= region.h {
        return None;
    }
    view.canvas.shift_rows(region, dy);
    let exposed = if dy < 0 {
        Rect { y: region.y + region.h - distance, h: distance, ..region }
    } else {
        Rect { h: distance, ..region }
    };
    let mut damage = vec![exposed];
    for fixed in view.tree.fixed_paint_over(id, area) {
        damage.push(Rect::covering(fixed).clamped(size.0, size.1));
        let ghost = crate::tree::PxRect { y: fixed.y + dy as f32, ..fixed }.intersect(area);
        if ghost.w > 0.0 && ghost.h > 0.0 {
            damage.push(Rect::covering(ghost).clamped(size.0, size.1));
        }
    }
    Some((crate::canvas::Move { rect: region, dy }, damage))
}

fn enclose_paths(mut damage: Vec<Rect>, paths: &[crate::tree::PxRect], size: (u32, u32)) -> Vec<Rect> {
    let extents: Vec<Rect> = paths.iter().map(|p| Rect::covering(p.outset(PATH_PAD)).clamped(size.0, size.1)).filter(|r| !r.is_empty()).collect();
    for part in &mut damage {
        loop {
            let grown = extents.iter().filter(|e| e.intersects(*part)).fold(*part, |acc, e| acc.union(*e));
            if grown == *part {
                break;
            }
            *part = grown;
        }
    }
    damage
}

fn merge_damage(mut parts: Vec<Rect>, size: (u32, u32)) -> Vec<Rect> {
    parts.retain(|r| !r.is_empty());
    let mut merged: Vec<Rect> = Vec::new();
    for part in parts {
        merged.push(part);
        while let Some((i, j)) = (0..merged.len()).flat_map(|i| (i + 1..merged.len()).map(move |j| (i, j))).find(|&(i, j)| {
            let (a, b) = (merged[i], merged[j]);
            a.union(b).area() * 4 <= (a.area() + b.area()) * 5
        }) {
            let b = merged.swap_remove(j);
            merged[i] = merged[i].union(b);
        }
    }
    merged.into_iter().map(|r| r.clamped(size.0, size.1)).collect()
}

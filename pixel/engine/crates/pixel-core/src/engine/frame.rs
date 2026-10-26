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
            self.term.set_overlay_font(self.fonts[0].clone());
        } else if let Err(error) = self.term.overlay_off() {
            logging::warn("engine", format!("could not clear the presenter overlay: {error}"));
        }
        logging::info("engine", if on { "showing presenter events on screen" } else { "presenter events hidden" });
    }

    pub fn note(&mut self, text: String) {
        self.term.note(text);
    }

    pub(super) fn frame_debt(&self) -> Duration {
        let interval = if self.max_fps > 0.0 {
            Duration::from_secs_f32(1.0 / self.max_fps)
        } else {
            Duration::ZERO
        };
        if !self.term.frames_are_inline() {
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
        self.term.tick_highlights()?;
        self.term.draw_overlay()?;
        if !self.draws_something() {
            self.term.flatten_if_idle(self.comp.frame())?;
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
                let view = &mut self.comp.views[i];
                if (view.canvas.width, view.canvas.height) != size {
                    view.canvas = Canvas::new(size.0, size.1);
                } 
                let mut parts = std::mem::take(&mut view.damage_parts);
                let mut surface_parts = Vec::new();
                if whole {
                    surface_parts = std::mem::take(&mut parts);
                    surface_parts.retain(|r| !r.is_empty());
                    parts.push(Rect::sized(size.0, size.1));
                }
            
                view.tree.flush_layout(fonts, base_px);
                for surface in view.tree.take_changed_surfaces() {
                    for (abs, visible) in view.tree.surface_rects(surface) {
                        let whole_node = Rect::sized(abs.w.max(0.0) as u32, abs.h.max(0.0) as u32);
                        let rect = super::embed::offset(whole_node, abs, visible).clamped(size.0, size.1);
                        if !rect.is_empty() {
                            if whole { surface_parts.push(rect) } else { parts.push(rect) }
                        }
                    }
                }
                crate::profiler::count("paint.px", || parts.iter().map(|p| p.area()).sum());
                for part in &parts {
                    view.canvas.push_clip(part.x as f32, part.y as f32, part.w as f32, part.h as f32);
                    paint(
                        &view.tree,
                        &mut view.canvas,
                        fonts,
                        cursor,
                        Some((*part, view.clear_color)),
                    );
                    view.canvas.pop_clip();
                }
                view.tree.clear_paint_flag();
                let opaque = crate::paint::opaque_areas(&view.tree);
                view.opaque = opaque.areas;
                view.ui_over_surfaces = opaque.ui_over_surfaces;
                painted.push(Painted {
                    view: i,
                    parts,
                    whole,
                    surface_parts,
                });
                self.comp.dirty = true;
            }
            crate::profiler::set_view(0);
            if !self.comp.dirty {
                return Ok(());
            }
            let direct = self.term.draws_locally();
            self.compose(&painted, direct);
            let bytes = crate::profiler::span("draw", || self.term.draw(self.comp.frame()))?;
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

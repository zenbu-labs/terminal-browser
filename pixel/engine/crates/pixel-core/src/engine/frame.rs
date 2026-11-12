use std::io;
use std::time::{Duration, Instant};

use super::{Engine, HighlightArea};
use crate::logging;
use crate::scene::{Damage, Frame, Op, ViewFrame};
use crate::surfaces::Rect;

const PAINT_INTERVAL_WITH_INPUT_PENDING: Duration = Duration::from_millis(16);
const UNCAPPED_ANIMATION_STEP: Duration = Duration::from_millis(6);
pub(super) const PRESENT_AFTER_MAX: Duration = Duration::from_micros(7300);
const PRESENT_AFTER_MIN: Duration = Duration::from_micros(2500);
const PRESENT_MARGIN: Duration = Duration::from_millis(1);
const PRESENT_RELAX_PER_FRAME: Duration = Duration::from_micros(50);
const RECENT_FRAMES: usize = 120;
pub(super) const DEFAULT_MAX_FPS: f32 = 0.0;

impl Engine {
    pub fn set_max_fps(&mut self, fps: f32) {
        self.max_fps = fps.max(0.0);
        logging::info("engine", format!("max fps {}", if self.max_fps > 0.0 { self.max_fps.to_string() } else { "uncapped".to_string() }));
    }

    pub(super) fn frame_interval(&self) -> Duration {
        if self.max_fps > 0.0 {
            Duration::from_secs_f32(1.0 / self.max_fps)
        } else {
            Duration::ZERO
        }
    }

    pub(super) fn paint_interval_with_input_pending(&self) -> Duration {
        let interval = self.frame_interval();
        if interval.is_zero() {
            PAINT_INTERVAL_WITH_INPUT_PENDING
        } else {
            interval.min(PAINT_INTERVAL_WITH_INPUT_PENDING)
        }
    }

    pub(super) fn until_next_animation_frame(&self) -> Duration {
        let interval = self.frame_interval();
        if interval.is_zero() {
            return UNCAPPED_ANIMATION_STEP;
        }
        (self.frame_slot + interval)
            .checked_duration_since(Instant::now())
            .filter(|wait| !wait.is_zero())
            .unwrap_or(interval)
    }

    pub(super) fn frame_debt(&self) -> Duration {
        let interval = self.frame_interval();
        let Some(budget) = self.backend.byte_rate_limit() else {
            return interval;
        };
        interval.max(Duration::from_secs_f32((self.last_frame_bytes as f32 / budget).min(0.2)))
    }

    pub fn since_input(&self) -> Duration {
        self.last_input.elapsed()
    }

    pub fn idle(&self) -> bool {
        !self.frame_deferred && !self.draws_something()
    }

    pub(super) fn draws_something(&self) -> bool {
        self.comp.dirty
            || self.backend.pending_present()
            || self.comp.active_views().iter().any(|&i| {
                let view = &self.comp.views[i];
                view.tree.dirty() || !view.damage_parts.is_empty() || view.scene_size != view.size
            })
    }

    pub(super) fn frame(&mut self) -> io::Result<()> {
        self.apply_scroll_requests();
        let debt = self.frame_debt();
        let now = Instant::now();
        if !debt.is_zero() && now.duration_since(self.frame_slot) < debt {
            self.frame_deferred = self.draws_something();
            if self.frame_deferred {
                self.frame_due = Some(self.frame_slot + debt);
                self.note_frame_wanted();
                return Ok(());
            }
        } else {
            self.frame_deferred = false;
        }
        self.frame_due = None;
        self.backend.before_frame()?;
        if !self.draws_something() {
            self.backend.idle()?;
        }
        let active = self.comp.active_views();
        let work: Vec<(usize, bool)> = active
            .iter()
            .filter_map(|&i| {
                let view = &self.comp.views[i];
                if view.tree.dirty() || view.scene_size != view.size {
                    Some((i, true))
                } else if view.damage_parts.is_empty() {
                    None
                } else {
                    Some((i, false))
                }
            })
            .collect();
        if self.backend.pending_present() {
            self.comp.dirty = true;
        }
        if work.is_empty() && !self.comp.dirty {
            return Ok(());
        }
        let cpu = crate::profiler::cpu_us();
        crate::image_cache::begin_frame();
        crate::profiler::span("frame", || -> io::Result<()> {
            let start = Instant::now();
            let interval = self.frame_interval();
            let next_slot = self.frame_slot + interval;
            let slot = if !interval.is_zero() && start >= next_slot && start < next_slot + interval { next_slot } else { start };
            self.backend.schedule_present((!interval.is_zero()).then(|| slot + self.present_after));
            let mut damage: Vec<(usize, bool, Vec<Rect>)> = Vec::new();
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
                let mut parts = std::mem::take(&mut view.damage_parts);
                let mut surface_parts = Vec::new();
                if whole {
                    surface_parts = std::mem::take(&mut parts);
                    surface_parts.retain(|r| !r.is_empty());
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
                if whole {
                    let mut scene = crate::record::record_scene(&view.tree, fonts, cursor);
                    crate::profiler::span("scene.changes", || crate::record::mark_changes(&view.scene, &mut scene));
                    view.scene = scene;
                    view.scene_size = size;
                    view.tree.clear_paint_flag();
                    damage.push((i, true, surface_parts));
                } else {
                    view.tree.clear_paint_flag();
                    damage.push((i, false, parts));
                }
                self.comp.dirty = true;
            }
            crate::profiler::set_view(0);
            if !self.comp.dirty {
                return Ok(());
            }
            let overlay = self.overlay_ops();
            let relayout = std::mem::take(&mut self.comp.relayout);
            let views: Vec<ViewFrame<'_>> = active
                .iter()
                .map(|&i| {
                    let view = &self.comp.views[i];
                    let damage = match damage.iter().find(|(v, _, _)| *v == i) {
                        Some((_, true, surfaces)) => Damage::Whole { surfaces },
                        Some((_, false, parts)) => Damage::Parts(parts),
                        None => Damage::None,
                    };
                    ViewFrame { view: i, origin_x: view.origin_x, size: view.size, clear: view.clear_color, scene: &view.scene, damage }
                })
                .collect();
            let frame = Frame {
                window: self.comp.window,
                fonts: &self.fonts,
                views: &views,
                divider: self.comp.divider(),
                overlay: &overlay,
                relayout,
            };
            let bytes = crate::profiler::span("draw", || self.backend.present(frame))?;
            self.comp.dirty = false;
            self.finish_frame(start, slot, bytes, cpu)
        })
    }

    fn finish_frame(&mut self, start: Instant, slot: Instant, bytes: usize, cpu: Option<(u64, u64)>) -> io::Result<()> {
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
        self.frame_slot = slot;
        if let Some(ready) = self.backend.take_presented_at() {
            self.note_ready(ready.saturating_duration_since(slot));
        }
        let ema = |old: f32, new: f32| if old == 0.0 { new } else { old * 0.9 + new * 0.1 };
        self.stats.frame_ms = ema(self.stats.frame_ms, start.elapsed().as_secs_f32() * 1000.0);
        if gap < 0.25 {
            self.stats.fps = ema(self.stats.fps, 1.0 / gap);
        }
        if self.moving() {
            self.note_frame_wanted();
        }
        Ok(())
    }

    fn note_ready(&mut self, took: Duration) {
        if self.ready_times.len() == RECENT_FRAMES {
            self.ready_times.pop_front();
        }
        self.ready_times.push_back(took);
        let slowest = self.ready_times.iter().max().copied().unwrap_or_default();
        let target = (slowest + PRESENT_MARGIN).clamp(PRESENT_AFTER_MIN, PRESENT_AFTER_MAX);
        self.present_after = target.max(self.present_after.saturating_sub(PRESENT_RELAX_PER_FRAME));
    }

    fn note_frame_wanted(&self) {
        if let Some(now) = crate::profiler::now_ms() {
            crate::profiler::emit("frame.wanted", now, 0.0, None);
        }
    }

    fn overlay_ops(&self) -> Vec<Op> {
        let mut ops = Vec::new();
        if let Some((view, id, area)) = self.highlight {
            self.node_overlay(view, id, area, false, &mut ops);
        }
        if self.inspect_mode
            && let Some(id) = self.inspect_hover
        {
            self.node_overlay(self.inspect_view, id, HighlightArea::All, true, &mut ops);
        }
        ops
    }
}

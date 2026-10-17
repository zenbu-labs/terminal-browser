use std::io;

use super::Terminal;
use super::merge;
use super::transmit_strategy::{FIRST_PATCH_Z, Flatten, POOL, Patch, Stats, TERMINAL_IMAGE_BUDGET_BYTES, TransmitStrategy, choose_transmit_strategy};
use super::tiles::{TILE_Z, Tile, intersect, mark_dirty, mask_outside, tiles_for};
use crate::canvas::Frame;
use crate::surfaces::{OpaqueArea, Rect};

#[derive(Debug, Default)]
pub(crate) struct Patched {
    pub(super) live: Vec<Patch>,
    pub(super) next_z: i32,
    pub(super) base: Option<(u32, u32)>,
    pub(super) shown: Vec<u8>,
    pub(super) opaque: Vec<crate::surfaces::OpaqueArea>,
    pub(super) opaque_shape_changed: bool,
    pub(super) ui_over_surfaces: Vec<Rect>,
    pub(super) tiles: Vec<Tile>,
    pub(super) last_draw: Option<std::time::Instant>,
    pub(super) last_flatten: Option<std::time::Instant>,
    pub(super) stats: Stats,
}

const IDLE_FLATTEN_AFTER: std::time::Duration = std::time::Duration::from_millis(400);
const IDLE_FLATTEN_MIN_PATCHES: usize = 64;
const IDLE_COMPACT_KEEP: usize = 12;
const IDLE_COMPACT_MAX_UNION_PX: u64 = 400 * 400;

impl Patched {
    pub(super) fn opaque_rects(&self) -> Vec<Rect> {
        self.opaque.iter().map(|area| area.rect).collect()
    }
}

#[derive(Default)]
struct TileReport {
    dirty: u64,
    unchanged: u64,
    cleared: u64,
    sent: Vec<Rect>,
}

fn rects(rs: impl Iterator<Item = Rect>) -> String {
    rs.map(|r| format!("{},{} {}x{}", r.x, r.y, r.w, r.h)).collect::<Vec<_>>().join(" ")
}

impl Terminal {
    pub(in crate::terminal) fn draw_patched(&mut self, frame: Frame<'_>, out: &mut Vec<u8>) -> io::Result<usize> {
        self.cell_size()?;

        let canvas = frame.canvas;
        let size = (canvas.width, canvas.height);
        let on_screen = std::mem::take(&mut self.patches.opaque);
        self.patches.opaque.extend(frame.opaque.iter().filter_map(|area| {
            let rect = area.rect.clamped(size.0, size.1);
            (!rect.is_empty()).then_some(OpaqueArea { surface: area.surface, rect }) // im not entirely sure why we are passing area.surface here? hm
        }));
        if on_screen.iter().map(|a| a.rect).ne(self.patches.opaque.iter().map(|a| a.rect)) {
            self.patches.opaque_shape_changed = true;
            let rects = self.patches.opaque_rects();
            crate::logging::info(
                "present",
                format!("opaque areas now {:?}, {} tiles cover the rest", rects, tiles_for(size, &rects).len()),
            );
        }
        let previous_ui = std::mem::replace(
            &mut self.patches.ui_over_surfaces,
            frame.ui_over_surfaces.iter().map(|r| r.clamped(size.0, size.1)).filter(|r| !r.is_empty()).collect(),
        );
        let damage = self.patches.refine_damage(frame, &previous_ui);
        let opaque_rects = self.patches.opaque_rects();
        let mut opaque_damage = Vec::new();
        for rect in &damage {
            for opaque in &opaque_rects {
                let part = intersect(*rect, *opaque);
                if !part.is_empty() {
                    opaque_damage.push(part);
                }
            }
        }
        let shape_changed = self.patches.opaque_shape_changed;
        let strategy = if self.patches.opaque_shape_changed && self.patches.base.is_some() {
            TransmitStrategy::Flatten(Flatten::OpaqueShapeChanged)
        } else {
            choose_transmit_strategy(&self.patches, size, &opaque_damage)
        };
        self.overlay_frame(size);
        self.patches.stats.record(&strategy, size, !frame.repainted.is_empty(), !frame.changed.is_empty());
        self.patches.last_draw = Some(std::time::Instant::now());
        let recording = crate::profiler::is_recording();
        let strategy_line = recording.then(|| match &strategy {
            TransmitStrategy::Skip => "skip".to_string(),
            TransmitStrategy::Flatten(reason) => format!("flatten {reason:?}"),
            TransmitStrategy::Patches { send, retire, folded } => format!(
                "{} patches {} px, retire {}, folded {folded}: {}",
                send.len(),
                send.iter().map(|p| p.rect.area()).sum::<u64>(),
                retire.len(),
                rects(send.iter().map(|p| p.rect))
            ),
        });
        let mut written = match strategy {
            TransmitStrategy::Skip => 0,
            TransmitStrategy::Flatten(reason) => self.flatten(frame, reason, out)?,
            TransmitStrategy::Patches { send, retire, folded } => {
                if folded > 0 {
                    self.note(format!("folded {folded} patches to free an id"));
                }
                self.send_patches(frame, send, retire, out)?
            }
        };
        let (tile_bytes, tiles) = self.send_dirty_tiles(frame, &damage, out)?;
        written += tile_bytes;
        if let Some(strategy_line) = strategy_line {
            let area = |rs: &[Rect]| rs.iter().map(|r| r.area()).sum::<u64>();
            crate::logging::debug(
                "present",
                format!(
                    "draw: in changed {} ({} px) repainted {} ({} px); refined {} ({} px): {}; opaque {} ({} px); shape changed {}; {}; tiles dirty {} unchanged {} cleared {} sent {} ({} px): {}",
                    frame.changed.len(),
                    area(frame.changed),
                    frame.repainted.len(),
                    area(frame.repainted),
                    damage.len(),
                    area(&damage),
                    rects(damage.iter().copied()),
                    opaque_damage.len(),
                    area(&opaque_damage),
                    shape_changed,
                    strategy_line,
                    tiles.dirty,
                    tiles.unchanged,
                    tiles.cleared,
                    tiles.sent.len(),
                    area(&tiles.sent),
                    rects(tiles.sent.iter().copied()),
                ),
            );
        }
        let status = self.patches.stats.line(self.patches.live.len(), self.patches.tiles.len());
        self.set_status(status);
        self.append_overlay(out)?;
        Ok(written)
    }

    fn send_dirty_tiles(&mut self, frame: Frame<'_>, damage: &[Rect], out: &mut Vec<u8>) -> io::Result<(usize, TileReport)> {
        let canvas = frame.canvas;
        let size = (canvas.width, canvas.height);
        let start = out.len();
        mark_dirty(&mut self.patches.tiles, damage);
        let mut report = TileReport::default();
        for index in 0..self.patches.tiles.len() {
            let tile = self.patches.tiles[index].clone();
            if !tile.dirty {
                continue;
            }
            report.dirty += 1;
            let rect = tile.rect.clamped(size.0, size.1);
            let mut now_sent = tile.sent;
            let unchanged = tile.sent && self.patches.changed_within(canvas, rect).is_none();
            if unchanged {
                report.unchanged += 1;
            }
            if !rect.is_empty() && !unchanged {
                let data = super::copy_rect(canvas, rect, frame.premultiplied);
                if data.chunks_exact(4).all(|px| px[3] == 0) {
                    if tile.sent {
                        out.extend_from_slice(&crate::kitty::kitty_delete_one(tile.id));
                        now_sent = false;
                        report.cleared += 1;
                    }
                } else {
                    self.place_image(out, tile.id, rect, TILE_Z, tile.sent, |buf| buf.copy_from_slice(&data))?;
                    now_sent = true;
                    report.sent.push(rect);
                }
                self.patches.remember_exact(canvas, rect);
            }
            let tile = &mut self.patches.tiles[index];
            tile.dirty = false;
            tile.sent = now_sent;
        }
        let pixels = || report.sent.iter().map(|r| r.area()).sum();
        crate::profiler::count("present.tiles", || report.sent.len() as u64);
        crate::profiler::count("present.tiles_dirty", || report.dirty);
        crate::profiler::count("present.tile_pixels", pixels);
        crate::profiler::count("present.pixels", pixels);
        Ok((out.len() - start, report))
    }

    fn send_patches(&mut self, frame: Frame<'_>, send: Vec<Patch>, retire: Vec<u32>, out: &mut Vec<u8>) -> io::Result<usize> {
        if send.is_empty() && retire.is_empty() {
            return Ok(0);
        }
        let canvas = frame.canvas;
        let start = out.len();
        for id in &retire {
            out.extend_from_slice(&crate::kitty::kitty_delete_one(*id));
        }
        let mut pixels = 0u64;
        for patch in &send {
            let replacing = self.patches.live.iter().any(|p| p.id == patch.id);
            let rect = patch.rect;
            self.place_image(out, patch.id, rect, patch.z, replacing, |buf| {
                let stride = canvas.width as usize * 4;
                let row_len = rect.w as usize * 4;
                for (i, row) in (rect.y..rect.y + rect.h).enumerate() {
                    let start = row as usize * stride + rect.x as usize * 4;
                    buf[i * row_len..(i + 1) * row_len].copy_from_slice(&canvas.pixels[start..start + row_len]);
                }
            })?;
            pixels += patch.rect.area();
        }
        crate::profiler::count("present.patches", || send.len() as u64);
        crate::profiler::count("present.pixels", || pixels);
        let written = out.len() - start;
        for patch in &send {
            for piece in self.patches.compared_pieces(patch.rect) {
                self.patches.remember_exact(canvas, piece);
            }
        }
        let reused: Vec<u32> = send.iter().map(|p| p.id).collect();
        self.patches
            .live
            .retain(|p| !retire.contains(&p.id) && !reused.contains(&p.id));
        self.patches.next_z = send.iter().map(|p| p.z + 1).max().unwrap_or(self.patches.next_z);
        self.patches.live.extend(send);
        Ok(written)
    }

    fn flatten(&mut self, frame: Frame<'_>, reason: Flatten, out: &mut Vec<u8>) -> io::Result<usize> {
        let canvas = frame.canvas;
        crate::profiler::count("present.whole_frame", || 1);
        let ms_since = |at: Option<std::time::Instant>| {
            at.map_or("never".to_string(), |at| format!("{}ms ago", at.elapsed().as_millis()))
        };
        let live = self.patches.live.len();
        let detail = match reason {
            Flatten::OutOfPatchIds => format!("all {POOL} patch ids in use and no compaction cheap enough would free one"),
            Flatten::ImagesExceedTerminalBudget => format!(
                "base plus patches would exceed the {} MB the terminal is asked to hold",
                TERMINAL_IMAGE_BUDGET_BYTES / (1024 * 1024)
            ),
            Flatten::Idle => format!(
                "no draw for {}ms with {live} patches live (threshold {IDLE_FLATTEN_MIN_PATCHES})",
                IDLE_FLATTEN_AFTER.as_millis()
            ),
            Flatten::Resize => "the frame size changed".to_string(),
            Flatten::OpaqueShapeChanged => "the opaque areas changed shape, so base and tiles are laid out again".to_string(),
            Flatten::OutOfLayers => "ran out of stacking order numbers for patches".to_string(),
        };
        crate::logging::info(
            "present",
            format!(
                "full frame ({reason:?}): {detail}; {live} live patches, last full frame {}, last draw {}",
                ms_since(self.patches.last_flatten),
                ms_since(self.patches.last_draw)
            ),
        );
        self.note(format!("full frame — {}", reason.label()));
        let mut prelude = Vec::new();
        for patch in std::mem::take(&mut self.patches.live) {
            prelude.extend_from_slice(&crate::kitty::kitty_delete_one(patch.id));
        }
        let size = (canvas.width, canvas.height);
        if self.patches.opaque_shape_changed || self.patches.tiles.is_empty() || self.patches.base != Some(size) {
            for tile in self.patches.tiles.iter().filter(|t| t.sent) {
                prelude.extend_from_slice(&crate::kitty::kitty_delete_one(tile.id));
            }
            self.patches.tiles = tiles_for(size, &self.patches.opaque_rects());
            self.patches.opaque_shape_changed = false;
        } else {
            for tile in &mut self.patches.tiles {
                tile.dirty = true;
                tile.sent = false;
            }
        }
        self.patches.next_z = FIRST_PATCH_Z;
        self.patches.base = Some(size);
        self.patches.last_flatten = Some(std::time::Instant::now());
        self.patches.reset_screen(canvas);
        let mut pixels = super::straight_pixels(canvas, frame.premultiplied).into_owned();
        mask_outside(&mut pixels, canvas.width, canvas.height, &self.patches.opaque_rects());
        self.draw_full(canvas, &pixels, &prelude, out)
    }

    pub(crate) fn idle_flatten_at(&self) -> Option<std::time::Instant> {
        if let super::Presenter::Cells(_) = self.present {
            return self.cells_sharpen_at();
        }
        if self.present != super::Presenter::Patched
            || self.patch_medium().is_none()
            || self.patches.live.len() <= IDLE_COMPACT_KEEP
        {
            return None;
        }
        self.patches.last_draw.map(|at| at + IDLE_FLATTEN_AFTER)
    }

    fn compact_idle(&mut self, frame: Frame<'_>) -> io::Result<()> {
        let before = self.patches.live.len();
        let mut z = self.patches.next_z;
        let folded = merge::compact(&self.patches.live, IDLE_COMPACT_KEEP, IDLE_COMPACT_MAX_UNION_PX, u64::MAX, &self.patches.opaque_rects(), &mut z);
        if folded.send.is_empty() {
            return Ok(());
        }
        let mut out = Vec::new();
        self.send_patches(frame, folded.send, folded.retire, &mut out)?;
        self.write_synchronized(&out)?;
        self.note(format!("quiet: folded {before} patches down to {}", self.patches.live.len()));
        Ok(())
    }

    pub(crate) fn flatten_if_idle(&mut self, frame: Frame<'_>) -> io::Result<()> {
        if let super::Presenter::Cells(protocol) = self.present {
            return self.sharpen_still_cells(protocol);
        }
        if self.idle_flatten_at().is_some_and(|at| std::time::Instant::now() >= at) {
            if self.patches.live.len() >= IDLE_FLATTEN_MIN_PATCHES {
                let mut out = Vec::new();
                self.flatten(frame, Flatten::Idle, &mut out)?;
                self.write_synchronized(&out)?;
            } else {
                self.compact_idle(frame)?;
            }
            self.patches.last_draw = Some(std::time::Instant::now());
        }
        Ok(())
    }
}

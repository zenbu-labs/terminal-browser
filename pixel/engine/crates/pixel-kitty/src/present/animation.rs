use std::io;

use crate::Kitty;
use super::merge::{IMAGE_OVERHEAD_PX, merge_rects};
use super::transmit_strategy::{Flatten, MAX_PATCHES, Patch, Stats, TransmitStrategy};
use pixel_raster::PixelFrame as Frame;
use crate::kitty::FrameEdit;
use pixel_core::surfaces::Rect;

#[derive(Debug, Default)]
pub(crate) struct Animation {
    base: Option<(u32, u32)>,
    stats: Stats,
}

fn choose_transmit_strategy(state: &Animation, frame: (u32, u32), damage: &[Rect], single_edit: bool) -> TransmitStrategy {
    if state.base != Some(frame) {
        return TransmitStrategy::Flatten(Flatten::Resize);
    }
    let mut rects: Vec<Rect> = damage
        .iter()
        .map(|r| r.clamped(frame.0, frame.1))
        .filter(|r| !r.is_empty())
        .collect();
    if rects.is_empty() {
        return TransmitStrategy::Skip;
    }
    merge_rects(&mut rects, IMAGE_OVERHEAD_PX, if single_edit { 1 } else { MAX_PATCHES });
    TransmitStrategy::Patches {
        send: rects.into_iter().map(|rect| Patch { id: 0, rect, z: 0 }).collect(),
        retire: Vec::new(),
        folded: 0,
    }
}

impl Kitty {
    pub(crate) fn draw_animation(&mut self, frame: Frame<'_>, out: &mut Vec<u8>) -> io::Result<usize> {
        let canvas = frame.canvas;
        let size = (canvas.width, canvas.height);
        let single_edit = self.wrapper.relayed(); // tmux case 
        let damage: Vec<Rect> = frame.changed.iter().chain(frame.repainted).copied().collect();
        let strategy = choose_transmit_strategy(&self.animation, size, &damage, single_edit);
        self.animation.stats.record(&strategy, size, !frame.repainted.is_empty(), !frame.changed.is_empty());
        match strategy {
            TransmitStrategy::Skip => Ok(0),
            TransmitStrategy::Flatten(reason) => {
                pixel_core::profiler::count("present.whole_frame", || 1);
                pixel_core::logging::info("present", format!("full frame ({reason:?}) via frame edits"));
                self.animation.base = Some(size);
                let pixels = super::straight_pixels(canvas, frame.premultiplied);
                self.draw_full(canvas, &pixels, &[], out)
            }
            TransmitStrategy::Patches { send, .. } => {
                let start = out.len();
                let mut pixels = 0u64;
                for patch in &send {
                    let edit = FrameEdit {
                        image_id: self.image_id,
                        x: patch.rect.x,
                        y: patch.rect.y,
                        width: patch.rect.w,
                        height: patch.rect.h,
                        transient: self.identity.transient_images(),
                    };
                    let data = super::copy_rect(canvas, patch.rect, frame.premultiplied);
                    match self.patch_medium() {
                        Some(medium) => {
                            let name = pixel_core::profiler::span("kitty.handoff", || {
                                self.hand_off_payload(medium, data.len(), |out| out.copy_from_slice(&data))
                            })?;
                            out.extend_from_slice(&crate::kitty::kitty_frame_edit_named(edit, &name, medium, self.wrapper));
                        }
                        None => out.extend_from_slice(&crate::kitty::kitty_frame_edit_inline(edit, &data, self.wrapper)),
                    }
                    pixels += patch.rect.area();
                    if self.highlight_transmits {
                        self.flash(out, patch.rect, false);
                    }
                }
                pixel_core::profiler::count("present.patches", || send.len() as u64);
                pixel_core::profiler::count("present.pixels", || pixels);
                Ok(out.len() - start)
            }
        }
    }
}

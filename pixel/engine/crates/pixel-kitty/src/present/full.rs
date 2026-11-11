use std::io;

use crate::Kitty;
use pixel_raster::Canvas;
use crate::kitty::Placement;
use pixel_core::surfaces::Rect;

impl Kitty {
    pub(crate) fn draw_full(&mut self, canvas: &Canvas, pixels: &[u8], prelude: &[u8], out: &mut Vec<u8>) -> io::Result<usize> {
        let shrank = self
            .last_frame_size
            .is_some_and(|(w, h)| canvas.width < w || canvas.height < h);
        self.last_frame_size = Some((canvas.width, canvas.height));

        let start = out.len();
        out.extend_from_slice(prelude);
        if shrank {
            out.extend_from_slice(&crate::kitty::kitty_delete(self.image_id, self.wrapper));
            out.extend_from_slice(b"\x1b[2J");
            if let Some(screen) = self.screen {
                let blank_row = " ".repeat(screen.cols as usize);
                for row in 1..=screen.rows {
                    out.extend_from_slice(format!("\x1b[{row};1H{blank_row}").as_bytes());
                }
            }
            self.placeholders = None;
        }
        let placement = if self.wrapper.relayed() {
            let (cols, rows) = self.grid_for(canvas);
            Placement::Cells { cols, rows }
        } else {
            if self.identity.deletes_before_replace() {
                out.extend_from_slice(&crate::kitty::kitty_delete_placement(self.image_id));
            }
            out.extend_from_slice(b"\x1b[H");
            Placement::Cursor { z: 0, offset: (0, 0) }
        };
        let transmit = self.transmit(canvas, placement);
        match pixel_core::profiler::span("kitty.handoff", || self.hand_off_frame(pixels))? {
            Some((medium, name)) => {
                out.extend_from_slice(&crate::kitty::kitty_transmit_named(transmit, &name, medium, self.wrapper));
            }
            None => out.extend_from_slice(&crate::kitty::kitty_transmit_placed(transmit, pixels, self.wrapper)),
        }
        if let Placement::Cells { cols, rows } = placement
            && self.placeholders != Some((cols, rows))
        {
            out.extend_from_slice(&crate::kitty::placeholder_grid(self.image_id, cols, rows));
            self.placeholders = Some((cols, rows));
        }
        if self.highlight_transmits {
            self.flash(out, Rect::sized(canvas.width, canvas.height), true);
        }
        pixel_core::profiler::count("present.pixels", || canvas.width as u64 * canvas.height as u64);
        Ok(out.len() - start)
    }
}

use std::io;
use std::time::{Duration, Instant};

use super::super::{SessionEnv, Terminal};
use crate::canvas::{Canvas, Frame};
use crate::cell_graphics::{CellProtocol, over_black};
use crate::surfaces::{OpaqueArea, Rect};

const GRAPHICS_PROBE_ID: u32 = 297;
const GRAPHICS_PROBE_TIMEOUT_MS: u64 = 1000;

// Termux only frees replaced images every 30 seconds or when scrollback is cleared,
// so after this many pixels we clear it and send a whole frame.
// Clearing scrollback also drops the images still on screen, and Termux crashes drawing
// a cell whose image is gone, so the screen is erased first.
const CLEAR_AFTER_PIXELS: u64 = 24_000_000;
const MAX_RECTS: usize = 24;
const RUN_GAP_CELLS: usize = 4;
const TOP_ROWS_WITHOUT_REGION: u32 = 2;
const MIN_SHIFT_ROWS: u32 = 4;
const MIN_TELLING_PIXEL_ROWS: usize = 8;
const SHIFT_MATCH: f32 = 0.9;
// A cell sent again within MOVING_GAP of the last time, MOVING_STREAK times running, is playing
// something like a video, and goes out blurry until it has been still for SHARPEN_AFTER.
const MOVING_GAP: Duration = Duration::from_millis(250);
const MOVING_STREAK: u8 = 4;
const MIN_SOFT_PIXELS: u64 = 160 * 160;
const SHARPEN_AFTER: Duration = Duration::from_millis(300);

#[derive(Debug, Default)]
pub(crate) struct Cells {
    shown: Vec<u8>,
    size: Option<(u32, u32)>,
    pixels_since_clear: u64,
    // Termux keeps images in the cells they cover, so scrolling lines moves them too.
    moves_images: bool,
    activity: Vec<CellActivity>,
    grid: (u32, u32),
}

#[derive(Debug, Clone, Copy, Default)]
struct CellActivity {
    sent_at: Option<Instant>,
    streak: u8,
    soft: bool,
}

impl CellActivity {
    fn streak_at(&self, now: Instant) -> u8 {
        let again = self.sent_at.is_some_and(|at| now.duration_since(at) <= MOVING_GAP);
        if again { self.streak.saturating_add(1) } else { 1 }
    }
}

/// Content below `top_row` moved up by `rows` lines, or down when negative.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Shift {
    top_row: u32,
    rows: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::terminal) struct GraphicsReply {
    kitty: bool,
    sixel: bool,
}

pub(in crate::terminal) fn parse_graphics_reply(buf: &[u8]) -> Option<GraphicsReply> {
    let needle = format!("Gi={GRAPHICS_PROBE_ID};OK");
    let kitty = buf.windows(needle.len()).any(|w| w == needle.as_bytes());
    let mut at = 0;
    while let Some(found) = buf[at..].windows(3).position(|w| w == b"\x1b[?") {
        let params = at + found + 3;
        let end = params + buf[params..].iter().take_while(|b| b.is_ascii_digit() || **b == b';').count();
        if buf.get(end) == Some(&b'c') {
            let sixel = buf[params..end].split(|&b| b == b';').any(|p| p == b"4");
            return Some(GraphicsReply { kitty, sixel });
        }
        at = params;
    }
    None
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(in crate::terminal) struct Hints {
    termux: bool,
    iterm2: bool,
}

impl Hints {
    fn of(env: &SessionEnv) -> Self {
        Hints {
            termux: env.var("TERMUX_VERSION").is_some_and(|v| !v.is_empty()),
            iterm2: env.var("LC_TERMINAL").as_deref() == Some("iTerm2")
                || env.var("TERM_PROGRAM").as_deref() == Some("iTerm.app"),
        }
    }
}

/// None keeps the kitty graphics protocol.
pub(in crate::terminal) fn choose_cell_protocol(reply: Option<GraphicsReply>, hints: Hints) -> Option<CellProtocol> {
    match reply {
        Some(GraphicsReply { kitty: true, .. }) => None,
        _ if hints.iterm2 => Some(CellProtocol::Iterm2),
        // Termux draws sixel and iTerm2 images alike, and decodes the PNGs of iTerm2 far faster.
        Some(GraphicsReply { sixel: true, .. }) if hints.termux => Some(CellProtocol::Iterm2),
        Some(GraphicsReply { sixel: true, .. }) => Some(CellProtocol::Sixel),
        _ => None,
    }
}

fn forced_protocol(value: &str) -> Option<Option<CellProtocol>> {
    match value.trim() {
        "kitty" => Some(None),
        "sixel" => Some(Some(CellProtocol::Sixel)),
        "iterm2" | "iterm" => Some(Some(CellProtocol::Iterm2)),
        _ => None,
    }
}

fn snap(rect: Rect, cell: (u32, u32), size: (u32, u32)) -> Rect {
    let x = rect.x / cell.0 * cell.0;
    let y = rect.y / cell.1 * cell.1;
    let right = (rect.x + rect.w).div_ceil(cell.0) * cell.0;
    let bottom = (rect.y + rect.h).div_ceil(cell.1) * cell.1;
    Rect { x, y, w: right - x, h: bottom - y }.clamped(size.0, size.1)
}

fn touch(a: Rect, b: Rect) -> bool {
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

fn waste(a: Rect, b: Rect) -> u64 {
    a.union(b).area().saturating_sub(a.area() + b.area())
}

/// Joins rects that touch when their bounding box costs little more than sending both,
/// so a full-width strip and a tall thin scrollbar do not turn into the whole page.
fn merge(mut rects: Vec<Rect>) -> Vec<Rect> {
    'again: loop {
        for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                if touch(rects[i], rects[j]) && waste(rects[i], rects[j]) * 4 <= rects[i].area() + rects[j].area() {
                    let other = rects.swap_remove(j);
                    rects[i] = rects[i].union(other);
                    continue 'again;
                }
            }
        }
        break;
    }
    while rects.len() > MAX_RECTS {
        let mut cheapest = (0, 1, u64::MAX);
        for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                let cost = waste(rects[i], rects[j]);
                if cost < cheapest.2 {
                    cheapest = (i, j, cost);
                }
            }
        }
        let other = rects.swap_remove(cheapest.1);
        rects[cheapest.0] = rects[cheapest.0].union(other);
    }
    rects
}

/// Terminals move the cursor below an image once it is drawn, which scrolls the screen when the image
/// reaches the last row, unless the cursor sits below the scrolling region. No region fits above the
/// top rows, so images starting there are cut short of the bottom.
fn scroll_safe_pieces(rect: Rect, cell_height: u32) -> Vec<Rect> {
    let split = TOP_ROWS_WITHOUT_REGION * cell_height;
    if rect.y >= split || rect.y + rect.h <= split {
        return vec![rect];
    }
    vec![
        Rect { h: split - rect.y, ..rect },
        Rect { y: split, h: rect.y + rect.h - split, ..rect },
    ]
}

fn row_hash(rgb: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    rgb.hash(&mut hasher);
    hasher.finish()
}

/// Rows of a single color look alike wherever they land, so only rows with something on them count.
fn best_shift(old: &[u64], new: &[u64], telling: &[bool], cell_height: u32, max_rows: u32) -> Option<i32> {
    let score = |dy: i64| {
        let (mut matched, mut counted) = (0usize, 0usize);
        for y in 0..new.len() as i64 {
            let from = y + dy;
            if from < 0 || from >= old.len() as i64 || !telling[y as usize] {
                continue;
            }
            counted += 1;
            matched += usize::from(new[y as usize] == old[from as usize]);
        }
        (counted >= MIN_TELLING_PIXEL_ROWS).then(|| matched as f32 / counted as f32)
    };
    let still = score(0)?;
    if still == 1.0 {
        return None;
    }
    let mut best: Option<(i32, f32)> = None;
    for k in 1..=max_rows as i32 {
        for rows in [k, -k] {
            let Some(ratio) = score(i64::from(rows) * i64::from(cell_height)) else { continue };
            if ratio >= SHIFT_MATCH && ratio > still && best.is_none_or(|(_, r)| ratio > r) {
                best = Some((rows, ratio));
            }
        }
    }
    best.map(|(rows, _)| rows)
}

/// Deletes or inserts lines rather than scrolling a region, because Termux forgets the images on
/// lines that scroll out of a region while other lines still show them, and Termux:Monet then crashes.
fn shift_sequence(shift: Shift) -> String {
    let at = format!("\x1b[r\x1b[{};1H", shift.top_row + 1);
    if shift.rows > 0 {
        format!("{at}\x1b[{}M", shift.rows)
    } else {
        format!("{at}\x1b[{}L", -shift.rows)
    }
}

fn place(out: &mut Vec<u8>, rect: Rect, image: &[u8], cell: (u32, u32)) {
    let (col, row) = (rect.x / cell.0, rect.y / cell.1);
    if row >= TOP_ROWS_WITHOUT_REGION {
        out.extend_from_slice(format!("\x1b[1;{row}r").as_bytes());
    } else {
        out.extend_from_slice(b"\x1b[r");
    }
    out.extend_from_slice(format!("\x1b[{};{}H", row + 1, col + 1).as_bytes());
    out.extend_from_slice(image);
}

impl Cells {
    fn reset_activity(&mut self, size: (u32, u32), cell: (u32, u32)) {
        self.grid = (size.0.div_ceil(cell.0), size.1.div_ceil(cell.1));
        self.activity = vec![CellActivity::default(); (self.grid.0 * self.grid.1) as usize];
    }

    fn cells_under(&self, rect: Rect, cell: (u32, u32)) -> Vec<usize> {
        let (cols, rows) = self.grid;
        let (left, top) = (rect.x / cell.0, rect.y / cell.1);
        let right = (rect.x + rect.w).div_ceil(cell.0).min(cols);
        let bottom = (rect.y + rect.h).div_ceil(cell.1).min(rows);
        (top..bottom).flat_map(|row| (left..right).map(move |col| (row * cols + col) as usize)).collect()
    }

    /// Tells whether most of `rect` has kept changing frame after frame, counting a send at `now`.
    fn moving(&self, rect: Rect, cell: (u32, u32), now: Instant) -> bool {
        let under = self.cells_under(rect, cell);
        let moving = under.iter().filter(|&&i| self.activity[i].streak_at(now) >= MOVING_STREAK).count();
        !under.is_empty() && moving * 2 >= under.len()
    }

    fn note_sent(&mut self, rect: Rect, cell: (u32, u32), now: Instant) {
        for i in self.cells_under(rect, cell) {
            let activity = &mut self.activity[i];
            activity.streak = activity.streak_at(now);
            activity.sent_at = Some(now);
        }
    }

    /// A video changes unevenly from row to row, so its changes arrive as many thin strips that are
    /// cheaper to send blurry as one block.
    fn join_moving(&self, rects: Vec<Rect>, cell: (u32, u32), now: Instant) -> Vec<Rect> {
        let (mut moving, mut rest): (Vec<Rect>, Vec<Rect>) = rects.into_iter().partition(|r| self.moving(*r, cell, now));
        'again: loop {
            for i in 0..moving.len() {
                for j in i + 1..moving.len() {
                    let near = Rect { x: moving[i].x.saturating_sub(cell.0), y: moving[i].y.saturating_sub(cell.1), w: moving[i].w + 2 * cell.0, h: moving[i].h + 2 * cell.1 };
                    if touch(near, moving[j]) {
                        let other = moving.swap_remove(j);
                        moving[i] = moving[i].union(other);
                        continue 'again;
                    }
                }
            }
            break;
        }
        moving.append(&mut rest);
        moving
    }

    fn mark_soft(&mut self, rect: Rect, cell: (u32, u32), soft: bool) {
        for i in self.cells_under(rect, cell) {
            self.activity[i].soft = soft;
        }
    }

    fn sharpen_at(&self) -> Option<Instant> {
        self.activity.iter().filter(|a| a.soft).filter_map(|a| a.sent_at).min().map(|at| at + SHARPEN_AFTER)
    }

    /// The blurry cells that have been still long enough, as runs along each row of cells.
    fn take_still_soft(&mut self, cell: (u32, u32), now: Instant) -> Vec<Rect> {
        let (cols, rows) = self.grid;
        let still = |a: &CellActivity| a.soft && a.sent_at.is_some_and(|at| now.duration_since(at) >= SHARPEN_AFTER);
        let mut runs = Vec::new();
        for row in 0..rows {
            let line = &mut self.activity[(row * cols) as usize..((row + 1) * cols) as usize];
            let mut col = 0;
            while col < cols {
                if !still(&line[col as usize]) {
                    col += 1;
                    continue;
                }
                let start = col;
                while col < cols && still(&line[col as usize]) {
                    line[col as usize].soft = false;
                    col += 1;
                }
                runs.push(Rect { x: start * cell.0, y: row * cell.1, w: (col - start) * cell.0, h: cell.1 });
            }
        }
        runs
    }

    fn refresh(&mut self, canvas: &Canvas, premultiplied: bool, rect: Rect) {
        let width = canvas.width as usize;
        for y in rect.y..rect.y + rect.h {
            let row = y as usize * width + rect.x as usize;
            let rgb = over_black(&canvas.pixels[row * 4..(row + rect.w as usize) * 4], premultiplied);
            self.shown[row * 3..row * 3 + rgb.len()].copy_from_slice(&rgb);
        }
    }

    /// Looks for the page having scrolled by whole rows, so the terminal can move what it already shows.
    fn find_shift(&self, canvas: &Canvas, premultiplied: bool, opaque: &[OpaqueArea], cell: (u32, u32)) -> Option<Shift> {
        let (width, height) = (canvas.width, canvas.height);
        let area = opaque.iter().map(|a| a.rect.clamped(width, height)).max_by_key(|r| r.area())?;
        let top_row = area.y.div_ceil(cell.1);
        let bottom = area.y + area.h;
        // Moving lines shifts everything down to the last row, so only a page reaching it can move.
        if top_row < TOP_ROWS_WITHOUT_REGION || bottom + cell.1 < height || (top_row + MIN_SHIFT_ROWS) * cell.1 > bottom {
            return None;
        }
        let (x0, x1) = (area.x as usize, (area.x + area.w) as usize);
        let w = width as usize;
        let (mut old, mut new, mut telling) = (Vec::new(), Vec::new(), Vec::new());
        for y in top_row * cell.1..bottom {
            let row = y as usize * w;
            let fresh = over_black(&canvas.pixels[(row + x0) * 4..(row + x1) * 4], premultiplied);
            old.push(row_hash(&self.shown[(row + x0) * 3..(row + x1) * 3]));
            new.push(row_hash(&fresh));
            telling.push(fresh.chunks_exact(3).any(|p| p != &fresh[..3]));
        }
        let max_rows = (bottom - top_row * cell.1) / cell.1 / 2;
        best_shift(&old, &new, &telling, cell.1, max_rows).map(|rows| Shift { top_row, rows })
    }

    /// Moves `shown` the way the terminal moves its cells and returns the rows that need painting again.
    fn apply_shift(&mut self, shift: Shift, canvas: &Canvas, premultiplied: bool, cell: (u32, u32)) -> Vec<Rect> {
        let (width, height) = (canvas.width, canvas.height);
        let stride = width as usize * 3;
        let band = shift.top_row as usize * cell.1 as usize * stride..height as usize * stride;
        let moved = shift.rows.unsigned_abs() * cell.1;
        let dy = moved as usize * stride;
        let cols = self.grid.0 as usize;
        let rows = shift.rows.unsigned_abs() as usize * cols;
        let activity = shift.top_row as usize * cols..self.activity.len();
        let revealed = if shift.rows > 0 {
            self.shown.copy_within(band.start + dy..band.end, band.start);
            self.activity.copy_within(activity.start + rows..activity.end, activity.start);
            Rect { x: 0, y: height - moved, w: width, h: moved }
        } else {
            self.shown.copy_within(band.start..band.end - dy, band.start + dy);
            self.activity.copy_within(activity.start..activity.end - rows, activity.start + rows);
            Rect { x: 0, y: shift.top_row * cell.1, w: width, h: moved }
        };
        self.refresh(canvas, premultiplied, revealed);
        vec![revealed]
    }

    fn region(&self, width: u32, rect: Rect) -> Vec<u8> {
        let mut out = Vec::with_capacity(rect.area() as usize * 3);
        for y in rect.y..rect.y + rect.h {
            let start = (y as usize * width as usize + rect.x as usize) * 3;
            out.extend_from_slice(&self.shown[start..start + rect.w as usize * 3]);
        }
        out
    }

    /// Updates `shown` from the canvas within a cell aligned `rect` and returns the changed cells,
    /// as runs along each row of cells so changes far apart on one row are not sent together.
    fn take_changes(&mut self, canvas: &Canvas, premultiplied: bool, rect: Rect, cell: (u32, u32)) -> Vec<Rect> {
        let width = canvas.width as usize;
        let cols = (rect.w / cell.0) as usize;
        let mut changes = Vec::new();
        for row in 0..rect.h / cell.1 {
            let mut changed = vec![false; cols];
            for y in rect.y + row * cell.1..rect.y + (row + 1) * cell.1 {
                let src = (y as usize * width + rect.x as usize) * 4;
                let rgb = over_black(&canvas.pixels[src..src + rect.w as usize * 4], premultiplied);
                let dst = (y as usize * width + rect.x as usize) * 3;
                let shown = &mut self.shown[dst..dst + rgb.len()];
                if rgb[..] == shown[..] {
                    continue;
                }
                let span = cell.0 as usize * 3;
                for (col, (new, old)) in rgb.chunks(span).zip(shown.chunks(span)).enumerate() {
                    changed[col] |= new != old;
                }
                shown.copy_from_slice(&rgb);
            }
            let y = rect.y + row * cell.1;
            let mut col = 0;
            while col < cols {
                if !changed[col] {
                    col += 1;
                    continue;
                }
                let mut end = col + 1;
                while end < cols && changed[end..cols.min(end + RUN_GAP_CELLS)].iter().any(|&c| c) {
                    end += 1;
                }
                while !changed[end - 1] {
                    end -= 1;
                }
                let x = rect.x + col as u32 * cell.0;
                changes.push(Rect { x, y, w: (end - col) as u32 * cell.0, h: cell.1 });
                col = end;
            }
        }
        changes
    }
}

impl Terminal {
    pub(in crate::terminal) fn probe_cell_protocol(&mut self, env: &SessionEnv) -> io::Result<Option<CellProtocol>> {
        if let Some(forced) = env.var("TERMINAL_BROWSER_GRAPHICS").as_deref().and_then(forced_protocol) {
            crate::logging::info("terminal", format!("graphics forced to {forced:?}"));
            return Ok(forced);
        }
        if self.wrapper.relayed() {
            return Ok(None);
        }
        let query = format!("\x1b_Gi={GRAPHICS_PROBE_ID},a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\\x1b[c");
        self.io.out().write_all(query.as_bytes())?;
        self.io.out().flush()?;
        let reply = self.read_report(GRAPHICS_PROBE_TIMEOUT_MS, parse_graphics_reply)?;
        let hints = Hints::of(env);
        let chosen = choose_cell_protocol(reply, hints);
        self.cells.moves_images = hints.termux;
        crate::logging::info("terminal", format!("graphics reply {reply:?}, drawing with {}", chosen.map_or("kitty".to_string(), |p| format!("{p:?}"))));
        Ok(chosen)
    }

    pub(in crate::terminal) fn draw_cells(&mut self, protocol: CellProtocol, frame: Frame<'_>, out: &mut Vec<u8>) -> io::Result<usize> {
        self.cell_size()?;
        let cell = self.cell();
        let canvas = frame.canvas;
        let size = (canvas.width, canvas.height);
        let start = out.len();
        let now = Instant::now();
        let resized = self.cells.size != Some(size) || self.cells.grid != (size.0.div_ceil(cell.0), size.1.div_ceil(cell.1));
        let rects = if resized || self.cells.pixels_since_clear >= CLEAR_AFTER_PIXELS {
            out.extend_from_slice(b"\x1b[r\x1b[2J\x1b[3J");
            self.cells.shown = over_black(&canvas.pixels, frame.premultiplied);
            self.cells.size = Some(size);
            self.cells.pixels_since_clear = 0;
            if resized {
                self.cells.reset_activity(size, cell);
            }
            vec![Rect::sized(size.0, size.1)]
        } else {
            let mut damage: Vec<Rect> = frame
                .changed
                .iter()
                .chain(frame.repainted)
                .map(|r| snap(*r, cell, size))
                .filter(|r| !r.is_empty())
                .collect();
            let shift = self
                .cells
                .moves_images
                .then(|| self.cells.find_shift(canvas, frame.premultiplied, frame.opaque, cell))
                .flatten();
            let mut repaint = Vec::new();
            if let Some(shift) = shift {
                out.extend_from_slice(shift_sequence(shift).as_bytes());
                repaint = self.cells.apply_shift(shift, canvas, frame.premultiplied, cell);
                let top = shift.top_row * cell.1;
                damage.push(Rect { x: 0, y: top, w: size.0, h: size.1 - top });
                crate::profiler::count("present.shifted_rows", || u64::from(shift.rows.unsigned_abs()));
            }
            let changes = merge(damage)
                .into_iter()
                .flat_map(|r| self.cells.take_changes(canvas, frame.premultiplied, r, cell));
            let changes: Vec<Rect> = repaint.into_iter().chain(changes).collect();
            let sharpen = if changes.is_empty() { Vec::new() } else { self.cells.take_still_soft(cell, now) };
            let rects = merge(changes.into_iter().chain(sharpen).collect());
            self.cells.join_moving(rects, cell, now)
        };
        self.send_cells(protocol, &rects, now, out);
        Ok(out.len() - start)
    }

    fn send_cells(&mut self, protocol: CellProtocol, rects: &[Rect], now: Instant, out: &mut Vec<u8>) {
        let cell = self.cell();
        let Some(size) = self.cells.size else { return };
        let mut pixels = 0;
        for rect in rects {
            let soft = self.cells.moving(*rect, cell, now) && protocol == CellProtocol::Iterm2 && rect.area() >= MIN_SOFT_PIXELS;
            self.cells.note_sent(*rect, cell, now);
            self.cells.mark_soft(*rect, cell, soft);
            for piece in scroll_safe_pieces(*rect, cell.1) {
                let rgb = self.cells.region(size.0, piece);
                let image = if soft {
                    crate::cell_graphics::iterm2_soft(&rgb, piece.w, piece.h)
                } else {
                    protocol.encode(&rgb, piece.w, piece.h)
                };
                place(out, piece, &image, cell);
                pixels += piece.area();
            }
        }
        if !rects.is_empty() {
            out.extend_from_slice(b"\x1b[r");
        }
        self.cells.pixels_since_clear += pixels;
        crate::profiler::count("present.pixels", || pixels);
    }

    pub(in crate::terminal) fn cells_sharpen_at(&self) -> Option<Instant> {
        self.cells.sharpen_at()
    }

    /// Sends sharp images over the blurry ones once what they show has stopped moving.
    pub(in crate::terminal) fn sharpen_still_cells(&mut self, protocol: CellProtocol) -> io::Result<()> {
        let now = Instant::now();
        let still = self.cells.take_still_soft(self.cell(), now);
        if still.is_empty() {
            return Ok(());
        }
        let mut out = Vec::new();
        self.send_cells(protocol, &merge(still), now, &mut out);
        self.write_synchronized(&out)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KITTY_OK: &[u8] = b"\x1b_Gi=297;OK\x1b\\";

    #[test]
    fn the_graphics_reply_waits_for_the_device_attributes() {
        assert_eq!(parse_graphics_reply(KITTY_OK), None);
        assert_eq!(
            parse_graphics_reply(b"\x1b_Gi=297;OK\x1b\\\x1b[?62;22c"),
            Some(GraphicsReply { kitty: true, sixel: false })
        );
        assert_eq!(
            parse_graphics_reply(b"\x1b[?2026;2$y\x1b[?64;1;2;4;6;9;15;18;21;22c"),
            Some(GraphicsReply { kitty: false, sixel: true })
        );
        assert_eq!(parse_graphics_reply(b"\x1b[?64;14c"), Some(GraphicsReply { kitty: false, sixel: false }));
        assert_eq!(parse_graphics_reply(b"\x1b[?64;4"), None, "reply mid-arrival");
    }

    #[test]
    fn kitty_wins_then_iterm2_then_sixel() {
        let reply = |kitty, sixel| Some(GraphicsReply { kitty, sixel });
        let plain = Hints::default();
        let termux = Hints { termux: true, iterm2: false };
        let iterm2 = Hints { termux: false, iterm2: true };
        assert_eq!(choose_cell_protocol(reply(true, true), termux), None);
        assert_eq!(choose_cell_protocol(reply(false, true), plain), Some(CellProtocol::Sixel));
        assert_eq!(choose_cell_protocol(reply(false, true), termux), Some(CellProtocol::Iterm2));
        assert_eq!(choose_cell_protocol(reply(false, false), iterm2), Some(CellProtocol::Iterm2));
        assert_eq!(choose_cell_protocol(None, iterm2), Some(CellProtocol::Iterm2));
        assert_eq!(choose_cell_protocol(reply(false, false), termux), None);
        assert_eq!(choose_cell_protocol(None, plain), None);
        assert_eq!(forced_protocol(" sixel "), Some(Some(CellProtocol::Sixel)));
        assert_eq!(forced_protocol("kitty"), Some(None));
        assert_eq!(forced_protocol("auto"), None);
    }

    #[test]
    fn damage_snaps_out_to_whole_cells_and_merges_when_touching() {
        let cell = (10, 20);
        assert_eq!(snap(Rect { x: 15, y: 25, w: 10, h: 1 }, cell, (100, 100)), Rect { x: 10, y: 20, w: 20, h: 20 });
        assert_eq!(snap(Rect { x: 95, y: 95, w: 10, h: 10 }, cell, (100, 100)), Rect { x: 90, y: 80, w: 10, h: 20 });
        let merged = merge(vec![
            Rect { x: 0, y: 0, w: 10, h: 20 },
            Rect { x: 50, y: 50, w: 10, h: 20 },
            Rect { x: 10, y: 0, w: 10, h: 20 },
        ]);
        assert_eq!(merged.len(), 2);
        assert!(merged.contains(&Rect { x: 0, y: 0, w: 20, h: 20 }));
        let strip = Rect { x: 0, y: 90, w: 100, h: 10 };
        let scrollbar = Rect { x: 90, y: 0, w: 10, h: 90 };
        assert_eq!(merge(vec![strip, scrollbar]).len(), 2, "a strip and a scrollbar stay apart");
        let crowd: Vec<Rect> = (0..MAX_RECTS as u32 + 5).map(|i| Rect { x: i * 30, y: 0, w: 10, h: 10 }).collect();
        assert_eq!(merge(crowd).len(), MAX_RECTS);
    }

    #[test]
    fn images_from_the_top_rows_stop_before_the_region_starts() {
        assert_eq!(scroll_safe_pieces(Rect { x: 0, y: 40, w: 10, h: 400 }, 20).len(), 1);
        assert_eq!(scroll_safe_pieces(Rect { x: 0, y: 0, w: 10, h: 40 }, 20).len(), 1);
        assert_eq!(
            scroll_safe_pieces(Rect { x: 0, y: 20, w: 10, h: 100 }, 20),
            vec![Rect { x: 0, y: 20, w: 10, h: 20 }, Rect { x: 0, y: 40, w: 10, h: 80 }]
        );
        let mut out = Vec::new();
        place(&mut out, Rect { x: 30, y: 60, w: 10, h: 20 }, &CellProtocol::Sixel.encode(&[0; 600], 10, 20), (10, 20));
        assert!(out.starts_with(b"\x1b[1;3r\x1b[4;4H\x1bP"));
    }

    #[test]
    fn only_cells_that_changed_since_the_last_frame_are_resent() {
        let mut canvas = Canvas::new(40, 40);
        let mut cells = Cells { shown: over_black(&canvas.pixels, false), size: Some((40, 40)), ..Cells::default() };
        let whole = Rect::sized(40, 40);
        assert_eq!(cells.take_changes(&canvas, false, whole, (10, 10)), vec![]);
        canvas.fill_rect(12, 25, 3, 2, [255, 0, 0, 255]);
        assert_eq!(cells.take_changes(&canvas, false, whole, (10, 10)), vec![Rect { x: 10, y: 20, w: 10, h: 10 }]);
        assert_eq!(cells.take_changes(&canvas, false, whole, (10, 10)), vec![]);
        assert_eq!(&cells.region(40, Rect { x: 12, y: 25, w: 1, h: 1 }), &[255, 0, 0]);
        let mut wide = Canvas::new(100, 20);
        let mut cells = Cells { shown: over_black(&wide.pixels, false), size: Some((100, 20)), ..Cells::default() };
        wide.fill_rect(0, 0, 1, 1, [9, 9, 9, 255]);
        wide.fill_rect(99, 0, 1, 1, [9, 9, 9, 255]);
        wide.fill_rect(25, 11, 1, 1, [9, 9, 9, 255]);
        wide.fill_rect(45, 11, 1, 1, [9, 9, 9, 255]);
        assert_eq!(
            cells.take_changes(&wide, false, Rect::sized(100, 20), (10, 10)),
            vec![Rect { x: 0, y: 0, w: 10, h: 10 }, Rect { x: 90, y: 0, w: 10, h: 10 }, Rect { x: 20, y: 10, w: 30, h: 10 }],
            "changes far apart on a row stay apart, close ones join"
        );
    }

    fn striped(width: u32, height: u32, offset: u32) -> Canvas {
        let mut canvas = Canvas::new(width, height);
        for y in 0..height {
            let shade = ((y + offset) * 37 % 251) as u8;
            canvas.fill_rect((y + offset) % 7, y, 3, 1, [shade, 255 - shade, 9, 255]);
        }
        canvas
    }

    #[test]
    fn a_page_scrolled_by_whole_rows_is_moved_by_the_terminal() {
        let cell = (10, 10);
        let before = striped(40, 100, 0);
        let mut cells = Cells { shown: over_black(&before.pixels, false), size: Some((40, 100)), moves_images: true, ..Cells::default() };
        let page = [OpaqueArea { surface: None, rect: Rect { x: 0, y: 20, w: 40, h: 80 } }];
        assert_eq!(cells.find_shift(&before, false, &page, cell), None, "nothing moved");

        let mut after = striped(40, 100, 30);
        after.fill_rect(0, 0, 40, 20, [1, 2, 3, 255]);
        let shift = cells.find_shift(&after, false, &page, cell).expect("a three row shift");
        assert_eq!(shift, Shift { top_row: 2, rows: 3 });
        assert_eq!(shift_sequence(shift), "\x1b[r\x1b[3;1H\x1b[3M");
        let repaint = cells.apply_shift(shift, &after, false, cell);
        assert_eq!(repaint, vec![Rect { x: 0, y: 70, w: 40, h: 30 }]);
        let band = Rect { x: 0, y: 20, w: 40, h: 80 };
        assert_eq!(cells.take_changes(&after, false, band, cell), vec![], "the moved rows already match");

        let back = striped(40, 100, 10);
        let shift = cells.find_shift(&back, false, &page, cell).expect("scrolling back up");
        assert_eq!(shift.rows, -2);
        assert_eq!(shift_sequence(shift), "\x1b[r\x1b[3;1H\x1b[2L");
    }

    #[test]
    fn cells_that_keep_changing_go_soft_until_they_hold_still() {
        let cell = (10, 10);
        let mut cells = Cells::default();
        cells.reset_activity((40, 40), cell);
        let video = Rect { x: 0, y: 0, w: 20, h: 20 };
        let start = Instant::now();
        let mut at = start;
        for _ in 1..MOVING_STREAK {
            assert!(!cells.moving(video, cell, at), "one change or a few is not playing anything");
            cells.note_sent(video, cell, at);
            at += Duration::from_millis(40);
        }
        assert!(cells.moving(video, cell, at));
        let strips = vec![Rect { x: 0, y: 0, w: 10, h: 10 }, Rect { x: 0, y: 10, w: 20, h: 10 }, Rect { x: 30, y: 30, w: 10, h: 10 }];
        assert_eq!(
            cells.join_moving(strips, cell, at),
            vec![video, Rect { x: 30, y: 30, w: 10, h: 10 }],
            "strips of a moving area join, a still one elsewhere does not"
        );
        cells.note_sent(video, cell, at);
        cells.mark_soft(video, cell, true);
        assert_eq!(cells.sharpen_at(), Some(at + SHARPEN_AFTER));
        assert_eq!(cells.take_still_soft(cell, at + Duration::from_millis(100)), vec![], "still moving a moment ago");
        assert_eq!(
            cells.take_still_soft(cell, at + SHARPEN_AFTER),
            vec![Rect { x: 0, y: 0, w: 20, h: 10 }, Rect { x: 0, y: 10, w: 20, h: 10 }]
        );
        assert_eq!(cells.sharpen_at(), None);
        assert!(!cells.moving(video, cell, at + SHARPEN_AFTER), "a pause starts the count over");
    }

    #[test]
    fn blank_rows_do_not_vote_for_a_shift() {
        let blank = vec![7u64; 40];
        let mut telling = vec![false; 40];
        assert_eq!(best_shift(&blank, &blank, &telling, 10, 2), None);
        let old: Vec<u64> = (0..40).collect();
        let new: Vec<u64> = (100..140).collect();
        telling.iter_mut().for_each(|t| *t = true);
        assert_eq!(best_shift(&old, &new, &telling, 10, 2), None, "unrelated content is not a shift");
    }
}

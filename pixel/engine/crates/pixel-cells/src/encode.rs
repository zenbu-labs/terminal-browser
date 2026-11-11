use std::io::Write;

use pixel_core::CaretShape;

use crate::color::CellColor;
use crate::grid::{BOLD, CellGrid, DIM, INVERSE, ITALIC, STRIKETHROUGH, Symbol, UNDERLINE};
use crate::paint::Caret;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Pen {
    fg: CellColor,
    bg: CellColor,
    attrs: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scroll {
    pub top: u16,
    pub bottom: u16,
    pub by: i32,
}

#[derive(Debug, Default)]
pub struct Encoder {
    at: Option<(u16, u16)>,
    pen: Option<Pen>,
    cursor_visible: bool,
    cursor_at: Option<(u16, u16)>,
    cursor_shape: Option<CaretShape>,
}

const ATTR_CODES: [(u8, &str); 6] = [(BOLD, "1"), (DIM, "2"), (ITALIC, "3"), (UNDERLINE, "4"), (INVERSE, "7"), (STRIKETHROUGH, "9")];

impl Encoder {
    pub fn forget(&mut self) {
        *self = Encoder::default();
    }

    pub fn full(&mut self, next: &CellGrid, caret: Option<Caret>, out: &mut Vec<u8>) {
        self.forget();
        out.extend_from_slice(b"\x1b[?2026h\x1b[?25l\x1b[0m\x1b[H\x1b[2J");
        self.pen = Some(Pen { fg: CellColor::Default, bg: CellColor::Default, attrs: 0 });
        self.at = Some((0, 0));
        let blank = CellGrid::new(next.width, next.height);
        self.cells(&blank, next, out);
        self.place_cursor(caret, out, true);
        out.extend_from_slice(b"\x1b[?2026l");
    }

    pub fn diff(&mut self, prev: &CellGrid, next: &CellGrid, caret: Option<Caret>, out: &mut Vec<u8>) {
        self.diff_scrolled(prev, next, &[], caret, out);
    }

    pub fn diff_scrolled(&mut self, prev: &CellGrid, next: &CellGrid, scrolls: &[Scroll], caret: Option<Caret>, out: &mut Vec<u8>) {
        let start = out.len();
        out.extend_from_slice(b"\x1b[?2026h");
        let body = out.len();
        if self.cursor_visible {
            out.extend_from_slice(b"\x1b[?25l");
        }
        let cells_start = out.len();
        for scroll in scrolls {
            let _ = write!(out, "\x1b[{};{}r", scroll.top + 1, scroll.bottom);
            if scroll.by > 0 {
                let _ = write!(out, "\x1b[{}S", scroll.by);
            } else {
                let _ = write!(out, "\x1b[{}T", -scroll.by);
            }
            out.extend_from_slice(b"\x1b[r");
            self.at = None;
        }
        self.cells(prev, next, out);
        let drew = out.len() > cells_start;
        if !drew {
            out.truncate(body);
        } else if self.cursor_visible {
            self.cursor_visible = false;
            self.cursor_at = None;
        }
        self.place_cursor(caret, out, drew);
        if out.len() == body {
            out.truncate(start);
            return;
        }
        out.extend_from_slice(b"\x1b[?2026l");
    }

    fn cells(&mut self, prev: &CellGrid, next: &CellGrid, out: &mut Vec<u8>) {
        let width = next.width as usize;
        for y in 0..next.height {
            if next.row_equal(y, prev) {
                continue;
            }
            let row = next.index(0, y);
            let mut x = 0usize;
            while x < width {
                let i = row + x;
                if matches!(next.symbol(i), Symbol::Continuation) || next.same_cell(i, prev, i) {
                    x += 1;
                    continue;
                }
                let cells = next.width_at(i).max(1);
                if next.is_cluster(i) && cells > 1 {
                    for k in 1..cells.min(width - x) {
                        self.move_to(x as u16 + k as u16, y, out);
                        self.style(next, i + k, out);
                        out.push(b' ');
                        self.advance(1, next.width);
                    }
                }
                self.move_to(x as u16, y, out);
                self.style(next, i, out);
                match next.symbol(i) {
                    Symbol::Char(ch) => {
                        let mut buf = [0u8; 4];
                        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        self.advance(cells, next.width);
                    }
                    Symbol::Cluster(s) => {
                        out.extend_from_slice(s.as_bytes());
                        self.at = None;
                    }
                    Symbol::Continuation => {}
                }
                x += cells;
            }
        }
    }

    fn advance(&mut self, cells: usize, width: u16) {
        self.at = self.at.and_then(|(x, y)| {
            let x = x as usize + cells;
            (x < width as usize).then_some((x as u16, y))
        });
    }

    fn move_to(&mut self, x: u16, y: u16, out: &mut Vec<u8>) {
        match self.at {
            Some(at) if at == (x, y) => {}
            Some((ax, ay)) if ay == y && ax < x => {
                let _ = write!(out, "\x1b[{}C", x - ax);
            }
            _ => {
                let _ = write!(out, "\x1b[{};{}H", y + 1, x + 1);
            }
        }
        self.at = Some((x, y));
    }

    fn style(&mut self, grid: &CellGrid, i: usize, out: &mut Vec<u8>) {
        let wanted = Pen { fg: grid.fg[i], bg: grid.bg[i], attrs: grid.attrs[i] };
        if self.pen == Some(wanted) {
            return;
        }
        let mut codes: Vec<String> = Vec::new();
        let reset = match self.pen {
            None => true,
            Some(pen) => pen.attrs & !wanted.attrs != 0,
        };
        let from = if reset {
            codes.push("0".into());
            Pen { fg: CellColor::Default, bg: CellColor::Default, attrs: 0 }
        } else {
            self.pen.expect("checked above")
        };
        for (bit, code) in ATTR_CODES {
            if wanted.attrs & bit != 0 && from.attrs & bit == 0 {
                codes.push(code.into());
            }
        }
        if wanted.fg != from.fg {
            codes.push(color_code(wanted.fg, false));
        }
        if wanted.bg != from.bg {
            codes.push(color_code(wanted.bg, true));
        }
        if !codes.is_empty() {
            let _ = write!(out, "\x1b[{}m", codes.join(";"));
        }
        self.pen = Some(wanted);
    }

    fn place_cursor(&mut self, caret: Option<Caret>, out: &mut Vec<u8>, moved: bool) {
        match caret {
            Some(caret) => {
                if moved || self.cursor_at != Some((caret.x, caret.y)) || self.at != Some((caret.x, caret.y)) {
                    let _ = write!(out, "\x1b[{};{}H", caret.y + 1, caret.x + 1);
                    self.at = Some((caret.x, caret.y));
                    self.cursor_at = Some((caret.x, caret.y));
                }
                if self.cursor_shape != Some(caret.shape) {
                    let code = match caret.shape {
                        CaretShape::Block => 2,
                        CaretShape::Underscore => 4,
                        CaretShape::Bar => 6,
                    };
                    let _ = write!(out, "\x1b[{code} q");
                    self.cursor_shape = Some(caret.shape);
                }
                if !self.cursor_visible {
                    out.extend_from_slice(b"\x1b[?25h");
                    self.cursor_visible = true;
                }
            }
            None => {
                if self.cursor_visible {
                    out.extend_from_slice(b"\x1b[?25l");
                    self.cursor_visible = false;
                }
                self.cursor_at = None;
            }
        }
    }
}

fn color_code(color: CellColor, background: bool) -> String {
    let base = if background { 40 } else { 30 };
    match color {
        CellColor::Default => (base + 9).to_string(),
        CellColor::Indexed(n) if n < 8 => (base + n as u32).to_string(),
        CellColor::Indexed(n) if n < 16 => (base + 60 + n as u32 - 8).to_string(),
        CellColor::Indexed(n) => format!("{};5;{n}", base + 8),
        CellColor::Rgb(r, g, b) => format!("{};2;{r};{g};{b}", base + 8),
    }
}

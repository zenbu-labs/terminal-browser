use std::collections::HashMap;

use crate::color::CellColor;

pub type Rgb = [u8; 3];

pub const BOLD: u8 = 1;
pub const DIM: u8 = 1 << 1;
pub const ITALIC: u8 = 1 << 2;
pub const UNDERLINE: u8 = 1 << 3;
pub const STRIKETHROUGH: u8 = 1 << 4;
pub const INVERSE: u8 = 1 << 5;

const GRAPHEME: u32 = 1 << 31;
pub const CONTINUATION: u32 = 0x0011_0000;
pub const UNKNOWN: u32 = 0x0011_0001;
pub const BLANK: u32 = ' ' as u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Symbol<'a> {
    Char(char),
    Cluster(&'a str),
    Continuation,
}

#[derive(Debug, Clone, Default)]
pub struct Graphemes {
    clusters: Vec<(String, u8)>,
    index: HashMap<String, u32>,
}

impl Graphemes {
    fn intern(&mut self, cluster: &str, width: u8) -> u32 {
        if let Some(&id) = self.index.get(cluster) {
            return id;
        }
        let id = self.clusters.len() as u32;
        self.clusters.push((cluster.to_string(), width));
        self.index.insert(cluster.to_string(), id);
        id
    }

    fn clear(&mut self) {
        self.clusters.clear();
        self.index.clear();
    }
}

#[derive(Debug, Clone, Default)]
pub struct CellGrid {
    pub width: u16,
    pub height: u16,
    pub chars: Vec<u32>,
    pub fg: Vec<CellColor>,
    pub bg: Vec<CellColor>,
    pub attrs: Vec<u8>,
    pub fg_rgb: Vec<Rgb>,
    pub bg_rgb: Vec<Rgb>,
    pub graphemes: Graphemes,
}

impl CellGrid {
    pub fn new(width: u16, height: u16) -> Self {
        let mut grid = Self::default();
        grid.resize(width, height);
        grid
    }

    pub fn resize(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
        let len = width as usize * height as usize;
        self.chars = vec![BLANK; len];
        self.fg = vec![CellColor::Default; len];
        self.bg = vec![CellColor::Default; len];
        self.attrs = vec![0; len];
        self.fg_rgb = vec![[0; 3]; len];
        self.bg_rgb = vec![[0; 3]; len];
        self.graphemes.clear();
    }

    pub fn clear(&mut self, fg: Rgb, bg: Rgb) {
        self.chars.fill(BLANK);
        self.attrs.fill(0);
        self.fg_rgb.fill(fg);
        self.bg_rgb.fill(bg);
        self.fg.fill(CellColor::Default);
        self.bg.fill(CellColor::Default);
        self.graphemes.clear();
    }

    pub fn len(&self) -> usize {
        self.chars.len()
    }

    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
    }

    pub fn index(&self, x: u16, y: u16) -> usize {
        y as usize * self.width as usize + x as usize
    }

    pub fn symbol(&self, i: usize) -> Symbol<'_> {
        let raw = self.chars[i];
        if raw == UNKNOWN {
            Symbol::Char(' ')
        } else if raw == CONTINUATION {
            Symbol::Continuation
        } else if raw & GRAPHEME != 0 {
            Symbol::Cluster(&self.graphemes.clusters[(raw & !GRAPHEME) as usize].0)
        } else {
            Symbol::Char(char::from_u32(raw).unwrap_or(' '))
        }
    }

    pub fn width_at(&self, i: usize) -> usize {
        let raw = self.chars[i];
        if raw == CONTINUATION {
            0
        } else if raw & GRAPHEME != 0 {
            self.graphemes.clusters[(raw & !GRAPHEME) as usize].1 as usize
        } else {
            char::from_u32(raw).map_or(1, |ch| unicode_width::UnicodeWidthChar::width(ch).unwrap_or(1).max(1))
        }
    }

    pub fn is_cluster(&self, i: usize) -> bool {
        let raw = self.chars[i];
        raw != CONTINUATION && raw & GRAPHEME != 0
    }

    pub fn same_symbol(&self, i: usize, other: &CellGrid, j: usize) -> bool {
        let (a, b) = (self.chars[i], other.chars[j]);
        if a & GRAPHEME == 0 || b & GRAPHEME == 0 || a == CONTINUATION || b == CONTINUATION {
            return a == b;
        }
        self.symbol(i) == other.symbol(j)
    }

    pub fn same_cell(&self, i: usize, other: &CellGrid, j: usize) -> bool {
        self.same_symbol(i, other, j)
            && self.fg[i] == other.fg[j]
            && self.bg[i] == other.bg[j]
            && self.attrs[i] == other.attrs[j]
    }

    pub fn row_equal(&self, y: u16, other: &CellGrid) -> bool {
        let start = self.index(0, y);
        let end = start + self.width as usize;
        let plain = self.chars[start..end] == other.chars[start..end]
            && self.fg[start..end] == other.fg[start..end]
            && self.bg[start..end] == other.bg[start..end]
            && self.attrs[start..end] == other.attrs[start..end];
        plain && (start..end).all(|i| !self.is_cluster(i) || self.same_symbol(i, other, i))
    }

    pub fn put(&mut self, i: usize, cluster: &str, width: usize) {
        let mut chars = cluster.chars();
        let raw = match (chars.next(), chars.next()) {
            (Some(ch), None) => ch as u32,
            _ => GRAPHEME | self.graphemes.intern(cluster, width.min(255) as u8),
        };
        self.erase_wide_neighbours(i, width);
        self.chars[i] = raw;
        for k in 1..width {
            if i + k < self.len() && !(i + k).is_multiple_of(self.width as usize) {
                self.chars[i + k] = CONTINUATION;
                self.bg_rgb[i + k] = self.bg_rgb[i];
                self.fg_rgb[i + k] = self.fg_rgb[i];
                self.attrs[i + k] = self.attrs[i];
            }
        }
    }

    pub fn blank(&mut self, i: usize) {
        self.erase_wide_neighbours(i, 1);
        self.chars[i] = BLANK;
    }

    fn erase_wide_neighbours(&mut self, i: usize, width: usize) {
        let row_start = i - i % self.width as usize;
        if self.chars[i] == CONTINUATION {
            let mut lead = i;
            while lead > row_start && self.chars[lead] == CONTINUATION {
                lead -= 1;
            }
            self.chars[lead] = BLANK;
            for k in lead + 1..i {
                self.chars[k] = BLANK;
            }
        }
        let row_end = row_start + self.width as usize;
        let mut k = i + width.max(1);
        while k < row_end && self.chars[k] == CONTINUATION {
            self.chars[k] = BLANK;
            k += 1;
        }
    }

    pub fn scroll(&mut self, top: u16, bottom: u16, by: i32) {
        let width = self.width as usize;
        let (top, bottom) = (top as usize, bottom as usize);
        let rows = bottom - top;
        let shift = by.unsigned_abs() as usize;
        if shift >= rows {
            self.chars[top * width..bottom * width].fill(UNKNOWN);
            return;
        }
        let moved = (rows - shift) * width;
        let (from, to, exposed) = if by > 0 {
            ((top + shift) * width, top * width, (bottom - shift) * width..bottom * width)
        } else {
            (top * width, (top + shift) * width, top * width..(top + shift) * width)
        };
        self.chars.copy_within(from..from + moved, to);
        self.fg.copy_within(from..from + moved, to);
        self.bg.copy_within(from..from + moved, to);
        self.attrs.copy_within(from..from + moved, to);
        self.fg_rgb.copy_within(from..from + moved, to);
        self.bg_rgb.copy_within(from..from + moved, to);
        self.chars[exposed].fill(UNKNOWN);
    }

    pub fn stale_cells(&self, shown: &CellGrid, top: u16, bottom: u16, by: i32) -> usize {
        let width = self.width as usize;
        (top..bottom)
            .map(|y| {
                let from = y as i32 + by;
                if from < top as i32 || from >= bottom as i32 {
                    return width;
                }
                let (row, source) = (self.index(0, y), shown.index(0, from as u16));
                (0..width).filter(|&x| !self.same_cell(row + x, shown, source + x)).count()
            })
            .sum()
    }

    pub fn text(&self) -> String {
        let mut out = String::new();
        for y in 0..self.height {
            let mut line = String::new();
            for x in 0..self.width {
                match self.symbol(self.index(x, y)) {
                    Symbol::Char(ch) => line.push(ch),
                    Symbol::Cluster(s) => line.push_str(s),
                    Symbol::Continuation => {}
                }
            }
            out.push_str(line.trim_end());
            out.push('\n');
        }
        out
    }
}

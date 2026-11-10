use std::ops::Range;
use std::time::{Duration, Instant};

use crate::tree::NodeId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocPos {
    pub node: NodeId,
    pub offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocSelection {
    pub anchor: DocPos,
    pub focus: DocPos,
}

impl DocSelection {
    pub fn collapsed(pos: DocPos) -> Self {
        Self {
            anchor: pos,
            focus: pos,
        }
    }

    pub fn is_collapsed(&self) -> bool {
        self.anchor == self.focus
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClickGesture {
    Place,
    Word,
    Line,
}

impl ClickGesture {
    pub(crate) fn from_count(count: u32) -> Self {
        match count % 3 {
            1 => Self::Place,
            2 => Self::Word,
            _ => Self::Line,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ClickTracker {
    last: Option<(Instant, (f32, f32))>,
    count: u32,
}

impl ClickTracker {
    pub(crate) fn register(&mut self, point: (f32, f32), now: Instant) -> u32 {
        let chained = self.last.is_some_and(|(at, p)| {
            now.duration_since(at) < Duration::from_millis(450)
                && (p.0 - point.0).abs() < 6.0
                && (p.1 - point.1).abs() < 6.0
        });
        self.count = if chained { self.count + 1 } else { 1 };
        self.last = Some((now, point));
        self.count
    }
}

pub(crate) fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn char_class(c: char) -> u8 {
    if is_word_char(c) {
        0
    } else if c == '\n' {
        1
    } else {
        2
    }
}

pub(crate) fn snap_to_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

pub(crate) fn prev_char(text: &str, offset: usize) -> usize {
    text[..offset]
        .char_indices()
        .next_back()
        .map_or(0, |(i, _)| i)
}

pub(crate) fn next_char(text: &str, offset: usize) -> usize {
    text[offset..]
        .chars()
        .next()
        .map_or(offset, |c| offset + c.len_utf8())
}

pub(crate) fn prev_word_boundary(text: &str, offset: usize) -> usize {
    let mut pos = offset;
    let mut iter = text[..offset].char_indices().rev().peekable();
    while let Some(&(i, c)) = iter.peek() {
        if is_word_char(c) {
            break;
        }
        pos = i;
        iter.next();
    }
    while let Some(&(i, c)) = iter.peek() {
        if !is_word_char(c) {
            break;
        }
        pos = i;
        iter.next();
    }
    pos
}

pub(crate) fn next_word_boundary(text: &str, offset: usize) -> usize {
    let mut pos = offset;
    let mut iter = text[offset..].char_indices().peekable();
    while let Some(&(i, c)) = iter.peek() {
        if is_word_char(c) {
            break;
        }
        pos = offset + i + c.len_utf8();
        iter.next();
    }
    while let Some(&(i, c)) = iter.peek() {
        if !is_word_char(c) {
            break;
        }
        pos = offset + i + c.len_utf8();
        iter.next();
    }
    pos
}

pub(crate) fn line_start(text: &str, offset: usize) -> usize {
    text[..offset].rfind('\n').map_or(0, |i| i + 1)
}

pub(crate) fn line_end(text: &str, offset: usize) -> usize {
    text[offset..].find('\n').map_or(text.len(), |i| offset + i)
}

pub(crate) fn word_range_at(text: &str, offset: usize) -> Option<Range<usize>> {
    let offset = snap_to_boundary(text, offset);
    let pivot = if text[offset..].chars().next().is_some_and(is_word_char) {
        offset
    } else if text[..offset].chars().next_back().is_some_and(is_word_char) {
        prev_char(text, offset)
    } else if offset < text.len() {
        offset
    } else if offset > 0 {
        prev_char(text, offset)
    } else {
        return None;
    };
    let class = char_class(text[pivot..].chars().next().expect("pivot in bounds"));
    let mut start = pivot;
    for (i, c) in text[..pivot].char_indices().rev() {
        if char_class(c) != class {
            break;
        }
        start = i;
    }
    let mut end = pivot;
    for (i, c) in text[pivot..].char_indices() {
        if char_class(c) != class {
            break;
        }
        end = pivot + i + c.len_utf8();
    }
    Some(start..end)
}

pub(crate) fn line_range_at(text: &str, offset: usize) -> Range<usize> {
    let offset = snap_to_boundary(text, offset);
    let start = line_start(text, offset);
    let end = line_end(text, offset);
    start..(end + 1).min(text.len())
}

mod doc;

pub(crate) use doc::{DocLayout, DocSelectionState, RichSelection};

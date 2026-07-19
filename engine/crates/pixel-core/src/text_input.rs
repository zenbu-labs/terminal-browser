use std::collections::VecDeque;
use std::ops::Range;
use std::time::Instant;

use crate::canvas::{char_advance, measure_marked};
use crate::selection::{
    ClickGesture, ClickTracker, line_end, line_range_at, line_start, next_char, next_word_boundary,
    prev_char, prev_word_boundary, snap_to_boundary, word_range_at,
};
use crate::terminal::{Key, KeyEvent, Mouse, MouseButton, MouseKind};
use crate::tree::PxRect;
use crate::wrap::{line_of_offset, wrap_lines};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Granularity {
    Char,
    Word,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputAction {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InputReply {
    None,
    Edited,
    Moved,
    Selected,
    Copy(String, Vec<Mark>),
    Cut(String, Vec<Mark>),
    RequestPaste,
}

#[derive(Debug, Clone, Copy)]
pub struct InputGeometry {
    pub origin: (f32, f32),
    pub font: usize,
    pub px: f32,
    pub max_width: Option<f32>,
}

impl InputGeometry {
    pub fn offset_at(
        &self,
        text: &str,
        marks: &[Mark],
        point: (f32, f32),
        fonts: &[fontdue::Font],
    ) -> usize {
        let font = &fonts[self.font.min(fonts.len() - 1)];
        point_to_offset(
            text,
            point.0 - self.origin.0,
            point.1 - self.origin.1,
            font,
            self.px,
            self.max_width,
            marks,
        )
    }

    pub fn caret_rect(
        &self,
        text: &str,
        marks: &[Mark],
        cursor: usize,
        fonts: &[fontdue::Font],
    ) -> PxRect {
        let font = &fonts[self.font.min(fonts.len() - 1)];
        let (x, y) = offset_to_point(text, cursor, font, self.px, self.max_width, marks);
        PxRect {
            x: self.origin.0 + x,
            y: self.origin.1 + y,
            w: caret_width(self.px),
            h: line_height(font, self.px),
        }
    }
}

pub(crate) fn caret_width(px: f32) -> f32 {
    (px / 8.0).max(2.0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mark {
    pub id: u64,
    pub offset: usize,
    pub advance: f32,
    pub data: Option<String>,
}

pub const MARK_CHAR: char = '\u{FFFC}';

pub(crate) fn claim_marks(text: &str, marks: &[(u64, usize)]) -> (String, Vec<Mark>) {
    let mut claimed = std::collections::HashMap::new();
    for &(id, offset) in marks {
        claimed.entry(offset).or_insert(id);
    }
    let mut out = String::with_capacity(text.len());
    let mut kept = Vec::new();
    for (i, ch) in text.char_indices() {
        if ch == MARK_CHAR {
            if let Some(&id) = claimed.get(&i) {
                kept.push(Mark {
                    id,
                    offset: out.len(),
                    advance: 0.0,
                    data: None,
                });
                out.push(MARK_CHAR);
            }
        } else {
            out.push(ch);
        }
    }
    (out, kept)
}

pub(crate) fn mark_advance_at(marks: &[Mark], offset: usize) -> f32 {
    marks
        .binary_search_by_key(&offset, |m| m.offset)
        .ok()
        .map_or(0.0, |i| marks[i].advance)
}

#[derive(Debug, Clone)]
struct Edit {
    at: usize,
    removed: String,
    inserted: String,
    cursor_before: usize,
    anchor_before: Option<usize>,
    kind: EditKind,
    removed_marks: Vec<Mark>,
    inserted_marks: Vec<Mark>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditKind {
    Typing,
    Backspace,
    Other,
}

const MAX_UNDO: usize = 1000;

#[derive(Debug, Clone, Default)]
pub struct TextInput {
    text: String,
    cursor: usize,
    anchor: Option<usize>,
    goal_x: Option<f32>,
    undo: VecDeque<Edit>,
    redo: Vec<Edit>,
    sealed: bool,
    clicks: ClickTracker,
    selecting: bool,
    marks: Vec<Mark>,
    tab_text: Option<String>,
    auto_indent: bool,
}

impl TextInput {
    pub fn new(text: String) -> Self {
        let cursor = text.len();
        Self {
            text,
            cursor,
            ..Self::default()
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn selection(&self) -> Option<Range<usize>> {
        let anchor = self.anchor?;
        if anchor == self.cursor {
            return None;
        }
        Some(anchor.min(self.cursor)..anchor.max(self.cursor))
    }

    pub fn selected_text(&self) -> Option<&str> {
        self.selection().map(|range| &self.text[range])
    }

    pub fn insert(&mut self, s: &str) {
        if s.contains(MARK_CHAR) {
            let sanitized: String = s.chars().filter(|&c| c != MARK_CHAR).collect();
            return self.insert(&sanitized);
        }
        let caret = self.cursor..self.cursor;
        let range = self.selection().unwrap_or(caret);
        let kind = if range.is_empty() && s.chars().count() == 1 && s != "\n" {
            EditKind::Typing
        } else {
            EditKind::Other
        };
        self.splice(range, s, kind);
    }

    pub fn marks(&self) -> &[Mark] {
        &self.marks
    }

    pub fn with_marks(text: String, marks: &[(u64, usize)]) -> Self {
        let (text, marks) = claim_marks(&text, marks);
        let cursor = text.len();
        Self {
            text,
            cursor,
            marks,
            ..Self::default()
        }
    }

    pub fn insert_mark(&mut self, id: u64, offset: Option<usize>) {
        if self.marks.iter().any(|m| m.id == id) {
            return;
        }
        let range = match offset {
            Some(at) => {
                let at = self.snap_to_boundary(at);
                at..at
            }
            None => {
                let caret = self.cursor..self.cursor;
                self.selection().unwrap_or(caret)
            }
        };
        let at = range.start;
        let mut buf = [0u8; 4];
        self.splice(range, MARK_CHAR.encode_utf8(&mut buf), EditKind::Other);
        let index = self
            .marks
            .iter()
            .position(|m| m.offset >= at)
            .unwrap_or(self.marks.len());
        self.marks.insert(
            index,
            Mark {
                id,
                offset: at,
                advance: 0.0,
                data: None,
            },
        );
    }

    pub fn remove_mark(&mut self, id: u64) {
        let Some(mark) = self.marks.iter().find(|m| m.id == id) else {
            return;
        };
        let start = mark.offset;
        self.splice(start..start + MARK_CHAR.len_utf8(), "", EditKind::Other);
    }

    fn selection_marks(&self) -> Vec<Mark> {
        let Some(range) = self.selection() else {
            return Vec::new();
        };
        self.marks
            .iter()
            .filter(|m| m.offset >= range.start && m.offset < range.end)
            .map(|m| Mark {
                offset: m.offset - range.start,
                ..m.clone()
            })
            .collect()
    }

    pub fn insert_rich(&mut self, text: &str, marks: &[(usize, String)], first_id: u64) {
        let caret = self.cursor..self.cursor;
        let range = self.selection().unwrap_or(caret);
        let at = range.start;
        self.splice(range, text, EditKind::Other);
        for (i, (rel, data)) in marks.iter().enumerate() {
            let offset = at + rel;
            let index = self
                .marks
                .iter()
                .position(|m| m.offset >= offset)
                .unwrap_or(self.marks.len());
            self.marks.insert(
                index,
                Mark {
                    id: first_id + i as u64,
                    offset,
                    advance: 0.0,
                    data: Some(data.clone()),
                },
            );
        }
    }

    fn snap_to_boundary(&self, offset: usize) -> usize {
        let mut at = offset.min(self.text.len());
        while at > 0 && !self.text.is_char_boundary(at) {
            at -= 1;
        }
        at
    }

    pub fn set_mark_advance(&mut self, id: u64, advance: f32) -> bool {
        let Some(mark) = self.marks.iter_mut().find(|m| m.id == id) else {
            return false;
        };
        if (mark.advance - advance).abs() < 0.01 {
            return false;
        }
        mark.advance = advance;
        true
    }

    fn remap_marks(
        &mut self,
        at: usize,
        old_len: usize,
        new_len: usize,
        stash: &mut Vec<Mark>,
        restore: &mut Vec<Mark>,
    ) {
        let mut kept = Vec::with_capacity(self.marks.len() + restore.len());
        for mut mark in self.marks.drain(..) {
            if mark.offset < at {
                kept.push(mark);
            } else if mark.offset < at + old_len {
                mark.offset -= at;
                stash.push(mark);
            } else {
                mark.offset = mark.offset - old_len + new_len;
                kept.push(mark);
            }
        }
        for mark in restore.drain(..) {
            kept.push(Mark {
                offset: at + mark.offset,
                ..mark
            });
        }
        kept.sort_by_key(|m| m.offset);
        self.marks = kept;
    }

    pub fn delete_selection(&mut self) -> bool {
        let Some(range) = self.selection() else {
            self.anchor = None;
            return false;
        };
        self.splice(range, "", EditKind::Other);
        true
    }

    pub fn delete_backward(&mut self, granularity: Granularity) {
        if self.delete_selection() {
            return;
        }
        let start = self.left_boundary(granularity);
        let kind = if granularity == Granularity::Char {
            EditKind::Backspace
        } else {
            EditKind::Other
        };
        self.splice(start..self.cursor, "", kind);
    }

    pub fn delete_forward(&mut self, granularity: Granularity) {
        if self.delete_selection() {
            return;
        }
        let end = self.right_boundary(granularity);
        self.splice(self.cursor..end, "", EditKind::Other);
    }

    fn splice(&mut self, range: Range<usize>, replacement: &str, kind: EditKind) {
        let mut removed_marks = Vec::new();
        self.remap_marks(
            range.start,
            range.len(),
            replacement.len(),
            &mut removed_marks,
            &mut Vec::new(),
        );
        let edit = Edit {
            at: range.start,
            removed: self.text[range.clone()].to_string(),
            inserted: replacement.to_string(),
            cursor_before: self.cursor,
            anchor_before: self.anchor,
            kind,
            removed_marks,
            inserted_marks: Vec::new(),
        };
        self.text.replace_range(range.clone(), replacement);
        self.cursor = range.start + replacement.len();
        self.anchor = None;
        self.goal_x = None;
        self.record(edit);
    }

    fn record(&mut self, edit: Edit) {
        self.redo.clear();
        let may_coalesce = !self.sealed;
        self.sealed = false;
        if may_coalesce && let Some(prev) = self.undo.back_mut() {
            match (prev.kind, edit.kind) {
                (EditKind::Typing, EditKind::Typing)
                    if edit.at == prev.at + prev.inserted.len() =>
                {
                    prev.inserted.push_str(&edit.inserted);
                    return;
                }
                (EditKind::Backspace, EditKind::Backspace)
                    if edit.at + edit.removed.len() == prev.at =>
                {
                    prev.at = edit.at;
                    for mark in &mut prev.removed_marks {
                        mark.offset += edit.removed.len();
                    }
                    prev.removed_marks.splice(0..0, edit.removed_marks);
                    prev.removed = format!("{}{}", edit.removed, prev.removed);
                    return;
                }
                _ => {}
            }
        }
        self.undo.push_back(edit);
        if self.undo.len() > MAX_UNDO {
            self.undo.pop_front();
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn undo(&mut self) -> bool {
        let Some(mut edit) = self.undo.pop_back() else {
            return false;
        };
        self.text
            .replace_range(edit.at..edit.at + edit.inserted.len(), &edit.removed);
        let (mut stash, mut restore) =
            (std::mem::take(&mut edit.inserted_marks), std::mem::take(&mut edit.removed_marks));
        self.remap_marks(
            edit.at,
            edit.inserted.len(),
            edit.removed.len(),
            &mut stash,
            &mut restore,
        );
        edit.inserted_marks = stash;
        self.cursor = edit.cursor_before;
        self.anchor = edit.anchor_before;
        self.goal_x = None;
        self.sealed = true;
        self.redo.push(edit);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(mut edit) = self.redo.pop() else {
            return false;
        };
        self.text
            .replace_range(edit.at..edit.at + edit.removed.len(), &edit.inserted);
        let (mut stash, mut restore) =
            (std::mem::take(&mut edit.removed_marks), std::mem::take(&mut edit.inserted_marks));
        self.remap_marks(
            edit.at,
            edit.removed.len(),
            edit.inserted.len(),
            &mut stash,
            &mut restore,
        );
        edit.removed_marks = stash;
        self.cursor = edit.at + edit.inserted.len();
        self.anchor = None;
        self.goal_x = None;
        self.sealed = true;
        self.undo.push_back(edit);
        true
    }

    pub fn move_left(&mut self, granularity: Granularity, extend: bool) {
        if !extend
            && granularity == Granularity::Char
            && let Some(range) = self.selection()
        {
            self.place(range.start, false);
            return;
        }
        let target = self.left_boundary(granularity);
        self.place(target, extend);
    }

    pub fn move_right(&mut self, granularity: Granularity, extend: bool) {
        if !extend
            && granularity == Granularity::Char
            && let Some(range) = self.selection()
        {
            self.place(range.end, false);
            return;
        }
        let target = self.right_boundary(granularity);
        self.place(target, extend);
    }

    pub fn move_up(&mut self, extend: bool, font: &fontdue::Font, px: f32, wrap: Option<f32>) {
        self.move_vertical(true, extend, font, px, wrap);
    }

    pub fn move_down(&mut self, extend: bool, font: &fontdue::Font, px: f32, wrap: Option<f32>) {
        self.move_vertical(false, extend, font, px, wrap);
    }

    fn move_vertical(
        &mut self,
        up: bool,
        extend: bool,
        font: &fontdue::Font,
        px: f32,
        wrap: Option<f32>,
    ) {
        if !extend && let Some(range) = self.selection() {
            self.cursor = if up { range.start } else { range.end };
            self.anchor = None;
        }
        let lines = wrap_lines(&self.text, font, px, wrap, &self.marks);
        let line = line_of_offset(&lines, self.cursor);
        let range = &lines[line];
        let x = self.goal_x.unwrap_or_else(|| {
            measure_marked(font, &self.text, range.start..self.cursor, px, &self.marks)
        });
        let target = if up {
            if line == 0 {
                0
            } else {
                nearest_column(&self.text, lines[line - 1].clone(), x, font, px, &self.marks)
            }
        } else if line + 1 >= lines.len() {
            self.text.len()
        } else {
            nearest_column(&self.text, lines[line + 1].clone(), x, font, px, &self.marks)
        };
        self.place(target, extend);
        self.goal_x = Some(x);
    }

    pub fn move_doc_start(&mut self, extend: bool) {
        self.place(0, extend);
    }

    pub fn move_doc_end(&mut self, extend: bool) {
        self.place(self.text.len(), extend);
    }

    pub fn select_all(&mut self) {
        self.anchor = Some(0);
        self.cursor = self.text.len();
        self.goal_x = None;
        self.sealed = true;
    }

    pub fn collapse(&mut self) -> bool {
        let had_selection = self.selection().is_some();
        self.anchor = None;
        self.sealed = true;
        had_selection
    }

    pub fn set_cursor(&mut self, offset: usize, extend: bool) {
        self.place(snap_to_boundary(&self.text, offset), extend);
    }

    pub fn select_word_at(&mut self, offset: usize) {
        let Some(range) = word_range_at(&self.text, offset) else {
            return;
        };
        self.anchor = Some(range.start);
        self.cursor = range.end;
        self.goal_x = None;
        self.sealed = true;
    }

    pub fn select_line_at(&mut self, offset: usize) {
        let range = line_range_at(&self.text, offset);
        self.anchor = Some(range.start);
        self.cursor = range.end;
        self.goal_x = None;
        self.sealed = true;
    }

    fn place(&mut self, target: usize, extend: bool) {
        if extend {
            if self.anchor.is_none() {
                self.anchor = Some(self.cursor);
            }
        } else {
            self.anchor = None;
        }
        self.cursor = target;
        self.goal_x = None;
        self.sealed = true;
    }

    fn left_boundary(&self, granularity: Granularity) -> usize {
        match granularity {
            Granularity::Char => prev_char(&self.text, self.cursor),
            Granularity::Word => prev_word_boundary(&self.text, self.cursor),
            Granularity::Line => line_start(&self.text, self.cursor),
        }
    }

    fn right_boundary(&self, granularity: Granularity) -> usize {
        match granularity {
            Granularity::Char => next_char(&self.text, self.cursor),
            Granularity::Word => next_word_boundary(&self.text, self.cursor),
            Granularity::Line => line_end(&self.text, self.cursor),
        }
    }

    pub fn set_editing(&mut self, tab_text: Option<String>, auto_indent: bool) {
        self.tab_text = tab_text;
        self.auto_indent = auto_indent;
    }

    fn insert_newline(&mut self) {
        if !self.auto_indent {
            self.insert("\n");
            return;
        }
        let at = self.selection().map_or(self.cursor, |r| r.start);
        let start = line_start(&self.text, at);
        let indent: String = self.text[start..at]
            .chars()
            .take_while(|&c| c == ' ' || c == '\t')
            .collect();
        let mut inserted = String::with_capacity(1 + indent.len());
        inserted.push('\n');
        inserted.push_str(&indent);
        self.insert(&inserted);
    }

    // The whole lines covered by the selection (or the caret's line), without
    // the last line when the selection stops exactly at its start.
    fn block_lines(&self) -> Range<usize> {
        let range = self.selection().unwrap_or(self.cursor..self.cursor);
        let start = line_start(&self.text, range.start);
        let last = if range.end > range.start && self.text[..range.end].ends_with('\n') {
            range.end - 1
        } else {
            range.end
        };
        start..line_end(&self.text, last.max(range.start))
    }

    fn indent_block(&mut self, tab: &str) -> bool {
        let range = self.selection().unwrap_or(self.cursor..self.cursor);
        if !self.text[range].contains('\n') {
            self.insert(tab);
            return true;
        }
        let block = self.block_lines();
        let mut out = String::with_capacity(self.text[block.clone()].len() + tab.len() * 8);
        for (i, line) in self.text[block.clone()].split('\n').enumerate() {
            if i > 0 {
                out.push('\n');
            }
            if !line.is_empty() {
                out.push_str(tab);
            }
            out.push_str(line);
        }
        self.splice(block.clone(), &out, EditKind::Other);
        self.anchor = Some(block.start);
        self.sealed = true;
        true
    }

    fn dedent_block(&mut self, tab: &str) -> bool {
        let had_selection = self.selection().is_some();
        let cursor_before = self.cursor;
        let block = self.block_lines();
        let mut out = String::with_capacity(self.text[block.clone()].len());
        let mut first_removed = 0;
        for (i, line) in self.text[block.clone()].split('\n').enumerate() {
            if i > 0 {
                out.push('\n');
            }
            let trimmed = if let Some(rest) = line.strip_prefix(tab) {
                rest
            } else if let Some(rest) = line.strip_prefix('\t') {
                rest
            } else {
                let spaces = line.len() - line.trim_start_matches(' ').len();
                &line[spaces.min(tab.len())..]
            };
            if i == 0 {
                first_removed = line.len() - trimmed.len();
            }
            out.push_str(trimmed);
        }
        if out.len() == block.len() {
            return false;
        }
        self.splice(block.clone(), &out, EditKind::Other);
        if had_selection {
            self.anchor = Some(block.start);
        } else {
            self.cursor = cursor_before
                .saturating_sub(first_removed)
                .max(block.start)
                .min(self.text.len());
        }
        self.sealed = true;
        true
    }

    pub fn replace_all(&mut self, text: &str) {
        if self.text == text {
            return;
        }
        self.sealed = true;
        let end = self.text.len();
        self.splice(0..end, text, EditKind::Other);
        self.sealed = true;
    }

    pub fn apply(&mut self, action: InputAction) -> InputReply {
        match action {
            InputAction::Undo => {
                if self.undo() {
                    InputReply::Edited
                } else {
                    InputReply::None
                }
            }
            InputAction::Redo => {
                if self.redo() {
                    InputReply::Edited
                } else {
                    InputReply::None
                }
            }
            InputAction::Copy => match self.selected_text() {
                Some(text) => InputReply::Copy(text.to_string(), self.selection_marks()),
                None => InputReply::None,
            },
            InputAction::Cut => match self.selected_text().map(str::to_string) {
                Some(text) => {
                    let marks = self.selection_marks();
                    self.delete_selection();
                    InputReply::Cut(text, marks)
                }
                None => InputReply::None,
            },
            InputAction::Paste => InputReply::RequestPaste,
            InputAction::SelectAll => {
                self.select_all();
                InputReply::Selected
            }
        }
    }

    pub fn handle_key(
        &mut self,
        key: KeyEvent,
        font: &fontdue::Font,
        px: f32,
        wrap: Option<f32>,
    ) -> InputReply {
        use Granularity::{Char, Line, Word};
        let m = key.mods;
        let associated = key.text.as_deref();
        let combo = m.ctrl || m.sup;
        let horizontal = if m.alt {
            Word
        } else if m.sup {
            Line
        } else {
            Char
        };
        match key.key {
            Key::Char('a') if m.sup => self.apply(InputAction::SelectAll),
            Key::Char('z') if combo => self.apply(if m.shift {
                InputAction::Redo
            } else {
                InputAction::Undo
            }),
            Key::Char('c') if combo => self.apply(InputAction::Copy),
            Key::Char('x') if combo => self.apply(InputAction::Cut),

            Key::Char('v') if combo => self.apply(InputAction::Paste), // so this gets conerted to request paste
            Key::Left => {
                self.move_left(horizontal, m.shift);
                InputReply::Moved
            }
            Key::Right => {
                self.move_right(horizontal, m.shift);
                InputReply::Moved
            }
            Key::Up if m.sup => {
                self.move_doc_start(m.shift);
                InputReply::Moved
            }
            Key::Down if m.sup => {
                self.move_doc_end(m.shift);
                InputReply::Moved
            }
            Key::Up => {
                self.move_up(m.shift, font, px, wrap);
                InputReply::Moved
            }
            Key::Down => {
                self.move_down(m.shift, font, px, wrap);
                InputReply::Moved
            }
            Key::Home => {
                self.move_left(Line, m.shift);
                InputReply::Moved
            }
            Key::End => {
                self.move_right(Line, m.shift);
                InputReply::Moved
            }
            Key::Backspace => {
                self.delete_backward(horizontal);
                InputReply::Edited
            }
            Key::Delete => {
                self.delete_forward(if m.alt { Word } else { Char });
                InputReply::Edited
            }
            Key::Enter => {
                self.insert_newline();
                InputReply::Edited
            }
            Key::Tab if !m.ctrl && !m.sup && !m.alt => match self.tab_text.clone() {
                Some(tab) if !tab.is_empty() => {
                    let edited = if m.shift {
                        self.dedent_block(&tab)
                    } else {
                        self.indent_block(&tab)
                    };
                    if edited {
                        InputReply::Edited
                    } else {
                        InputReply::None
                    }
                }
                _ => InputReply::None,
            },
            Key::Escape => {
                if self.collapse() {
                    InputReply::Selected
                } else {
                    InputReply::None
                }
            }
            // The Cocoa control keys; also what Ghostty's default keybinds
            // rewrite cmd+left/right/backspace and option+arrows into.
            Key::Char('a') if m.ctrl => {
                self.move_left(Line, m.shift);
                InputReply::Moved
            }
            Key::Char('e') if m.ctrl => {
                self.move_right(Line, m.shift);
                InputReply::Moved
            }
            Key::Char('b') if m.ctrl => {
                self.move_left(Char, m.shift);
                InputReply::Moved
            }
            Key::Char('f') if m.ctrl => {
                self.move_right(Char, m.shift);
                InputReply::Moved
            }
            Key::Char('b') if m.alt => {
                self.move_left(Word, m.shift);
                InputReply::Moved
            }
            Key::Char('f') if m.alt => {
                self.move_right(Word, m.shift);
                InputReply::Moved
            }
            Key::Char('d') if m.ctrl => {
                self.delete_forward(Char);
                InputReply::Edited
            }
            Key::Char('k') if m.ctrl => {
                self.delete_forward(Line);
                InputReply::Edited
            }
            Key::Char('w') if m.ctrl => {
                self.delete_backward(Word);
                InputReply::Edited
            }
            Key::Char('u') if m.ctrl => {
                self.delete_backward(Line);
                InputReply::Edited
            }
            Key::Char(c) if !m.ctrl && !m.sup && !m.alt && !c.is_control() => {
                match associated {
                    Some(text) => self.insert(text),
                    None => self.insert(c.encode_utf8(&mut [0u8; 4])),
                }
                InputReply::Edited
            }
            Key::Unknown if !m.ctrl && !m.sup && !m.alt && associated.is_some() => {
                self.insert(associated.unwrap());
                InputReply::Edited
            }
            _ => InputReply::None,
        }
    }

    pub fn handle_mouse(
        &mut self,
        mouse: &Mouse,
        geometry: InputGeometry,
        fonts: &[fontdue::Font],
    ) -> InputReply {
        let point = (mouse.x as f32, mouse.y as f32);
        match (mouse.kind, mouse.button) {
            (MouseKind::Down, MouseButton::Left) => {
                let offset = geometry.offset_at(&self.text, &self.marks, point, fonts);
                match ClickGesture::from_count(self.clicks.register(point, Instant::now())) {
                    ClickGesture::Place => {
                        self.set_cursor(offset, false);
                        self.selecting = true;
                    }
                    ClickGesture::Word => self.select_word_at(offset),
                    ClickGesture::Line => self.select_line_at(offset),
                }
                InputReply::Selected
            }
            (MouseKind::Move, MouseButton::Left) if self.selecting => {
                let offset = geometry.offset_at(&self.text, &self.marks, point, fonts);
                self.set_cursor(offset, true);
                InputReply::Selected
            }
            (MouseKind::Up, _) => {
                self.selecting = false;
                InputReply::None
            }
            _ => InputReply::None,
        }
    }
}

pub fn line_height(font: &fontdue::Font, px: f32) -> f32 {
    font.horizontal_line_metrics(px)
        .map_or(px, |m| m.new_line_size)
}

pub fn offset_to_point(
    text: &str,
    offset: usize,
    font: &fontdue::Font,
    px: f32,
    wrap: Option<f32>,
    marks: &[Mark],
) -> (f32, f32) {
    let offset = snap_to_boundary(text, offset);
    let lines = wrap_lines(text, font, px, wrap, marks);
    let line = line_of_offset(&lines, offset);
    let start = lines[line].start;
    (
        measure_marked(font, text, start..offset.max(start), px, marks),
        line as f32 * line_height(font, px),
    )
}

pub fn point_to_offset(
    text: &str,
    x: f32,
    y: f32,
    font: &fontdue::Font,
    px: f32,
    wrap: Option<f32>,
    marks: &[Mark],
) -> usize {
    let lines = wrap_lines(text, font, px, wrap, marks);
    let line = ((y / line_height(font, px)).floor().max(0.0) as usize).min(lines.len() - 1);
    nearest_column(text, lines[line].clone(), x, font, px, marks)
}

fn nearest_column(
    text: &str,
    line: Range<usize>,
    x: f32,
    font: &fontdue::Font,
    px: f32,
    marks: &[Mark],
) -> usize {
    let mut pen = 0.0;
    for (i, c) in text[line.clone()].char_indices() {
        let advance = char_advance(font, c, line.start + i, px, marks);
        if x < pen + advance / 2.0 {
            return line.start + i;
        }
        pen += advance;
    }
    line.end
}

#[cfg(test)]
mod tests {
    use super::*;

    static FONT_BYTES: &[u8] =
        include_bytes!("../../../examples/typing/assets/JetBrainsMono-Regular.ttf");

    fn font() -> fontdue::Font {
        fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap()
    }

    fn input(text: &str, cursor: usize) -> TextInput {
        let mut input = TextInput::new(text.into());
        input.set_cursor(cursor, false);
        input
    }

    #[test]
    fn inserts_and_deletes_at_the_cursor() {
        let mut i = input("hello world", 5);
        i.insert(",");
        assert_eq!(i.text(), "hello, world");
        assert_eq!(i.cursor(), 6);
        i.delete_backward(Granularity::Char);
        assert_eq!(i.text(), "hello world");
        assert_eq!(i.cursor(), 5);
        i.delete_forward(Granularity::Char);
        assert_eq!(i.text(), "helloworld");
    }

    #[test]
    fn typing_replaces_the_selection() {
        let mut i = input("hello world", 0);
        i.set_cursor(5, false);
        i.set_cursor(0, true);
        i.insert("goodbye");
        assert_eq!(i.text(), "goodbye world");
        assert_eq!(i.cursor(), 7);
        assert_eq!(i.selection(), None);
    }

    #[test]
    fn backspace_with_selection_deletes_only_the_selection() {
        let mut i = input("hello world", 6);
        i.set_cursor(11, true);
        i.delete_backward(Granularity::Word);
        assert_eq!(i.text(), "hello ");
        assert_eq!(i.cursor(), 6);
    }

    #[test]
    fn word_movement_lands_on_word_edges() {
        let mut i = input("foo bar_baz  qux", 16);
        i.move_left(Granularity::Word, false);
        assert_eq!(i.cursor(), 13, "start of qux");
        i.move_left(Granularity::Word, false);
        assert_eq!(i.cursor(), 4, "start of bar_baz");
        i.move_right(Granularity::Word, false);
        assert_eq!(i.cursor(), 11, "end of bar_baz");
        i.move_right(Granularity::Word, false);
        assert_eq!(i.cursor(), 16, "end of qux");
    }

    #[test]
    fn word_movement_crosses_newlines() {
        let mut i = input("one\ntwo", 4);
        i.move_left(Granularity::Word, false);
        assert_eq!(i.cursor(), 0);
        i.move_right(Granularity::Word, false);
        assert_eq!(i.cursor(), 3);
    }

    #[test]
    fn line_movement_uses_the_current_line() {
        let mut i = input("first\nsecond line\nthird", 10);
        i.move_left(Granularity::Line, false);
        assert_eq!(i.cursor(), 6);
        i.move_right(Granularity::Line, false);
        assert_eq!(i.cursor(), 17);
    }

    #[test]
    fn delete_backward_word_and_line() {
        let mut i = input("one two three", 13);
        i.delete_backward(Granularity::Word);
        assert_eq!(i.text(), "one two ");
        i.delete_backward(Granularity::Line);
        assert_eq!(i.text(), "");
    }

    #[test]
    fn shift_extends_and_plain_arrows_collapse() {
        let mut i = input("abcdef", 2);
        i.move_right(Granularity::Char, true);
        i.move_right(Granularity::Char, true);
        assert_eq!(i.selection(), Some(2..4));
        assert_eq!(i.selected_text(), Some("cd"));

        i.move_left(Granularity::Char, false);
        assert_eq!(i.selection(), None);
        assert_eq!(i.cursor(), 2, "left collapses to selection start");

        i.move_right(Granularity::Char, true);
        i.move_right(Granularity::Char, false);
        assert_eq!(i.cursor(), 3, "right collapses to selection end");
    }

    #[test]
    fn shrinking_a_selection_back_to_the_anchor_empties_it() {
        let mut i = input("abc", 1);
        i.move_right(Granularity::Char, true);
        assert_eq!(i.selection(), Some(1..2));
        i.move_left(Granularity::Char, true);
        assert_eq!(i.selection(), None);
    }

    #[test]
    fn vertical_movement_keeps_the_goal_column() {
        let f = font();
        let mut i = input("a long first line\nab\nanother long line", 12);
        i.move_down(false, &f, 16.0, None);
        assert_eq!(i.cursor(), 20, "short line clamps to its end");
        i.move_down(false, &f, 16.0, None);
        let (x, _) = offset_to_point(i.text(), i.cursor(), &f, 16.0, None, &[]);
        let (goal_x, _) = offset_to_point("a long first line", 12, &f, 16.0, None, &[]);
        assert!(
            (x - goal_x).abs() < 1.0,
            "goal column restored: {x} vs {goal_x}"
        );
        i.move_up(false, &f, 16.0, None);
        i.move_up(false, &f, 16.0, None);
        assert_eq!(i.cursor(), 12, "round trip returns home");
    }

    #[test]
    fn vertical_movement_at_the_edges_goes_to_doc_ends() {
        let f = font();
        let mut i = input("one\ntwo", 1);
        i.move_up(false, &f, 16.0, None);
        assert_eq!(i.cursor(), 0);
        i.set_cursor(5, false);
        i.move_down(false, &f, 16.0, None);
        assert_eq!(i.cursor(), 7);
    }

    #[test]
    fn vertical_movement_with_selection_collapses_then_moves() {
        let f = font();
        let mut i = input("one\ntwo\nthree", 5);
        i.set_cursor(2, true);
        assert_eq!(i.selection(), Some(2..5));
        i.move_down(false, &f, 16.0, None);
        assert_eq!(i.selection(), None);
        assert!(i.cursor() > 7, "moved below the selection end line");
    }

    #[test]
    fn select_all_and_collapse() {
        let mut i = input("hello", 2);
        i.select_all();
        assert_eq!(i.selected_text(), Some("hello"));
        assert!(i.collapse());
        assert_eq!(i.selection(), None);
        assert_eq!(i.cursor(), 5);
    }

    #[test]
    fn double_click_selects_the_word_under_the_point() {
        let mut i = input("foo bar baz", 0);
        i.select_word_at(5);
        assert_eq!(i.selected_text(), Some("bar"));
        i.select_word_at(7);
        assert_eq!(
            i.selected_text(),
            Some("bar"),
            "boundary prefers the word left of it"
        );
        i.select_word_at(3);
        assert_eq!(i.selected_text(), Some("foo"));
    }

    #[test]
    fn triple_click_selects_the_line_with_its_newline() {
        let mut i = input("one\ntwo\nthree", 0);
        i.select_line_at(5);
        assert_eq!(i.selected_text(), Some("two\n"));
        i.select_line_at(10);
        assert_eq!(i.selected_text(), Some("three"), "last line has no newline");
    }

    #[test]
    fn handles_multibyte_chars() {
        let mut i = input("héllo", 0);
        i.move_right(Granularity::Char, false);
        i.move_right(Granularity::Char, false);
        assert_eq!(i.cursor(), 3, "é is two bytes");
        i.delete_backward(Granularity::Char);
        assert_eq!(i.text(), "hllo");
        i.set_cursor(2, false);
        assert_eq!(i.cursor(), 2);
    }

    #[test]
    fn typing_runs_undo_as_one_step_and_redo_restores_them() {
        let mut i = input("", 0);
        for c in ["h", "e", "y"] {
            i.insert(c);
        }
        assert!(i.undo());
        assert_eq!(i.text(), "", "a typing run is one undo step");
        assert_eq!(i.cursor(), 0);
        assert!(!i.undo(), "history is exhausted");
        assert!(i.redo());
        assert_eq!(i.text(), "hey");
        assert_eq!(i.cursor(), 3);
    }

    #[test]
    fn cursor_movement_seals_the_typing_group() {
        let mut i = input("", 0);
        i.insert("a");
        i.insert("b");
        i.move_left(Granularity::Char, false);
        i.move_right(Granularity::Char, false);
        i.insert("c");
        assert_eq!(i.text(), "abc");
        i.undo();
        assert_eq!(i.text(), "ab", "moving broke the group despite adjacency");
        i.undo();
        assert_eq!(i.text(), "");
    }

    #[test]
    fn enter_and_paste_are_their_own_steps() {
        let mut i = input("", 0);
        i.insert("a");
        i.insert("\n");
        i.insert("pasted text");
        i.undo();
        assert_eq!(i.text(), "a\n");
        i.undo();
        assert_eq!(i.text(), "a");
        i.undo();
        assert_eq!(i.text(), "");
    }

    #[test]
    fn backspace_runs_coalesce() {
        let mut i = input("hello", 5);
        i.delete_backward(Granularity::Char);
        i.delete_backward(Granularity::Char);
        i.delete_backward(Granularity::Char);
        assert_eq!(i.text(), "he");
        assert!(i.undo());
        assert_eq!(i.text(), "hello", "the whole run comes back at once");
        assert_eq!(i.cursor(), 5);
    }

    #[test]
    fn undo_restores_the_selection_that_was_replaced() {
        let mut i = input("hello world", 0);
        i.set_cursor(5, false);
        i.set_cursor(0, true);
        i.insert("goodbye");
        assert_eq!(i.text(), "goodbye world");
        assert!(i.undo());
        assert_eq!(i.text(), "hello world");
        assert_eq!(i.selection(), Some(0..5), "selection comes back with undo");
        assert!(i.redo());
        assert_eq!(i.text(), "goodbye world");
        assert_eq!(i.cursor(), 7);
        assert_eq!(i.selection(), None);
    }

    #[test]
    fn word_delete_is_a_single_separate_step() {
        let mut i = input("one two", 7);
        i.delete_backward(Granularity::Word);
        i.delete_backward(Granularity::Word);
        assert_eq!(i.text(), "");
        i.undo();
        assert_eq!(i.text(), "one ");
        i.undo();
        assert_eq!(i.text(), "one two");
    }

    #[test]
    fn new_edits_clear_the_redo_stack() {
        let mut i = input("", 0);
        i.insert("a");
        i.undo();
        assert!(i.can_redo());
        i.insert("b");
        assert!(!i.can_redo(), "diverging kills the redo branch");
        assert_eq!(i.text(), "b");
    }

    #[test]
    fn undo_then_typing_then_undo_round_trips() {
        let mut i = input("base", 4);
        i.insert(" one");
        i.undo();
        i.insert(" two");
        assert_eq!(i.text(), "base two");
        i.undo();
        assert_eq!(i.text(), "base");
        assert!(
            !i.can_undo() || {
                i.undo();
                i.text() == "base"
            }
        );
    }

    #[test]
    fn marks_insert_as_one_char_and_track_position() {
        let mut i = input("hello ", 6);
        i.insert_mark(1, None);
        assert_eq!(i.text(), format!("hello {MARK_CHAR}"));
        assert_eq!(i.marks().len(), 1);
        assert_eq!(i.marks()[0].offset, 6);
        assert_eq!(i.marks()[0].id, 1);
        assert_eq!(i.cursor(), 6 + MARK_CHAR.len_utf8());

        i.set_cursor(0, false);
        i.insert("x");
        assert_eq!(i.marks()[0].offset, 7, "typing before shifts the mark");
        i.move_doc_end(false);
        i.insert("y");
        assert_eq!(i.marks()[0].offset, 7, "typing after leaves it");
    }

    #[test]
    fn cursor_and_backspace_treat_the_mark_as_a_unit() {
        let mut i = input("ab", 2);
        i.insert_mark(1, None);
        i.insert("cd");
        i.move_left(Granularity::Char, false);
        i.move_left(Granularity::Char, false);
        i.move_left(Granularity::Char, false);
        assert_eq!(i.cursor(), 2, "one left arrow crosses the whole mark");
        i.move_right(Granularity::Char, false);
        assert_eq!(i.cursor(), 2 + MARK_CHAR.len_utf8());
        i.delete_backward(Granularity::Char);
        assert_eq!(i.text(), "abcd");
        assert!(i.marks().is_empty(), "deleting the char drops the mark");
    }

    #[test]
    fn undo_restores_deleted_marks_and_redo_removes_them_again() {
        let mut i = input("", 0);
        i.insert_mark(7, None);
        i.set_mark_advance(7, 24.0);
        i.delete_backward(Granularity::Char);
        assert!(i.marks().is_empty());
        assert!(i.undo());
        assert_eq!(i.marks().len(), 1, "undo restores the mark");
        assert_eq!(i.marks()[0].id, 7);
        assert_eq!(i.marks()[0].advance, 24.0, "the advance survives undo");
        assert!(i.redo());
        assert!(i.marks().is_empty());
        assert!(i.undo());
        assert!(i.undo(), "undoing the insert removes the mark");
        assert_eq!(i.text(), "");
        assert!(i.marks().is_empty());
        assert!(i.redo());
        assert_eq!(i.marks().len(), 1, "redoing the insert brings it back");
    }

    #[test]
    fn replacing_a_selection_across_a_mark_drops_it() {
        let mut i = input("one ", 4);
        i.insert_mark(1, None);
        i.insert(" two");
        i.select_all();
        i.insert("clean");
        assert_eq!(i.text(), "clean");
        assert!(i.marks().is_empty());
        i.undo();
        assert_eq!(i.marks().len(), 1, "undo of the replace restores it");
        assert_eq!(i.marks()[0].offset, 4);
    }

    #[test]
    fn backspace_runs_across_marks_restore_in_one_undo() {
        let mut i = input("", 0);
        i.insert("ab");
        i.insert_mark(1, None);
        i.set_cursor(i.text().len(), false);
        i.delete_backward(Granularity::Char);
        i.delete_backward(Granularity::Char);
        i.delete_backward(Granularity::Char);
        assert_eq!(i.text(), "");
        assert!(i.marks().is_empty());
        i.undo();
        assert_eq!(i.text(), format!("ab{MARK_CHAR}"));
        assert_eq!(i.marks().len(), 1);
        assert_eq!(i.marks()[0].offset, 2);
    }

    #[test]
    fn pasted_text_cannot_forge_mark_placeholders() {
        let mut i = input("", 0);
        i.insert(&format!("a{MARK_CHAR}b"));
        assert_eq!(i.text(), "ab");
        assert!(i.marks().is_empty());
    }

    #[test]
    fn mark_advance_flows_through_measurement() {
        let f = font();
        let mut i = input("ab", 1);
        i.insert_mark(1, None);
        assert!(i.set_mark_advance(1, 40.0));
        assert!(!i.set_mark_advance(1, 40.0), "unchanged advance reports false");
        let with = measure_marked(&f, i.text(), 0..i.text().len(), 16.0, i.marks());
        let without = measure_marked(&f, "ab", 0..2, 16.0, &[]);
        assert!((with - without - 40.0).abs() < 0.01);
        let (x, _) = offset_to_point(
            i.text(),
            1 + MARK_CHAR.len_utf8(),
            &f,
            16.0,
            None,
            i.marks(),
        );
        let a_w = measure_marked(&f, "a", 0..1, 16.0, &[]);
        assert!(
            (x - a_w - 40.0).abs() < 0.01,
            "caret after the mark sits past the widget"
        );
    }

    #[test]
    fn tab_inserts_and_indents_multiline_selections() {
        let f = font();
        let mut i = input("one\ntwo\nthree", 0);
        i.set_editing(Some("  ".into()), false);
        assert_eq!(
            i.handle_key(key(Key::Tab, Mods::default()), &f, 16.0, None),
            InputReply::Edited
        );
        assert_eq!(i.text(), "  one\ntwo\nthree", "caret tab inserts");
        assert_eq!(i.cursor(), 2);

        i.set_cursor(2, false);
        i.set_cursor(8, true);
        i.handle_key(key(Key::Tab, Mods::default()), &f, 16.0, None);
        assert_eq!(i.text(), "    one\n  two\nthree", "selection indents lines");
        assert_eq!(i.selected_text(), Some("    one\n  two"));
        assert!(i.undo());
        assert_eq!(i.text(), "  one\ntwo\nthree", "indent is one undo step");
    }

    #[test]
    fn shift_tab_dedents_and_reports_noop() {
        const SHIFT: Mods = Mods {
            shift: true,
            alt: false,
            ctrl: false,
            sup: false,
        };
        let f = font();
        let mut i = input("    one\n\ttwo\n three\nfour", 0);
        i.set_editing(Some("  ".into()), false);
        i.select_all();
        assert_eq!(
            i.handle_key(key(Key::Tab, SHIFT), &f, 16.0, None),
            InputReply::Edited
        );
        assert_eq!(i.text(), "  one\ntwo\nthree\nfour");
        i.collapse();
        i.set_cursor(0, false);
        i.handle_key(key(Key::Tab, SHIFT), &f, 16.0, None);
        i.handle_key(key(Key::Tab, SHIFT), &f, 16.0, None);
        assert_eq!(i.text(), "one\ntwo\nthree\nfour");
        assert_eq!(
            i.handle_key(key(Key::Tab, SHIFT), &f, 16.0, None),
            InputReply::None,
            "nothing left to dedent"
        );
    }

    #[test]
    fn dedent_keeps_the_caret_on_its_column() {
        let f = font();
        let mut i = input("  hello", 5);
        i.set_editing(Some("  ".into()), false);
        const SHIFT: Mods = Mods {
            shift: true,
            alt: false,
            ctrl: false,
            sup: false,
        };
        i.handle_key(key(Key::Tab, SHIFT), &f, 16.0, None);
        assert_eq!(i.text(), "hello");
        assert_eq!(i.cursor(), 3, "caret shifts left with the line");
    }

    #[test]
    fn tab_without_tab_text_is_ignored() {
        let f = font();
        let mut i = input("abc", 1);
        assert_eq!(
            i.handle_key(key(Key::Tab, Mods::default()), &f, 16.0, None),
            InputReply::None
        );
        assert_eq!(i.text(), "abc");
    }

    #[test]
    fn enter_copies_leading_whitespace_when_auto_indent_is_on() {
        let f = font();
        let mut i = input("  foo", 5);
        i.set_editing(None, true);
        i.handle_key(key(Key::Enter, Mods::default()), &f, 16.0, None);
        assert_eq!(i.text(), "  foo\n  ");
        assert_eq!(i.cursor(), 8);
        let mut plain = input("  foo", 5);
        plain.handle_key(key(Key::Enter, Mods::default()), &f, 16.0, None);
        assert_eq!(plain.text(), "  foo\n", "off by default");
    }

    use crate::terminal::Mods;

    fn key(k: Key, mods: Mods) -> KeyEvent {
        KeyEvent {
            key: k,
            mods,
            kind: crate::terminal::KeyKind::Press,
            text: None,
        }
    }

    const CTRL: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: true,
        sup: false,
    };
    const SUPER: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: false,
        sup: true,
    };

    #[test]
    fn keys_drive_the_input_like_a_text_field() {
        let f = font();
        let mut i = input("one two", 7);
        assert_eq!(
            i.handle_key(key(Key::Char('a'), CTRL), &f, 16.0, None),
            InputReply::Moved
        );
        assert_eq!(i.cursor(), 0, "ctrl-a is line start, not select all");
        assert_eq!(
            i.handle_key(key(Key::Char('x'), CTRL), &f, 16.0, None),
            InputReply::None,
            "cut without a selection does nothing"
        );
        assert_eq!(
            i.handle_key(key(Key::Char('a'), SUPER), &f, 16.0, None),
            InputReply::Selected
        );
        assert_eq!(
            i.handle_key(key(Key::Char('c'), SUPER), &f, 16.0, None),
            InputReply::Copy("one two".into(), Vec::new())
        );
        assert_eq!(
            i.handle_key(key(Key::Char('x'), SUPER), &f, 16.0, None),
            InputReply::Cut("one two".into(), Vec::new())
        );
        assert_eq!(i.text(), "");
        assert_eq!(
            i.handle_key(key(Key::Char('z'), SUPER), &f, 16.0, None),
            InputReply::Edited
        );
        assert_eq!(i.text(), "one two");
        assert_eq!(
            i.handle_key(key(Key::Char('v'), CTRL), &f, 16.0, None),
            InputReply::RequestPaste
        );
        assert_eq!(
            i.handle_key(key(Key::Char('!'), Mods::default()), &f, 16.0, None),
            InputReply::Edited
        );
    }

    #[test]
    fn mouse_places_selects_and_drags() {
        let fonts = [font()];
        let geometry = InputGeometry {
            origin: (10.0, 5.0),
            font: 0,
            px: 16.0,
            max_width: None,
        };
        let text = "hello world";
        let mut i = input(text, 0);
        let event = |kind, button, offset: usize| {
            let (x, y) = offset_to_point(text, offset, &fonts[0], 16.0, None, &[]);
            Mouse {
                kind,
                button,
                mods: Mods::default(),
                x: (10.0 + x + 0.5) as u32,
                y: (5.0 + y + 1.0) as u32,
            }
        };

        let reply = i.handle_mouse(
            &event(MouseKind::Down, MouseButton::Left, 8),
            geometry,
            &fonts,
        );
        assert_eq!(reply, InputReply::Selected);
        assert_eq!(i.cursor(), 8, "click lands the caret at the point");

        i.handle_mouse(
            &event(MouseKind::Move, MouseButton::Left, 2),
            geometry,
            &fonts,
        );
        assert_eq!(i.selection(), Some(2..8), "dragging extends");

        i.handle_mouse(
            &event(MouseKind::Up, MouseButton::Left, 2),
            geometry,
            &fonts,
        );
        let reply = i.handle_mouse(
            &event(MouseKind::Move, MouseButton::Left, 5),
            geometry,
            &fonts,
        );
        assert_eq!(reply, InputReply::None, "no drag after release");
        assert_eq!(i.selection(), Some(2..8));

        // A second down at the first click's point within the chain window
        // is a double click: the word under it gets selected.
        i.handle_mouse(
            &event(MouseKind::Down, MouseButton::Left, 8),
            geometry,
            &fonts,
        );
        assert_eq!(i.selected_text(), Some("world"));
        i.handle_mouse(
            &event(MouseKind::Down, MouseButton::Left, 8),
            geometry,
            &fonts,
        );
        assert_eq!(
            i.selected_text(),
            Some("hello world"),
            "third click takes the line"
        );
    }

    #[test]
    fn caret_rect_sits_at_the_offset() {
        let fonts = [font()];
        let geometry = InputGeometry {
            origin: (10.0, 5.0),
            font: 0,
            px: 16.0,
            max_width: None,
        };
        let rect = geometry.caret_rect("ab\ncd", &[], 4, &fonts);
        let (x, y) = offset_to_point("ab\ncd", 4, &fonts[0], 16.0, None, &[]);
        assert_eq!((rect.x, rect.y), (10.0 + x, 5.0 + y));
        assert!(rect.h > 0.0 && rect.w > 0.0);
    }

    #[test]
    fn point_offset_mapping_round_trips() {
        let f = font();
        let text = "first line\nsecond\n\nlast";
        for offset in [0, 5, 10, 11, 17, 18, 19, 23] {
            let (x, y) = offset_to_point(text, offset, &f, 16.0, None, &[]);
            assert_eq!(
                point_to_offset(text, x + 0.1, y + 1.0, &f, 16.0, None, &[]),
                offset,
                "offset {offset}"
            );
        }
    }

    #[test]
    fn points_outside_the_text_clamp() {
        let f = font();
        let text = "short\nlonger line";
        assert_eq!(point_to_offset(text, -5.0, -10.0, &f, 16.0, None, &[]), 0);
        assert_eq!(
            point_to_offset(text, 10_000.0, 0.0, &f, 16.0, None, &[]),
            5,
            "past line end"
        );
        assert_eq!(
            point_to_offset(text, 10_000.0, 10_000.0, &f, 16.0, None, &[]),
            text.len(),
            "below the last line"
        );
    }

    #[test]
    fn click_right_of_a_glyphs_midpoint_lands_after_it() {
        let f = font();
        let w = measure_marked(&f, "a", 0..1, 16.0, &[]);
        assert_eq!(point_to_offset("abc", w * 0.4, 0.0, &f, 16.0, None, &[]), 0);
        assert_eq!(point_to_offset("abc", w * 0.6, 0.0, &f, 16.0, None, &[]), 1);
    }

    #[test]
    fn with_marks_claims_sentinels_and_strips_strays() {
        let text = format!("a{m}b{m}c", m = MARK_CHAR);
        // Claim only the first sentinel (offset 1); the second is a stray.
        let input = TextInput::with_marks(text, &[(7, 1), (9, 99)]);
        assert_eq!(input.text(), format!("a{}bc", MARK_CHAR));
        assert_eq!(input.marks().len(), 1);
        assert_eq!((input.marks()[0].id, input.marks()[0].offset), (7, 1));
    }

    #[test]
    fn insert_mark_at_offset_and_remove_round_trip() {
        let mut input = TextInput::new("hello".into());
        input.insert_mark(1, Some(2));
        assert_eq!(input.text(), format!("he{}llo", MARK_CHAR));
        assert_eq!(input.marks()[0].offset, 2);
        // Duplicate ids are ignored.
        input.insert_mark(1, Some(0));
        assert_eq!(input.marks().len(), 1);
        input.remove_mark(1);
        assert_eq!(input.text(), "hello");
        assert!(input.marks().is_empty());
        // Offsets clamp to the text.
        input.insert_mark(2, Some(999));
        assert_eq!(input.marks()[0].offset, 5);
    }

    #[test]
    fn selection_marks_rebase_and_cut_carries_them() {
        let mut input = TextInput::new("hello".into());
        input.insert_mark(7, Some(2));
        input.set_cursor(1, false);
        input.set_cursor(5, true); // select "e␟ll" covering the sentinel
        let marks = input.selection_marks();
        assert_eq!(marks.len(), 1);
        assert_eq!((marks[0].id, marks[0].offset), (7, 1));
    }

    #[test]
    fn insert_rich_registers_marks_with_data() {
        let mut input = TextInput::new("xy".into());
        input.set_cursor(1, false);
        let text = format!("a{m}b{m}c", m = MARK_CHAR);
        input.insert_rich(&text, &[(1, "one".into()), (5, "two".into())], 1 << 48);
        assert_eq!(input.text(), format!("xa{m}b{m}cy", m = MARK_CHAR));
        let marks = input.marks();
        assert_eq!(marks.len(), 2);
        assert_eq!(marks[0].id, 1 << 48);
        assert_eq!(marks[0].offset, 2);
        assert_eq!(marks[0].data.as_deref(), Some("one"));
        assert_eq!(marks[1].id, (1 << 48) + 1);
        assert_eq!(marks[1].data.as_deref(), Some("two"));
    }
}

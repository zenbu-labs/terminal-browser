use std::io;

use super::{ChangeSource, Engine, EngineEvent, MarkRef};
use crate::logging;
use crate::terminal::Mouse;
use crate::text_input::{InputAction, InputReply};
use crate::tree::{NodeId, PxRect};

impl Engine {
    pub fn splice_input(&mut self, view: usize, id: NodeId, start: usize, end: usize, text: &str) {
        fn char_floor(text: &str, mut at: usize) -> usize {
            while at > 0 && !text.is_char_boundary(at) {
                at -= 1;
            }
            at
        }
        {
            let Some(input) = self.comp.views[view].tree.input_mut(id) else {
                return;
            };
            let len = input.text().len();
            let start = char_floor(input.text(), start.min(len));
            let end = char_floor(input.text(), end.min(len)).max(start);
            input.set_cursor(start, false);
            if end > start {
                input.set_cursor(end, true);
            }
            input.insert(text);
        }
        self.comp.views[view].tree.sync_input_text(id);
        self.reveal = true;
        let mut events = Vec::new();
        self.push_change(view, id, ChangeSource::Edit, &mut events);
        self.pending.append(&mut events);
    }

    pub fn select_all_input(&mut self, view: usize, id: NodeId) {
        let Some(input) = self.comp.views[view].tree.input_mut(id) else {
            return;
        };
        input.select_all();
        self.comp.views[view].tree.mark_paint();
        let mut events = Vec::new();
        self.push_caret(view, id, &mut events);
        self.pending.append(&mut events);
    }

    pub fn apply_input_action(
        &mut self,
        action: InputAction,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let Some((view, focus)) = self.focused() else {
            return self.apply_doc_action(action);
        };
        let Some(input) = self.comp.views[view].tree.input_mut(focus) else {
            return Ok(());
        };
        let reply = input.apply(action);
        if reply == InputReply::None {
            return self.apply_doc_action(action);
        }
        self.finish_reply(view, focus, reply, ChangeSource::Edit, out)
    }

    pub(super) fn forward_mouse(
        &mut self,
        view: usize,
        id: NodeId,
        mouse: &Mouse,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let Some(geometry) = self.comp.views[view].tree.input_geometry(id) else {
            return Ok(());
        };
        let fonts = &self.fonts;
        let Some(input) = self.comp.views[view].tree.input_mut(id) else {
            return Ok(());
        };
        let reply = input.handle_mouse(mouse, geometry, fonts);
        if reply != InputReply::None {
            self.finish_reply(view, id, reply, ChangeSource::Edit, out)?;
        }
        Ok(())
    }

    pub(super) fn finish_reply(
        &mut self,
        view: usize,
        id: NodeId,
        reply: InputReply,
        source: ChangeSource,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        match reply {
            InputReply::None => {}
            InputReply::Selected => {
                self.reveal = true;
                self.comp.views[view].tree.mark_paint();
                self.push_caret(view, id, out);
            }
            InputReply::Moved => {
                self.reveal = true;
                self.comp.views[view].tree.mark_paint();
                self.push_caret(view, id, out);
            }
            InputReply::Edited => {
                self.comp.views[view].tree.sync_input_text(id);
                self.reveal = true;
                self.push_change(view, id, source, out);
            }
            InputReply::Copy(text, marks) => {
                let marks = marks.iter().map(|m| (id, m.clone())).collect();
                self.begin_rich_capture(view, text, marks)?;
            }
            InputReply::Cut(text, marks) => {
                let marks = marks.iter().map(|m| (id, m.clone())).collect();
                self.begin_rich_capture(view, text, marks)?;
                self.comp.views[view].tree.sync_input_text(id);
                self.reveal = true;
                self.push_change(view, id, source, out);
            }
            InputReply::RequestPaste => {
                self.clipboard.request_paste(view, id);
            }
        }
        Ok(())
    }

    pub(super) fn push_paste_image(
        &mut self,
        view: usize,
        id: NodeId,
        image: crate::clipboard_image::PastedImage,
        out: &mut Vec<EngineEvent>,
    ) {
        logging::info(
            "engine",
            format!("paste image {}x{} {}", image.width, image.height, image.path),
        );
        out.push(EngineEvent::PasteImage {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            path: image.path,
            width: image.width,
            height: image.height,
            source: image.source,
        });
    }

    pub fn insert_input_mark(&mut self, view: usize, id: NodeId, mark: u64, offset: Option<usize>) {
        {
            let Some(input) = self.comp.views[view].tree.input_mut(id) else {
                return;
            };
            input.insert_mark(mark, offset);
        }
        self.comp.views[view].tree.sync_input_text(id);
        self.reveal = true;
        let mut events = Vec::new();
        self.push_change(view, id, ChangeSource::Edit, &mut events);
        self.pending.append(&mut events);
    }

    pub fn remove_input_mark(&mut self, view: usize, id: NodeId, mark: u64) {
        {
            let Some(input) = self.comp.views[view].tree.input_mut(id) else {
                return;
            };
            input.remove_mark(mark);
        }
        self.comp.views[view].tree.sync_input_text(id);
        let mut events = Vec::new();
        self.push_change(view, id, ChangeSource::Edit, &mut events);
        self.pending.append(&mut events);
    }

    fn input_marks(&self, view: usize, id: NodeId) -> Vec<MarkRef> {
        self.comp.views[view].tree.input(id).map_or(Vec::new(), |input| {
            input
                .marks()
                .iter()
                .map(|m| MarkRef {
                    id: m.id,
                    offset: m.offset,
                    data: m.data.clone(),
                })
                .collect()
        })
    }

    pub(super) fn submit_input(
        &mut self,
        view: usize,
        id: NodeId,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let text = self.comp.views[view]
            .tree
            .input_text(id)
            .unwrap_or_default()
            .to_string();
        out.push(EngineEvent::Submit {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            text,
            marks: self.input_marks(view, id),
        });
        self.comp.views[view]
            .tree
            .edit_input(id, |input| input.replace_all(""));
        self.finish_reply(view, id, InputReply::Edited, ChangeSource::Edit, out)
    }

    fn push_change(
        &mut self,
        view: usize,
        id: NodeId,
        source: ChangeSource,
        out: &mut Vec<EngineEvent>,
    ) {
        let Some((cursor, caret)) = self.caret_state(view, id) else {
            return;
        };
        let Some(text) = self.comp.views[view].tree.input_text(id) else {
            return;
        };
        let text = text.to_string();
        out.push(EngineEvent::Change {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            text,
            marks: self.input_marks(view, id),
            cursor,
            caret,
            source,
        });
    }

    fn push_caret(&mut self, view: usize, id: NodeId, out: &mut Vec<EngineEvent>) {
        let Some((cursor, caret)) = self.caret_state(view, id) else {
            return;
        };
        out.push(EngineEvent::Caret {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            cursor,
            caret,
        });
    }

    fn caret_state(&mut self, view: usize, id: NodeId) -> Option<(usize, PxRect)> {
        let fonts = &self.fonts;
        let base_px = self.base_px;
        self.comp.views[view].tree.flush_layout(fonts, base_px);
        let tree = &self.comp.views[view].tree;
        let geometry = tree.input_geometry(id)?;
        let input = tree.input(id)?;
        let cursor = input.cursor();
        Some((
            cursor,
            geometry.caret_rect(input.text(), input.marks(), cursor, fonts),
        ))
    }

    pub(super) fn reveal_caret(&mut self) {
        let Some((view, focus)) = self.focused() else {
            return;
        };
        let fonts = &self.fonts;
        let base_px = self.base_px;
        self.comp.views[view].tree.flush_layout(fonts, base_px);
        self.reveal_caret_x(view, focus);
        self.reveal_caret_y(view, focus);
    }

    fn reveal_caret_x(&mut self, view: usize, focus: NodeId) {
        let fonts = &self.fonts;
        let tree = &self.comp.views[view].tree;
        let Some(geometry) = tree.input_geometry(focus) else {
            return;
        };
        if geometry.max_width.is_some() {
            return;
        }
        let Some(width) = tree.content_width(focus) else {
            return;
        };
        let Some(input) = tree.input(focus) else {
            return;
        };
        let font = &fonts[geometry.font.min(fonts.len() - 1)];
        let px = geometry.px;
        let text = input.text();
        let marks = input.marks();
        let current = input.scroll_x();
        let widest = crate::wrap::wrap_lines(text, font, px, None, marks)
            .into_iter()
            .map(|line| crate::canvas::measure_marked(font, text, line, px, marks))
            .fold(0.0f32, f32::max);
        let max_scroll = (widest + crate::text_input::caret_width(px) - width).max(0.0);
        let full_selection = input
            .selection()
            .is_some_and(|range| range.start == 0 && range.end == text.len());
        let target = if full_selection {
            0.0
        } else {
            let (caret_x, _) = crate::text_input::offset_to_point(
                text,
                input.cursor(),
                font,
                px,
                None,
                marks,
            );
            let caret_w = crate::text_input::caret_width(px);
            let mut next = current;
            if caret_x + caret_w - next > width {
                next = caret_x + caret_w - width;
            }
            if caret_x < next {
                next = caret_x;
            }
            next
        };
        let target = target.clamp(0.0, max_scroll);
        if target != current {
            let tree = &mut self.comp.views[view].tree;
            if let Some(input) = tree.input_mut(focus) {
                input.set_scroll_x(target);
                tree.mark_paint();
            }
        }
    }

    fn reveal_caret_y(&mut self, view: usize, focus: NodeId) {
        let tree = &self.comp.views[view].tree;
        let Some(scroller) = tree.parent(focus).and_then(|p| tree.scroll_parent(p)) else {
            return;
        };
        let Some(area) = tree.scroll_area(scroller) else {
            return;
        };
        let Some(geometry) = tree.input_geometry(focus) else {
            return;
        };
        let Some(input) = tree.input(focus) else {
            return;
        };
        let text = input.text().to_string();
        let marks = input.marks().to_vec();
        let cursor = input.cursor();
        let Some(px) = tree.resolved_px(focus) else {
            return;
        };
        let caret = geometry.caret_rect(&text, &marks, cursor, &self.fonts);
        let margin = px * 1.1;
        let current = tree.scroll_state(scroller).map_or(0.0, |s| s.target);
        if let Some(target) = area.target_to_reveal(caret, current, margin)
            && let Some(state) = self.comp.views[view].tree.scroll_state_mut(scroller)
        {
            state.set_target(target);
        }
    }
}

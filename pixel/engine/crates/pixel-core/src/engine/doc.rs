use std::io;

use super::pointer::DragTarget;
use super::{Engine, EngineEvent};
use crate::selection::DocSelection;
use crate::terminal::KeyEvent;
use crate::text_input::{Granularity, InputAction};
use crate::tree::{NodeId, PxRect};

impl Engine {
    pub(super) fn apply_doc_action(&mut self, action: InputAction) -> io::Result<()> {
        let view = self.active_view;
        match action {
            InputAction::Copy => {
                if let Some(text) = self.comp.views[view].tree.doc_selected_text() {
                    self.term.set_clipboard(&text)?;
                }
            }
            InputAction::SelectAll => {
                self.comp.views[view].tree.doc_select_all();
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn emit_selection_change(&mut self, out: &mut Vec<EngineEvent>) {
        let mut current: Option<(usize, NodeId, DocSelection, u32)> = None;
        for view in 0..self.comp.views.len() {
            let tree = &self.comp.views[view].tree;
            let Some(sel) = tree.doc_selection() else {
                continue;
            };
            if sel.is_collapsed() {
                continue;
            }
            let Some(scope) = tree.doc_scope() else {
                continue;
            };
            let scroll = tree.scroll_state(scope).map_or(0, |s| s.position.to_bits());
            current = Some((view, scope, sel, scroll));
            break;
        }
        let sig = current
            .as_ref()
            .map(|&(view, scope, sel, scroll)| (view, scope, sel.anchor, sel.focus, scroll));
        if sig == self.last_selection {
            return;
        }
        if let Some((view, container, ..)) = self.last_selection
            && current.map(|c| (c.0, c.1)) != Some((view, container))
            && view < self.comp.views.len()
            && self.comp.views[view].tree.selection_events(container)
        {
            out.push(EngineEvent::Selection {
                view,
                node: container,
                key: self.comp.views[view]
                    .tree
                    .key_of(container)
                    .map(str::to_string),
                text: String::new(),
                rect: PxRect::ZERO,
                parts: Vec::new(),
            });
        }
        self.last_selection = sig;
        let Some((view, scope, ..)) = current else {
            return;
        };
        let tree = &self.comp.views[view].tree;
        if !tree.selection_events(scope) {
            return;
        }
        let key = tree.key_of(scope).map(str::to_string);
        let Some(snapshot) = tree.doc_selection_snapshot(&self.fonts) else {
            out.push(EngineEvent::Selection {
                view,
                node: scope,
                key,
                text: String::new(),
                rect: PxRect::ZERO,
                parts: Vec::new(),
            });
            return;
        };
        let origin = tree.rect(scope).unwrap_or(PxRect::ZERO);
        out.push(EngineEvent::Selection {
            view,
            node: scope,
            key,
            text: snapshot.text,
            rect: PxRect {
                x: snapshot.rect.x - origin.x,
                y: snapshot.rect.y - origin.y,
                w: snapshot.rect.w,
                h: snapshot.rect.h,
            },
            parts: snapshot
                .parts
                .into_iter()
                .map(|(key, range)| (key, range.start, range.end))
                .collect(),
        });
    }

    pub(super) fn handle_doc_key(&mut self, key: &KeyEvent) -> io::Result<bool> {
        use Granularity::{Char, Line, Word};
        let view = self.active_view;
        let m = key.mods;
        let combo = m.ctrl || m.sup;
        let horizontal = if m.alt {
            Word
        } else if m.sup {
            Line
        } else {
            Char
        };
        let handled = match key.key {
            crate::terminal::Key::Char('c') if combo => {
                match self.comp.views[view].tree.doc_selected_rich() {
                    Some(rich) => {
                        let marks = rich
                            .marks
                            .into_iter()
                            .map(|(node, id, offset, data)| {
                                (
                                    node,
                                    crate::text_input::Mark {
                                        id,
                                        offset,
                                        advance: 0.0,
                                        data,
                                    },
                                )
                            })
                            .collect();
                        self.begin_rich_capture(view, rich.text, marks)?;
                        true
                    }
                    None => false,
                }
            }
            crate::terminal::Key::Char('a') if m.sup => self.comp.views[view].tree.doc_select_all(),
            crate::terminal::Key::Escape => self.comp.views[view].tree.doc_collapse(),
            crate::terminal::Key::Left if m.shift => {
                self.comp.views[view].tree.doc_extend(true, horizontal)
            }
            crate::terminal::Key::Right if m.shift => {
                self.comp.views[view].tree.doc_extend(false, horizontal)
            }
            crate::terminal::Key::Home if m.shift => self.comp.views[view].tree.doc_extend(true, Line),
            crate::terminal::Key::End if m.shift => self.comp.views[view].tree.doc_extend(false, Line),
            crate::terminal::Key::Up if m.shift && m.sup => {
                self.comp.views[view].tree.doc_extend_edge(true)
            }
            crate::terminal::Key::Down if m.shift && m.sup => {
                self.comp.views[view].tree.doc_extend_edge(false)
            }
            crate::terminal::Key::Up if m.shift => {
                let fonts = &self.fonts;
                self.comp.views[view].tree.doc_extend_vertical(true, fonts)
            }
            crate::terminal::Key::Down if m.shift => {
                let fonts = &self.fonts;
                self.comp.views[view].tree.doc_extend_vertical(false, fonts)
            }
            _ => false,
        };
        Ok(handled)
    }

    pub(super) fn clear_doc_selections(&mut self, except: Option<usize>) {
        for (i, v) in self.comp.views.iter_mut().enumerate() {
            if except != Some(i) {
                v.tree.doc_collapse();
            }
        }
    }

    fn collapse_focused_input(&mut self) {
        if let Some((focus_view, focus)) = self.focused()
            && let Some(input) = self.comp.views[focus_view].tree.input_mut(focus)
            && input.collapse()
        {
            self.comp.views[focus_view].tree.mark_paint();
        }
    }

    pub(super) fn begin_text_selection(&mut self, view: usize, local: (f32, f32)) {
        self.clear_doc_selections(Some(view));
        let fonts = &self.fonts;
        if self.comp.views[view].tree.doc_select_down(local, fonts) {
            self.collapse_focused_input();
            self.drag = Some((view, DragTarget::Text));
        } else if self.comp.views[view].tree.doc_select_down_near(local, fonts) {
            self.drag = Some((view, DragTarget::Text));
        } else {
            self.comp.views[view].tree.doc_collapse();
        }
    }
}

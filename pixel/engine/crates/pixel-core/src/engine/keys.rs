use std::io;

use super::{ChangeSource, Engine, EngineEvent};
use crate::terminal::{KeyEvent, KeyKind};
use crate::text_input::InputReply;

fn key_label(key: &KeyEvent) -> String {
    let mut label = String::from("key ");
    if key.mods.ctrl {
        label.push_str("ctrl+");
    }
    if key.mods.alt {
        label.push_str("alt+");
    }
    if key.mods.sup {
        label.push_str("cmd+");
    }
    let name = match key.key {
        crate::terminal::Key::Char(c) => {
            if key.mods.shift {
                label.push_str("shift+");
            }
            label.push(c);
            return label;
        }
        crate::terminal::Key::Up => "up",
        crate::terminal::Key::Down => "down",
        crate::terminal::Key::Left => "left",
        crate::terminal::Key::Right => "right",
        crate::terminal::Key::Home => "home",
        crate::terminal::Key::End => "end",
        crate::terminal::Key::Insert => "insert",
        crate::terminal::Key::PageUp => "pageup",
        crate::terminal::Key::PageDown => "pagedown",
        crate::terminal::Key::Function(number) => {
            label.push('f');
            label.push_str(&number.to_string());
            return label;
        }
        crate::terminal::Key::LeftShift => "leftshift",
        crate::terminal::Key::LeftControl => "leftcontrol",
        crate::terminal::Key::LeftAlt => "leftalt",
        crate::terminal::Key::LeftSuper => "leftsuper",
        crate::terminal::Key::RightShift => "rightshift",
        crate::terminal::Key::RightControl => "rightcontrol",
        crate::terminal::Key::RightAlt => "rightalt",
        crate::terminal::Key::RightSuper => "rightsuper",
        crate::terminal::Key::Enter => "enter",
        crate::terminal::Key::Backspace => "backspace",
        crate::terminal::Key::Delete => "delete",
        crate::terminal::Key::Escape => "escape",
        crate::terminal::Key::Tab => "tab",
        crate::terminal::Key::Unknown => "unknown",
    };
    if key.mods.shift {
        label.push_str("shift+");
    }
    label.push_str(name);
    label
}

fn is_plain_enter(key: &KeyEvent) -> bool {
    key.key == crate::terminal::Key::Enter
        && !key.mods.shift
        && !key.mods.ctrl
        && !key.mods.alt
        && !key.mods.sup
}

fn capture_matches(name: &str, key: &KeyEvent) -> bool {
    use crate::terminal::Key;
    if key.mods.shift || key.mods.alt || key.mods.ctrl || key.mods.sup {
        return false;
    }
    match key.key {
        Key::Char(c) => name.chars().eq(std::iter::once(c)),
        Key::Up => name == "up",
        Key::Down => name == "down",
        Key::Left => name == "left",
        Key::Right => name == "right",
        Key::Home => name == "home",
        Key::End => name == "end",
        Key::Insert => name == "insert",
        Key::PageUp => name == "pageup",
        Key::PageDown => name == "pagedown",
        Key::Function(number) => name == format!("f{number}"),
        Key::LeftShift => name == "leftshift",
        Key::LeftControl => name == "leftcontrol",
        Key::LeftAlt => name == "leftalt",
        Key::LeftSuper => name == "leftsuper",
        Key::RightShift => name == "rightshift",
        Key::RightControl => name == "rightcontrol",
        Key::RightAlt => name == "rightalt",
        Key::RightSuper => name == "rightsuper",
        Key::Enter => name == "enter",
        Key::Backspace => name == "backspace",
        Key::Delete => name == "delete",
        Key::Escape => name == "escape",
        Key::Tab => name == "tab",
        Key::Unknown => false,
    }
}

impl Engine {
    pub(super) fn handle_key(&mut self, key: KeyEvent, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        crate::profiler::mark("key", self.active_view as u32, || key_label(&key));
        if self.key_passthrough {
            out.push(EngineEvent::Key {
                view: self.active_view,
                event: key,
            });
            return Ok(());
        }
        if key.kind == KeyKind::Release {
            out.push(EngineEvent::Key {
                view: self.active_view,
                event: key,
            });
            return Ok(());
        }
        if key.key == crate::terminal::Key::Escape {
            if self.menu.is_open() {
                self.close_menu();
                return Ok(());
            }
            if self.inspect_mode {
                self.set_inspect_mode(false);
                return Ok(());
            }
        }
        if self.key_capture.iter().any(|name| capture_matches(name, &key)) {
            out.push(EngineEvent::Key {
                view: self.active_view,
                event: key,
            });
            return Ok(());
        }
        let focused = self.focused().and_then(|(view, id)| {
            self.comp.views[view]
                .tree
                .input_meta(id)
                .map(|(resolved, submit)| (view, id, resolved, submit))
        });
        match focused {
            Some((view, focus, _, true)) if is_plain_enter(&key) => {
                self.submit_input(view, focus, out)?;
            }
            Some((view, focus, resolved, _)) => {
                let wrap = self.comp.views[view]
                    .tree
                    .input_geometry(focus)
                    .and_then(|g| g.max_width);
                let font = &self.fonts[resolved.font.min(self.fonts.len() - 1)];
                let input = self.comp.views[view]
                    .tree
                    .input_mut(focus)
                    .expect("checked above");
                let typed = (key.text.is_some()
                    || matches!(key.key, crate::terminal::Key::Char(_)))
                    && !key.mods.ctrl
                    && !key.mods.sup
                    && !key.mods.alt;
                let source = if typed {
                    ChangeSource::Type
                } else {
                    ChangeSource::Edit
                };
                let reply = input.handle_key(key.clone(), font, resolved.px, wrap);

                if reply == InputReply::None {
                    if !self.handle_doc_key(&key)? {
                        out.push(EngineEvent::Key {
                            view: self.active_view,
                            event: key,
                        });
                    }
                } else {
                    self.clear_doc_selections(None);
                    self.finish_reply(view, focus, reply, source, out)?;
                }
            }
            None => {
                if !self.handle_doc_key(&key)? {
                    out.push(EngineEvent::Key {
                        view: self.active_view,
                        event: key,
                    });
                }
            }
        }
        Ok(())
    }
}

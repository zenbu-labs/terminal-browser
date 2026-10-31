use pixel_core::{Event, Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind};
use serde::Deserialize;

#[derive(Deserialize, Default, Clone, Copy)]
pub struct InputMods {
    #[serde(default)]
    shift: bool,
    #[serde(default)]
    alt: bool,
    #[serde(default)]
    ctrl: bool,
    #[serde(default)]
    meta: bool,
}

impl From<InputMods> for Mods {
    fn from(m: InputMods) -> Self {
        Mods {
            shift: m.shift,
            alt: m.alt,
            ctrl: m.ctrl,
            sup: m.meta,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Input {
    Pointer {
        kind: String,
        #[serde(default)]
        button: Option<String>,
        x: f32,
        y: f32,
        #[serde(default)]
        mods: InputMods,
    },
    Scroll {
        x: f32,
        y: f32,
        dx: f32,
        dy: f32,
        #[serde(default)]
        mods: InputMods,
    },
    Key {
        key: String,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        mods: InputMods,
        #[serde(default)]
        release: bool,
    },
    Paste {
        text: String,
    },
    Focus {
        focused: bool,
    },
    Visible {
        visible: bool,
    },
    Osc {
        data: String,
    },
}

fn key_named(name: &str) -> Key {
    match name {
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "enter" => Key::Enter,
        "backspace" => Key::Backspace,
        "delete" => Key::Delete,
        "escape" => Key::Escape,
        "tab" => Key::Tab,
        "insert" => Key::Insert,
        name if name.starts_with('f') && name.len() > 1 && name[1..].parse::<u8>().is_ok() => {
            Key::Function(name[1..].parse().unwrap_or(1))
        }
        name => {
            let mut chars = name.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Key::Char(c),
                _ => Key::Unknown,
            }
        }
    }
}

fn pointer_kind(kind: &str) -> Option<MouseKind> {
    Some(match kind {
        "down" => MouseKind::Down,
        "up" => MouseKind::Up,
        "move" => MouseKind::Move,
        _ => return None,
    })
}

fn pointer_button(button: Option<&str>) -> MouseButton {
    match button {
        Some("left") => MouseButton::Left,
        Some("right") => MouseButton::Right,
        Some("middle") => MouseButton::Middle,
        _ => MouseButton::None,
    }
}

impl Input {
    pub fn into_event(self) -> Option<Event> {
        let px = |v: f32| v.max(0.0).round() as u32;
        Some(match self {
            Input::Pointer {
                kind,
                button,
                x,
                y,
                mods,
            } => Event::Mouse(Mouse {
                kind: pointer_kind(&kind)?,
                button: pointer_button(button.as_deref()),
                mods: mods.into(),
                x: px(x),
                y: px(y),
            }),
            Input::Scroll { x, y, dx, dy, mods } => Event::Wheel {
                x: px(x),
                y: px(y),
                delta_x: dx,
                delta_y: dy,
                mods: mods.into(),
            },
            Input::Key {
                key,
                text,
                mods,
                release,
            } => {
                let key = key_named(&key);
                let mods: Mods = mods.into();
                let text = text.or_else(|| match key {
                    Key::Char(c) if !mods.ctrl && !mods.sup => Some(c.to_string()),
                    _ => None,
                });
                Event::Key(KeyEvent {
                    key,
                    mods,
                    kind: if release {
                        KeyKind::Release
                    } else {
                        KeyKind::Press
                    },
                    text,
                })
            }
            Input::Paste { text } => Event::Paste(text),
            Input::Focus { focused } => Event::Focus(focused),
            Input::Visible { visible } => Event::Visible(visible),
            Input::Osc { data } => Event::Osc(data),
        })
    }
}

use std::io::{self, BufRead, BufReader, Write};
use crate::terminal::HostStream as UnixStream;
use std::time::Duration;

use serde_json::{Value, json};

use crate::terminal::{
    Event, Handoff, Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind,
    TerminalColors, WindowSize,
};

const INIT_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct HostState {
    pub(crate) size: WindowSize,
    pub(crate) colors: TerminalColors,
    pub(crate) focused: bool,
    pub(crate) closed: bool,
    pub(crate) cell: Option<(u32, u32)>,
    pub(crate) image_id: Option<u32>,
    pub(crate) transport: Option<String>,
}

pub(crate) struct Joined {
    pub(crate) stream: UnixStream,
    pub(crate) state: HostState,
    pub(crate) pending: Vec<u8>,
}

pub(crate) fn join(socket: &str, pane: &str, name: &str) -> io::Result<Joined> {
    let stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(INIT_TIMEOUT))?;
    let mut reader = BufReader::new(stream);
    let announce = json!({
        "type": "join",
        "pane": pane,
        "name": name,
        "pid": std::process::id(),
    });
    send(reader.get_mut(), &announce)?;
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Err(io::Error::other("host closed the connection before the init reply"));
    }
    let value: Value = serde_json::from_str(&line)
        .map_err(|error| io::Error::other(format!("host init reply is not json: {error}")))?;
    if value["type"] != "init" {
        return Err(io::Error::other(format!(
            "host answered {} instead of init",
            value["type"]
        )));
    }
    let state = HostState {
        size: size_from(&value).ok_or_else(|| io::Error::other("host init reply has no size"))?,
        colors: colors_from(&value["colors"]),
        focused: value["focused"].as_bool().unwrap_or(true),
        closed: false,
        cell: value["cell"].as_array().and_then(|cell| {
            Some((cell.first()?.as_u64()? as u32, cell.get(1)?.as_u64()? as u32))
        }),
        image_id: value["imageId"].as_u64().map(|id| id as u32),
        transport: value["transport"].as_str().map(str::to_string),
    };
    let pending = reader.buffer().to_vec();
    let stream = reader.into_inner();
    let _ = stream.set_read_timeout(None);
    Ok(Joined {
        stream,
        state,
        pending,
    })
}

pub(crate) fn send(stream: &mut UnixStream, message: &Value) -> io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
    stream.write_all(line.as_bytes())?;
    stream.flush()
}

pub(crate) fn title(text: &str) -> Value {
    json!({ "type": "title", "text": text })
}

pub(crate) fn pointer(shape: &str) -> Value {
    json!({ "type": "pointer", "shape": shape })
}

pub(crate) fn clipboard(text: &str) -> Value {
    json!({ "type": "clipboard", "text": text })
}

pub(crate) fn placed(image_id: u32, cols: u32, rows: u32, cell: Option<(u32, u32)>) -> Value {
    json!({ "type": "placed", "imageId": image_id, "cols": cols, "rows": rows, "cell": cell.map(|(w, h)| [w, h]) })
}

pub(crate) struct HostFrame<'a> {
    pub(crate) shm: &'a str,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) generation: u64,
    pub(crate) cols: u32,
    pub(crate) rows: u32,
    pub(crate) cell: Option<(u32, u32)>,
}

pub(crate) fn frame(frame: HostFrame<'_>) -> Value {
    json!({
        "type": "frame",
        "shm": frame.shm,
        "format": "rgba",
        "width": frame.width,
        "height": frame.height,
        "generation": frame.generation,
        "cols": frame.cols,
        "rows": frame.rows,
        "cell": frame.cell.map(|(w, h)| [w, h]),
    })
}

impl HostState {
    pub(crate) fn fill_pixel_size(&mut self) {
        if let Some((cw, ch)) = self.cell {
            if self.size.width_px == 0 {
                self.size.width_px = self.size.cols * cw;
            }
            if self.size.height_px == 0 {
                self.size.height_px = self.size.rows * ch;
            }
        }
    }
}

pub(crate) fn parse_line(line: &[u8], state: &mut HostState) -> Option<Event> {
    let value: Value = serde_json::from_slice(line).ok()?;
    match value["type"].as_str()? {
        "size" => {
            state.size = size_from(&value)?;
            if let Some(cell) = value["cell"].as_array() {
                state.cell = Some((cell.first()?.as_u64()? as u32, cell.get(1)?.as_u64()? as u32));
            }
            state.fill_pixel_size();
            Some(Event::WindowSize(state.size))
        }
        "key" => Some(Event::Key(key_from(&value)?)),
        "paste" => Some(Event::Paste(value["text"].as_str()?.to_string())),
        "wheel" => Some(Event::Wheel {
            x: u32_at(&value, "x")?,
            y: u32_at(&value, "y")?,
            delta_x: value["deltaX"].as_f64().unwrap_or(0.0) as f32,
            delta_y: value["deltaY"].as_f64().unwrap_or(0.0) as f32,
            mods: mods_from(&value["mods"]),
        }),
        "mouse" => Some(Event::Mouse(mouse_from(&value)?)),
        "focus" => {
            state.focused = value["focused"].as_bool()?;
            Some(Event::Focus(state.focused))
        }
        "visible" => Some(Event::Visible(value["value"].as_bool()?)),
        "colors" => {
            state.colors = colors_from(&value["colors"]);
            Some(Event::Colors(state.colors))
        }
        "devtools" => Some(Event::Devtools),
        "adopt" => Some(Event::Handoff(Handoff::Adopt {
            tty: value["tty"].as_str()?.to_string(),
        })),
        "rejoin" => Some(Event::Handoff(Handoff::Rejoin {
            socket: value["socket"].as_str()?.to_string(),
        })),
        _ => None,
    }
}

fn size_from(value: &Value) -> Option<WindowSize> {
    Some(WindowSize {
        cols: u32_at(value, "cols")?,
        rows: u32_at(value, "rows")?,
        width_px: u32_at(value, "width").unwrap_or(0),
        height_px: u32_at(value, "height").unwrap_or(0),
    })
}

fn u32_at(value: &Value, key: &str) -> Option<u32> {
    value[key].as_f64().map(|n| n.max(0.0).round() as u32)
}

fn mods_from(value: &Value) -> Mods {
    Mods {
        shift: value["shift"].as_bool().unwrap_or(false),
        alt: value["alt"].as_bool().unwrap_or(false),
        ctrl: value["ctrl"].as_bool().unwrap_or(false),
        sup: value["super"].as_bool().unwrap_or(false),
    }
}

fn key_from(value: &Value) -> Option<KeyEvent> {
    let key = key_named(value["key"].as_str()?);
    let kind = match value["kind"].as_str().unwrap_or("press") {
        "repeat" => KeyKind::Repeat,
        "release" => KeyKind::Release,
        _ => KeyKind::Press,
    };
    Some(KeyEvent {
        key,
        mods: mods_from(&value["mods"]),
        kind,
        text: value["text"].as_str().map(str::to_string),
    })
}

fn key_named(name: &str) -> Key {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Key::Char(c);
    }
    match name {
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "home" => Key::Home,
        "end" => Key::End,
        "insert" => Key::Insert,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "leftshift" => Key::LeftShift,
        "leftcontrol" => Key::LeftControl,
        "leftalt" => Key::LeftAlt,
        "leftsuper" => Key::LeftSuper,
        "rightshift" => Key::RightShift,
        "rightcontrol" => Key::RightControl,
        "rightalt" => Key::RightAlt,
        "rightsuper" => Key::RightSuper,
        "enter" => Key::Enter,
        "backspace" => Key::Backspace,
        "delete" => Key::Delete,
        "escape" => Key::Escape,
        "tab" => Key::Tab,
        _ => name
            .strip_prefix('f')
            .and_then(|n| n.parse().ok())
            .map_or(Key::Unknown, Key::Function),
    }
}

fn mouse_from(value: &Value) -> Option<Mouse> {
    let kind = match value["kind"].as_str()? {
        "down" => MouseKind::Down,
        "up" => MouseKind::Up,
        "move" => MouseKind::Move,
        "scrollup" => MouseKind::ScrollUp,
        "scrolldown" => MouseKind::ScrollDown,
        "scrollleft" => MouseKind::ScrollLeft,
        "scrollright" => MouseKind::ScrollRight,
        _ => return None,
    };
    let button = match value["button"].as_str().unwrap_or("none") {
        "left" => MouseButton::Left,
        "middle" => MouseButton::Middle,
        "right" => MouseButton::Right,
        _ => MouseButton::None,
    };
    Some(Mouse {
        kind,
        button,
        mods: mods_from(&value["mods"]),
        x: u32_at(value, "x")?,
        y: u32_at(value, "y")?,
    })
}

fn rgba_from(value: &Value) -> Option<[u8; 4]> {
    let parts = value.as_array()?;
    if parts.len() != 4 {
        return None;
    }
    let mut rgba = [0u8; 4];
    for (slot, part) in rgba.iter_mut().zip(parts) {
        *slot = part.as_u64()?.min(255) as u8;
    }
    Some(rgba)
}

fn colors_from(value: &Value) -> TerminalColors {
    let mut colors = TerminalColors {
        foreground: rgba_from(&value["foreground"]),
        background: rgba_from(&value["background"]),
        ..TerminalColors::default()
    };
    if let Some(palette) = value["palette"].as_array() {
        for (slot, entry) in colors.palette.iter_mut().zip(palette) {
            *slot = rgba_from(entry);
        }
    }
    colors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> HostState {
        HostState {
            size: WindowSize {
                cols: 80,
                rows: 24,
                width_px: 800,
                height_px: 480,
            },
            colors: TerminalColors::default(),
            focused: true,
            closed: false,
            cell: None,
            image_id: None,
            transport: None,
        }
    }

    #[test]
    fn handoff_lines_name_the_next_owner_or_where_to_rejoin() {
        let adopt = parse_line(br#"{"type":"adopt","tty":"/dev/ttys004"}"#, &mut state());
        assert!(
            matches!(adopt, Some(Event::Handoff(Handoff::Adopt { ref tty })) if tty == "/dev/ttys004")
        );
        let rejoin = parse_line(br#"{"type":"rejoin","socket":"/tmp/o.sock"}"#, &mut state());
        assert!(
            matches!(rejoin, Some(Event::Handoff(Handoff::Rejoin { ref socket })) if socket == "/tmp/o.sock")
        );
    }

    #[test]
    fn a_key_line_round_trips_the_shape_the_engine_emits() {
        let line = br#"{"type":"key","key":"a","kind":"press","text":"a","mods":{"shift":false,"alt":true,"ctrl":false,"super":false}}"#;
        let Some(Event::Key(key)) = parse_line(line, &mut state()) else {
            panic!("expected a key event");
        };
        assert_eq!(key.key, Key::Char('a'));
        assert_eq!(key.kind, KeyKind::Press);
        assert!(key.mods.alt);
        assert_eq!(key.text.as_deref(), Some("a"));
    }

    #[test]
    fn named_keys_and_function_keys_decode() {
        assert_eq!(key_named("pageup"), Key::PageUp);
        assert_eq!(key_named("f12"), Key::Function(12));
        assert_eq!(key_named("é"), Key::Char('é'));
        assert_eq!(key_named("nonsense"), Key::Unknown);
    }

    #[test]
    fn a_size_line_updates_what_size_reports_and_becomes_a_resize() {
        let mut state = state();
        let line = br#"{"type":"size","cols":100,"rows":30,"width":1000,"height":600}"#;
        let Some(Event::WindowSize(ws)) = parse_line(line, &mut state) else {
            panic!("expected a resize");
        };
        assert_eq!(ws.cols, 100);
        assert_eq!(state.size.height_px, 600);
    }

    #[test]
    fn mouse_lines_carry_guest_local_pixels() {
        let line = br#"{"type":"mouse","kind":"down","button":"left","mods":{},"x":12.6,"y":40}"#;
        let Some(Event::Mouse(mouse)) = parse_line(line, &mut state()) else {
            panic!("expected a mouse event");
        };
        assert_eq!(mouse.kind, MouseKind::Down);
        assert_eq!(mouse.button, MouseButton::Left);
        assert_eq!((mouse.x, mouse.y), (13, 40));
    }

    #[test]
    fn colors_use_the_same_arrays_the_engine_emits() {
        let line = br#"{"type":"colors","colors":{"foreground":[1,2,3,255],"background":null,"palette":[[9,9,9,255]]}}"#;
        let Some(Event::Colors(colors)) = parse_line(line, &mut state()) else {
            panic!("expected colors");
        };
        assert_eq!(colors.foreground, Some([1, 2, 3, 255]));
        assert_eq!(colors.background, None);
        assert_eq!(colors.palette[0], Some([9, 9, 9, 255]));
        assert_eq!(colors.palette[1], None);
    }

    #[test]
    fn unknown_lines_are_ignored_rather_than_fatal() {
        assert!(parse_line(br#"{"type":"later"}"#, &mut state()).is_none());
        assert!(parse_line(b"not json", &mut state()).is_none());
    }

    /// An owner in miniature: answers the frame protocol herdr speaks and the
    /// control join, pushes one key and one resize, and collects what the guest
    /// sends back.
    fn fake_owner(
        dir: &std::path::Path,
    ) -> (
        String,
        std::sync::mpsc::Receiver<String>,
        std::sync::mpsc::Receiver<String>,
    ) {
        let socket = dir.join("owner.sock");
        let listener = crate::terminal::HostListener::bind(&socket).unwrap();
        let (frames_tx, frames_rx) = std::sync::mpsc::channel();
        let (control_tx, control_rx) = std::sync::mpsc::channel();
        let frame_dir = dir.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            for connection in listener.incoming().take(3) {
                let Ok(connection) = connection else { break };
                let mut reader = BufReader::new(connection);
                let mut opening = String::new();
                if reader.read_line(&mut opening).unwrap_or(0) == 0 {
                    continue;
                }
                if opening.contains("pane.graphics.info") {
                    let info = json!({ "id": "info", "result": {
                        "cell_width_px": 10, "cell_height_px": 20, "pane_visible": true,
                        "file_frame_directory": frame_dir, "file_frame_formats": ["bgra"],
                        "file_frame_transport": "direct-kitty" }});
                    send(reader.get_mut(), &info).unwrap();
                } else if opening.contains("pane.graphics.stream") {
                    send(
                        reader.get_mut(),
                        &json!({ "id": "stream", "result": { "type": "ok" } }),
                    )
                    .unwrap();
                    let frames_tx = frames_tx.clone();
                    std::thread::spawn(move || {
                        let mut frame = String::new();
                        while reader.read_line(&mut frame).map(|n| n > 0).unwrap_or(false) {
                            frames_tx.send(frame.clone()).unwrap();
                            let ack = json!({ "id": "stream", "result": { "type": "pane_graphics_frame_ack" } });
                            if send(reader.get_mut(), &ack).is_err() {
                                break;
                            }
                            frame.clear();
                        }
                    });
                } else if opening.contains("\"join\"") {
                    let init = json!({ "type": "init", "cols": 40, "rows": 10, "width": 400,
                        "height": 200, "colors": { "background": [0, 0, 0, 255] }, "focused": true });
                    send(reader.get_mut(), &init).unwrap();
                    let key = json!({ "type": "key", "key": "enter", "kind": "press", "mods": {} });
                    send(reader.get_mut(), &key).unwrap();
                    send(reader.get_mut(), &json!({ "type": "size", "cols": 20, "rows": 5, "width": 200, "height": 100 })).unwrap();
                    control_tx.send(opening.clone()).unwrap();
                    let control_tx = control_tx.clone();
                    std::thread::spawn(move || {
                        let mut line = String::new();
                        while reader.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                            control_tx.send(line.clone()).unwrap();
                            line.clear();
                        }
                    });
                }
            }
        });
        (socket.to_string_lossy().into_owned(), frames_rx, control_rx)
    }

    #[test]
    fn a_hosted_terminal_takes_events_from_the_owner_and_hands_frames_back() {
        use crate::terminal::Terminal;
        let dir = std::env::temp_dir().join(format!("pixel-hosted-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (socket, frames, control) = fake_owner(&dir);

        let mut term = Terminal::join_host(&socket, "pane-7", "hello").unwrap();
        let joined: Value =
            serde_json::from_str(&control.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
        assert_eq!(joined["type"], "join");
        assert_eq!(joined["pane"], "pane-7");
        assert_eq!(joined["name"], "hello");
        assert!(term.is_hosted());
        assert!(term.kitty_keyboard());
        assert_eq!(term.size().unwrap().cols, 40);
        assert_eq!(
            term.query_colors().unwrap().background,
            Some([0, 0, 0, 255])
        );
        assert_eq!(term.cell_size().unwrap(), Some((10, 20)));

        let first = term.poll_event(Some(Duration::from_secs(2))).unwrap();
        assert!(
            matches!(
                first,
                Some(Event::Key(KeyEvent {
                    key: Key::Enter,
                    ..
                }))
            ),
            "{first:?}"
        );
        let second = term.poll_event(Some(Duration::from_secs(2))).unwrap();
        assert!(
            matches!(second, Some(Event::WindowSize(ws)) if ws.cols == 20),
            "{second:?}"
        );
        assert_eq!(term.size().unwrap().rows, 5);
        assert!(
            term.poll_event(Some(Duration::from_millis(20)))
                .unwrap()
                .is_none()
        );

        let mut canvas = crate::canvas::Canvas::new(4, 2);
        canvas.pixels[..4].copy_from_slice(&[1, 2, 3, 255]);
        let whole = [crate::surfaces::Rect::sized(canvas.width, canvas.height)];
        term.draw(crate::canvas::Frame { canvas: &canvas, premultiplied: false, changed: &[], repainted: &whole, opaque: &[], ui_over_surfaces: &[] })
            .unwrap();
        let header = frames.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(header.contains("\"format\":\"bgra\""), "{header}");
        let path = super::super::herdr::tests_support::frame_path(&header);
        let written = std::fs::read(path).unwrap();
        assert_eq!(&written[..4], &[3, 2, 1, 255]);

        term.set_title("guest title").unwrap();
        term.set_pointer_shape("pointer").unwrap();
        let sent: Vec<String> = (0..2)
            .map(|_| control.recv_timeout(Duration::from_secs(2)).unwrap())
            .collect();
        assert!(
            sent[0].contains("\"title\"") && sent[0].contains("guest title"),
            "{sent:?}"
        );
        assert!(sent[1].contains("\"pointer\""), "{sent:?}");
        drop(term);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    fn fake_embedder(dir: &std::path::Path) -> (String, std::sync::mpsc::Receiver<String>) {
        let socket = dir.join("embed.sock");
        let listener = crate::terminal::HostListener::bind(&socket).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let Ok((connection, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(connection);
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            tx.send(line.clone()).unwrap();
            let init = json!({ "type": "init", "cols": 40, "rows": 10, "width": 400, "height": 200,
                "cell": [10, 20], "transport": "host", "imageId": 77, "focused": true });
            send(reader.get_mut(), &init).unwrap();
            line.clear();
            while reader.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                tx.send(line.clone()).unwrap();
                line.clear();
            }
        });
        (socket.to_string_lossy().into_owned(), rx)
    }

    #[test]
    #[cfg(unix)]
    fn an_embedded_terminal_on_the_host_transport_hands_frames_over_as_shared_memory_and_leaves_the_tty_alone() {
        use crate::terminal::Terminal;
        let dir = std::env::temp_dir().join(format!("pixel-embed-host-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (socket, lines) = fake_embedder(&dir);
        let tty = dir.join("fake-tty");
        std::fs::write(&tty, b"").unwrap();

        let mut term = Terminal::join_embedded(&socket, "pane-1", "hello", tty.to_str().unwrap()).unwrap();
        let joined: Value = serde_json::from_str(&lines.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
        assert_eq!(joined["type"], "join");
        assert!(term.is_embedded());
        assert_eq!(term.cell_size().unwrap(), Some((10, 20)));

        let mut canvas = crate::canvas::Canvas::new(25, 30);
        canvas.pixels[..4].copy_from_slice(&[9, 8, 7, 255]);
        let whole = [crate::surfaces::Rect::sized(canvas.width, canvas.height)];
        let frame = crate::canvas::Frame { canvas: &canvas, premultiplied: false, changed: &[], repainted: &whole, opaque: &[], ui_over_surfaces: &[] };
        term.draw(frame).unwrap();
        term.draw(frame).unwrap();

        let first: Value = serde_json::from_str(&lines.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
        let second: Value = serde_json::from_str(&lines.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
        assert_eq!(first["type"], "frame", "{first}");
        assert_eq!(first["format"], "rgba");
        assert_eq!(first["width"], 25);
        assert_eq!(first["height"], 30);
        assert_eq!(first["cols"], 3);
        assert_eq!(first["rows"], 2);
        assert_eq!(first["generation"], 0);
        assert_eq!(second["generation"], 1);
        assert_ne!(first["shm"], second["shm"], "every frame is a fresh object");
        let name = first["shm"].as_str().unwrap();
        assert!(name.starts_with("/px-") && name.len() <= 30, "{name} must fit macOS's 30 byte shm names");
        let object = rustix::shm::open(name, rustix::shm::OFlags::RDONLY, rustix::fs::Mode::empty()).unwrap();
        // macOS rounds a shared-memory object up to whole pages
        assert!(rustix::fs::fstat(&object).unwrap().st_size >= 25 * 30 * 4);

        drop(term);
        assert_eq!(std::fs::read(&tty).unwrap(), b"", "nothing may be written to the host's tty");
        assert!(
            rustix::shm::open(name, rustix::shm::OFlags::RDONLY, rustix::fs::Mode::empty()).is_err(),
            "dropping the terminal unlinks the objects the terminal never read"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

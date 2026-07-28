use pixel_core::{
    Engine, EngineEvent, Key, KeyEvent, KeyKind, MarkRef, Mods, MouseButton, MouseKind, NodeId,
    ProfileData, PxRect,
};
use serde_json::json;

fn mods_json(mods: &Mods) -> serde_json::Value {
    json!({
        "shift": mods.shift,
        "alt": mods.alt,
        "ctrl": mods.ctrl,
        "super": mods.sup,
    })
}

fn caret_json(caret: &PxRect) -> serde_json::Value {
    json!({ "x": caret.x, "y": caret.y, "w": caret.w, "h": caret.h })
}

fn marks_json(marks: &[MarkRef]) -> serde_json::Value {
    json!(
        marks
            .iter()
            .map(|m| json!({ "id": m.id, "offset": m.offset, "data": m.data }))
            .collect::<Vec<_>>()
    )
}

use crate::ops::IdMap;

fn nearest_ext(engine: &Engine, ids: &IdMap, view: usize, node: NodeId) -> Option<u32> {
    let tree = &engine.comp.views.get(view)?.tree;
    let mut current = Some(node);
    while let Some(id) = current {
        if let Some(ext) = ids.ext(id) {
            return Some(ext);
        }
        current = tree.parent(id);
    }
    None
}

pub fn event_json(event: &EngineEvent, engine: &Engine, ids: &[IdMap]) -> Option<String> {
    let value = match event {
        EngineEvent::Click {
            view,
            node,
            key,
            x,
            y,
            offset,
        } => json!({
            "type": "click",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "x": x,
            "y": y,
            "offset": offset,
        }),
        EngineEvent::ClickOutside {
            view,
            node,
            key,
            x,
            y,
        } => json!({
            "type": "clickOutside",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "x": x,
            "y": y,
        }),
        EngineEvent::RightClick { view, x, y } => json!({
            "type": "rightClick",
            "view": view,
            "x": x,
            "y": y,
        }),
        EngineEvent::Change {
            view,
            node,
            key,
            text,
            marks,
            cursor,
            caret,
            source,
        } => json!({
            "type": "change",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "text": text,
            "marks": marks_json(marks),
            "cursor": cursor,
            "caret": caret_json(caret),
            "source": source.as_str(),
        }),
        EngineEvent::Caret {
            view,
            node,
            key,
            cursor,
            caret,
        } => json!({
            "type": "caret",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "cursor": cursor,
            "caret": caret_json(caret),
        }),
        EngineEvent::Submit {
            view,
            node,
            key,
            text,
            marks,
        } => json!({
            "type": "submit",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "text": text,
            "marks": marks_json(marks),
        }),
        EngineEvent::Scroll {
            view,
            node,
            key,
            offset,
            max,
        } => json!({
            "type": "scroll",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "offset": offset,
            "max": max,
        }),
        EngineEvent::Resize {
            view,
            width,
            height,
            base_px,
        } => json!({
            "type": "resize",
            "view": view,
            "width": width,
            "height": height,
            "basePx": base_px,
        }),
        EngineEvent::Colors { colors } => json!({
            "type": "colors",
            "colors": crate::colors_json(colors),
        }),
        EngineEvent::Inspect {
            view,
            node,
            key,
            x,
            y,
        } => json!({
            "type": "inspect",
            "view": view,
            "node": nearest_ext(engine, ids.get(*view)?, *view, *node)?,
            "key": key,
            "x": x,
            "y": y,
        }),
        EngineEvent::Wheel {
            view,
            node,
            key,
            x,
            y,
            delta_x,
            delta_y,
            precise,
            mods,
        } => json!({
            "type": "wheel",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "x": x,
            "y": y,
            "deltaX": delta_x,
            "deltaY": delta_y,
            "precise": precise,
            "mods": mods_json(mods),
        }),
        EngineEvent::MouseMove {
            view,
            node,
            key,
            x,
            y,
        } => json!({
            "type": "mouseMove",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "x": x,
            "y": y,
        }),
        EngineEvent::Pointer {
            view,
            node,
            key,
            kind,
            button,
            mods,
            x,
            y,
        } => json!({
            "type": "pointer",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "kind": match kind {
                MouseKind::Down => "down",
                MouseKind::Up => "up",
                MouseKind::Move => "move",
                _ => return None,
            },
            "button": match button {
                MouseButton::Left => "left",
                MouseButton::Middle => "middle",
                MouseButton::Right => "right",
                MouseButton::None => "none",
            },
            "mods": {
                "shift": mods.shift,
                "alt": mods.alt,
                "ctrl": mods.ctrl,
                "super": mods.sup,
            },
            "x": x,
            "y": y,
        }),
        EngineEvent::Key { view, event } => key_json(*view, event),
        EngineEvent::Paste { view, text } => json!({
            "type": "paste",
            "view": view,
            "text": text,
        }),
        EngineEvent::Focus { focused } => json!({
            "type": "focus",
            "focused": focused,
        }),
        EngineEvent::PasteImage {
            view,
            node,
            key,
            path,
            width,
            height,
            source,
        } => json!({
            "type": "pasteImage",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "path": path,
            "width": width,
            "height": height,
            "source": match source {
                pixel_core::clipboard_image::PasteSource::Clipboard => "clipboard",
                pixel_core::clipboard_image::PasteSource::Osc => "osc",
                pixel_core::clipboard_image::PasteSource::File => "file",
            },
        }),
        EngineEvent::HoverEnter { view, node, key } => json!({
            "type": "hoverEnter",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
        }),
        EngineEvent::HoverLeave { view, node, key } => json!({
            "type": "hoverLeave",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
        }),
        EngineEvent::Drag {
            view,
            node,
            key,
            phase,
            x,
            y,
            mods,
        } => json!({
            "type": "drag",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "phase": match phase {
                pixel_core::DragPhase::Start => "start",
                pixel_core::DragPhase::Move => "move",
                pixel_core::DragPhase::End => "end",
            },
            "x": x,
            "y": y,
            "mods": mods_json(mods),
        }),
        EngineEvent::Selection {
            view,
            node,
            key,
            text,
            rect,
            parts,
        } => json!({
            "type": "selection",
            "view": view,
            "node": ids.get(*view)?.ext(*node)?,
            "key": key,
            "text": text,
            "x": rect.x,
            "y": rect.y,
            "w": rect.w,
            "h": rect.h,
            "parts": parts
                .iter()
                .map(|(key, start, end)| json!({ "key": key, "start": start, "end": end }))
                .collect::<Vec<_>>(),
        }),
        EngineEvent::Log(entry) => json!({
            "type": "log",
            "seq": entry.seq,
            "epochMs": entry.epoch_ms,
            "level": entry.level.as_str(),
            "target": entry.target,
            "message": entry.message,
        }),
        EngineEvent::SerializeMarks { view, token, marks } => json!({
            "type": "serializeMarks",
            "view": view,
            "token": token,
            "marks": marks
                .iter()
                .enumerate()
                .filter_map(|(index, (node, id, _))| {
                    Some(json!({
                        "node": ids.get(*view)?.ext(*node)?,
                        "id": id,
                        "index": index,
                    }))
                })
                .collect::<Vec<_>>(),
        }),
        EngineEvent::Profile(data) => profile_json(data),
    };
    let mut value = value;
    if let Some(obj) = value.as_object_mut() {
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        obj.insert("atMs".into(), serde_json::json!(at_ms));
    }
    Some(value.to_string())
}

fn profile_json(data: &ProfileData) -> serde_json::Value {
    let spans: Vec<serde_json::Value> = data
        .spans
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "start": s.start_ms,
                "dur": s.dur_ms,
                "depth": s.depth,
                "view": s.view,
                "arg": s.arg,
                "label": s.label,
            })
        })
        .collect();
    let counters: Vec<serde_json::Value> = data
        .counters
        .iter()
        .map(|c| json!({ "name": c.name, "at": c.at_ms, "value": c.value }))
        .collect();
    let marks: Vec<serde_json::Value> = data
        .marks
        .iter()
        .map(|m| {
            json!({
                "name": m.name,
                "label": m.label,
                "start": m.start_ms,
                "dur": m.dur_ms,
                "view": m.view,
            })
        })
        .collect();
    json!({
        "type": "profile",
        "epochMs": data.epoch_ms,
        "spans": spans,
        "counters": counters,
        "marks": marks,
    })
}

fn key_json(view: usize, event: &KeyEvent) -> serde_json::Value {
    let key = match event.key {
        Key::Char(c) => c.to_string(),
        Key::Up => "up".into(),
        Key::Down => "down".into(),
        Key::Left => "left".into(),
        Key::Right => "right".into(),
        Key::Home => "home".into(),
        Key::End => "end".into(),
        Key::Insert => "insert".into(),
        Key::PageUp => "pageup".into(),
        Key::PageDown => "pagedown".into(),
        Key::Function(number) => format!("f{number}"),
        Key::LeftShift => "leftshift".into(),
        Key::LeftControl => "leftcontrol".into(),
        Key::LeftAlt => "leftalt".into(),
        Key::LeftSuper => "leftsuper".into(),
        Key::RightShift => "rightshift".into(),
        Key::RightControl => "rightcontrol".into(),
        Key::RightAlt => "rightalt".into(),
        Key::RightSuper => "rightsuper".into(),
        Key::Enter => "enter".into(),
        Key::Backspace => "backspace".into(),
        Key::Delete => "delete".into(),
        Key::Escape => "escape".into(),
        Key::Tab => "tab".into(),
        Key::Unknown => "unknown".into(),
    };
    json!({
        "type": "key",
        "view": view,
        "key": key,
        "text": event.text,
        "kind": match event.kind {
            KeyKind::Press => "press",
            KeyKind::Repeat => "repeat",
            KeyKind::Release => "release",
        },
        "mods": {
            "shift": event.mods.shift,
            "alt": event.mods.alt,
            "ctrl": event.mods.ctrl,
            "super": event.mods.sup,
        },
    })
}

mod transcript;
mod ui;

use std::collections::VecDeque;

use pixel_core::{Engine, EngineConfig, EngineEvent, Event, Key, Terminal, fontdue};
use ui::{
    ADD_NOTE, App, EDITOR, EngineSample, FONT_MONO, FONT_UI, MENU_ACTIONS, Note, Theme, build_ui,
    input_key,
};

static UI_FONT_BYTES: &[u8] = include_bytes!("../assets/InterVariable.ttf");
static MONO_FONT_BYTES: &[u8] = include_bytes!("../assets/JetBrainsMono-Regular.ttf");

const SYSTEM_UI_FONTS: &[&str] = &["/System/Library/Fonts/SFNS.ttf"];
const SYSTEM_MONO_FONTS: &[&str] = &["/System/Library/Fonts/SFNSMono.ttf"];

fn load_font(candidates: &[&str], fallback: &'static [u8]) -> fontdue::Font {
    let parse = |bytes: &[u8]| fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default());
    if cfg!(target_os = "macos") {
        for path in candidates {
            if let Ok(bytes) = std::fs::read(path)
                && let Ok(font) = parse(&bytes)
            {
                return font;
            }
        }
    }
    parse(fallback).expect("bundled font parses")
}

const GHOSTTY_KEYBINDS: &[&str] = &[
    "super+z=unbind",
    "super+shift+z=unbind",
    "super+a=unbind",
    "super+up=unbind",
    "super+down=unbind",
    "super+shift+up=unbind",
    "super+shift+down=unbind",
];

fn main() -> std::io::Result<()> {
    if std::env::args().any(|arg| arg == "--keys") {
        return key_dump();
    }
    if std::env::args().any(|arg| arg == "--setup-ghostty") {
        let claim = pixel_core::ghostty::claim_keybinds("typing", GHOSTTY_KEYBINDS)?;
        println!("{claim:?}");
        return Ok(());
    }
    let _ = pixel_core::ghostty::claim_keybinds("typing", GHOSTTY_KEYBINDS);

    let mut engine = Engine::new(EngineConfig {
        fonts: vec![
            load_font(SYSTEM_UI_FONTS, UI_FONT_BYTES),
            load_font(SYSTEM_MONO_FONTS, MONO_FONT_BYTES),
        ],
        cell_metrics_font: FONT_MONO,
        watch_resize: true,
    })?;
    let theme = Theme::from_terminal(engine.colors());
    engine.set_clear_color(0, theme.bg);

    let mut app = App {
        notes: transcript::demo_notes(),
        active: 0,
        theme,
        scroll_profile: 0,
        native: false,
        context_menu: None,
    };
    if engine.native_scroll_available() {
        app.enable_native();
    }
    sync_scroll_mode(&app, &mut engine);

    let mut needs_ui = true;
    let mut last_scroll = f32::NAN;
    'session: loop {
        if needs_ui {
            needs_ui = false;
            let sample = sample(&app, &engine);
            let frame = build_ui(
                &app,
                engine.window_px(),
                engine.base_px(),
                &sample,
                &engine.fonts()[FONT_UI],
            );
            engine.tree_mut().reconcile(frame);
        }

        let events = engine.pump(None)?;
        // The status chips sample engine stats, so rebuilding the UI
        // unconditionally would turn "stats changed" into a render loop.
        let scroll = engine
            .tree()
            .find(EDITOR)
            .and_then(|id| engine.tree().scroll_state(id))
            .map_or(0.0, |s| s.position);
        if scroll != last_scroll {
            last_scroll = scroll;
            needs_ui = true;
        }
        if !events.is_empty() {
            needs_ui = true;
        }
        let mut queue: VecDeque<EngineEvent> = events.into();
        while let Some(event) = queue.pop_front() {
            match event {
                EngineEvent::Key { event: key, .. } => {
                    let menu_was_open = app.context_menu.take().is_some();
                    if menu_was_open && key.key == Key::Escape {
                        continue;
                    }
                    match key.key {
                        Key::Char('q') if key.mods.ctrl => break 'session,
                        Key::Char('c') if key.mods.ctrl && !key.mods.sup => break 'session,
                        Key::Char('p') if key.mods.ctrl => {
                            engine.profiler_toggle()?;
                        }
                        Key::Char('s') if key.mods.ctrl => {
                            app.cycle_scroll_profile();
                            sync_scroll_mode(&app, &mut engine);
                        }
                        _ => {}
                    }
                }
                EngineEvent::Click { key, .. } => {
                    let menu_was_open = app.context_menu.take().is_some();
                    let Some(key) = key else {
                        continue;
                    };
                    if menu_was_open {
                        if let Some((_, action)) = MENU_ACTIONS.iter().find(|(k, _)| *k == key) {
                            let mut replies = Vec::new();
                            engine.apply_input_action(*action, &mut replies)?;
                            queue.extend(replies);
                        }
                        continue;
                    }
                    if let Some(index) = key.strip_prefix("note:").and_then(|i| i.parse().ok()) {
                        app.active = index;
                    } else if key == ADD_NOTE {
                        app.notes.push(Note {
                            title: format!("untitled {}", app.notes.len() + 1),
                            text: String::new(),
                        });
                        app.active = app.notes.len() - 1;
                    }
                }
                EngineEvent::RightClick { x, y, .. } => {
                    app.context_menu = None;
                    let over_editor = engine
                        .tree()
                        .find(EDITOR)
                        .and_then(|id| engine.tree().rect(id))
                        .is_some_and(|rect| rect.contains(x, y));
                    if !over_editor {
                        continue;
                    }
                    if let Some(input) = engine.tree().find(&input_key(app.active))
                        && let Some(geometry) = engine.tree().input_geometry(input)
                        && let Some(text) = engine.tree().input_text(input).map(str::to_string)
                    {
                        let offset = geometry.offset_at(&text, (x, y), engine.fonts());
                        let in_selection = engine
                            .tree()
                            .input(input)
                            .and_then(|i| i.selection())
                            .is_some_and(|s| s.contains(&offset));
                        if !in_selection {
                            engine
                                .tree_mut()
                                .edit_input(input, |i| i.set_cursor(offset, false));
                        }
                    }
                    app.context_menu = Some((x, y));
                }
                EngineEvent::Change { key, text, .. } => {
                    if let Some(index) = key
                        .as_deref()
                        .and_then(|k| k.strip_prefix("editor-input:"))
                        .and_then(|i| i.parse::<usize>().ok())
                        && index < app.notes.len()
                    {
                        app.notes[index].text = text;
                    }
                }
                EngineEvent::Paste { .. }
                | EngineEvent::Scroll { .. }
                | EngineEvent::Submit { .. }
                | EngineEvent::Resize { .. }
                | EngineEvent::Inspect { .. }
                | EngineEvent::Log(_)
                | EngineEvent::Profile(_) => {}
            }
        }
    }
    Ok(())
}

fn sample(app: &App, engine: &Engine) -> EngineSample {
    let tree = engine.tree();
    let input = tree
        .find(&input_key(app.active))
        .and_then(|id| tree.input(id));
    EngineSample {
        recording: engine.profiler_recording(),
        stats: engine.stats(),
        editor_scroll: tree
            .find(EDITOR)
            .and_then(|id| tree.scroll_state(id))
            .map_or(0.0, |s| s.position),
        can_undo: input.is_some_and(|i| i.can_undo()),
        can_redo: input.is_some_and(|i| i.can_redo()),
        has_selection: input.is_some_and(|i| i.selection().is_some()),
    }
}

fn sync_scroll_mode(app: &App, engine: &mut Engine) {
    engine.set_native_scroll(app.native_active());
    engine.set_scroll_profile(app.profile());
}

fn key_dump() -> std::io::Result<()> {
    use std::io::Write as _;
    let mut term = Terminal::new()?;
    let mut out = std::io::stdout();
    write!(out, "key dump — press keys; ctrl-q or ctrl-c quits\r\n")?;
    out.flush()?;
    loop {
        match term.read_event()? {
            Event::Key(k) => {
                write!(out, "{k:?}\r\n")?;
                out.flush()?;
                if k.mods.ctrl && matches!(k.key, Key::Char('q') | Key::Char('c')) {
                    return Ok(());
                }
            }
            Event::Paste(text) => {
                write!(out, "Paste({text:?})\r\n")?;
                out.flush()?;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn system_fonts_parse_when_present() {
        for path in SYSTEM_UI_FONTS.iter().chain(SYSTEM_MONO_FONTS) {
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default())
                .unwrap_or_else(|e| panic!("{path} exists but fontdue rejected it: {e}"));
        }
    }

    #[test]
    fn menu_action_keys_cover_the_menu() {
        let keys: Vec<&str> = MENU_ACTIONS.iter().map(|(k, _)| *k).collect();
        assert!(keys.contains(&"menu:undo") && keys.contains(&"menu:select-all"));
        assert_ne!(pixel_core::CONTEXT_MENU_KEY, ADD_NOTE);
    }
}

use std::time::Duration;

use pixel_cells::{ColorTier, TestBackend, TestHandle};
use pixel_core::backend::Event;
use pixel_core::fonts::FontRegistry;
use pixel_core::InputProps;
use pixel_core::{
    Border, CaretShape, Color, Desc, Dimension, Engine, EngineConfig, FlexDirection, HostColors, Key, KeyEvent,
    Paint, Style,
};

const FG: Color = [220, 220, 220, 255];
const BG: Color = [20, 20, 20, 255];

fn host() -> HostColors {
    HostColors { foreground: Some(FG), background: Some(BG), palette: [None; 16] }
}

fn fonts() -> FontRegistry {
    let face = |bytes: &[u8]| pixel_core::fontdue::Font::from_bytes(bytes, pixel_core::fontdue::FontSettings::default()).unwrap();
    FontRegistry::new(
        face(include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf")),
        face(include_bytes!("../../../assets/fonts/InterVariable.ttf")),
    )
}

const CELL: (u32, u32) = (10, 20);

fn engine(cols: u16, rows: u16, tier: ColorTier) -> (Engine, TestHandle) {
    let (backend, handle) = TestBackend::new((cols, rows), CELL, tier, host());
    let engine = Engine::new(EngineConfig { fonts: fonts(), cell_metrics_font: 0, backend: Box::new(backend) }).unwrap();
    (engine, handle)
}

fn show(engine: &mut Engine, desc: Desc) {
    engine.comp.views[0].tree.reconcile(desc);
    settle(engine);
}

fn settle(engine: &mut Engine) {
    for _ in 0..4 {
        engine.pump(Some(Duration::ZERO)).unwrap();
    }
}

fn text(content: &str) -> Desc {
    Desc { text: Some(content.into()), ..Desc::default() }
}

fn column(children: Vec<Desc>) -> Desc {
    Desc { style: Style { flex_direction: FlexDirection::Column, ..Style::default() }, children, ..Desc::default() }
}

#[test]
fn text_lands_one_row_per_line_whatever_the_font_size() {
    let (mut engine, handle) = engine(20, 4, ColorTier::TrueColor);
    let mut big = text("Big");
    big.style.font_size = Some(40.0);
    show(&mut engine, column(vec![text("hello"), big, text("world")]));
    assert_eq!(handle.snapshot(), "hello\nBig\nworld\n\n");
}

#[test]
fn wide_and_combined_graphemes_take_their_display_width() {
    let (mut engine, handle) = engine(20, 2, ColorTier::TrueColor);
    show(&mut engine, column(vec![text("你好x"), text("❤️y")]));
    assert_eq!(handle.snapshot(), "你好x\n❤️y\n");
}

#[test]
fn borders_become_box_drawing_around_the_content() {
    let (mut engine, handle) = engine(12, 5, ColorTier::TrueColor);
    show(
        &mut engine,
        column(vec![Desc {
            style: Style {
                width: Dimension::Px(100.0),
                border: Some(Border::hairline(FG)),
                corner_radius: [6.0; 4],
                ..Style::default()
            },
            children: vec![text("inside")],
            ..Desc::default()
        }]),
    );
    assert_eq!(handle.snapshot(), "╭────────╮\n│inside  │\n╰────────╯\n\n\n");
}

#[test]
fn thin_rules_become_line_glyphs() {
    let (mut engine, handle) = engine(8, 3, ColorTier::TrueColor);
    let rule = Desc {
        style: Style { width: Dimension::Px(60.0), height: Dimension::Px(1.0), background: Some(Paint::Solid(FG)), ..Style::default() },
        ..Desc::default()
    };
    let spacer = Desc { style: Style { height: Dimension::Px(20.0), ..Style::default() }, ..Desc::default() };
    show(&mut engine, column(vec![spacer, rule]));
    assert_eq!(handle.snapshot(), "\n──────\n\n", "a 1px rule takes its own row and draws a line across it");
}

#[test]
fn a_box_nearly_a_cell_tall_fills_its_row_instead_of_becoming_a_rule() {
    let (mut engine, handle) = engine(8, 2, ColorTier::TrueColor);
    let chip = Desc {
        style: Style { width: Dimension::Px(60.0), height: Dimension::Px(17.0), background: Some(Paint::Solid([60, 60, 60, 255])), ..Style::default() },
        children: vec![text("chip")],
        ..Desc::default()
    };
    show(&mut engine, column(vec![chip]));
    assert_eq!(handle.snapshot(), "chip

");
}

#[test]
fn a_fixed_height_bar_keeps_its_row_and_draws_its_bottom_border_below() {
    let (mut engine, handle) = engine(8, 3, ColorTier::TrueColor);
    let bar = Desc {
        style: Style {
            height: Dimension::Px(28.0),
            border: Some(Border { bottom: Some(pixel_core::BorderSide { width: 1.0, color: FG }), ..Border::default() }),
            ..Style::default()
        },
        children: vec![text("tabs")],
        ..Desc::default()
    };
    show(&mut engine, column(vec![bar, text("body")]));
    assert_eq!(handle.snapshot(), "tabs
────────
body
");
}

#[test]
fn the_focused_input_reports_its_caret_as_the_hardware_cursor() {
    let (mut engine, handle) = engine(20, 2, ColorTier::TrueColor);
    let input = Desc {
        key: Some("input".into()),
        style: Style { width: Dimension::Px(150.0), ..Style::default() },
        input: Some(InputProps { initial: "abc".into(), caret_shape: CaretShape::Bar, auto_focus: true, ..InputProps::default() }),
        ..Desc::default()
    };
    show(&mut engine, column(vec![text("title"), input]));
    let id = engine.comp.views[0].tree.find("input").unwrap();
    engine.set_focus(0, Some(id));
    handle.send(Event::Key(KeyEvent::plain(Key::Char('d'))));
    settle(&mut engine);
    assert_eq!(handle.snapshot(), "title\nabcd\n");
    let caret = handle.caret().expect("a focused input shows the cursor");
    assert_eq!((caret.x, caret.y, caret.shape), (4, 1, CaretShape::Bar));
    let last = handle.frames().last().cloned().unwrap();
    let text = String::from_utf8_lossy(&last);
    assert!(text.ends_with("\x1b[2;5H\x1b[?25h\x1b[?2026l") || text.contains("\x1b[2;5H"), "cursor is placed last: {text:?}");
}

#[test]
fn an_idle_frame_writes_nothing() {
    let (mut engine, handle) = engine(10, 2, ColorTier::TrueColor);
    show(&mut engine, text("still"));
    let before = handle.frames().len();
    engine.comp.views[0].tree.reconcile(text("still"));
    settle(&mut engine);
    let after = handle.frames();
    assert!(after[before..].iter().all(|frame| frame.is_empty()), "no bytes for an unchanged screen");
}

#[test]
fn selection_rects_tint_the_cells_under_the_text() {
    let (mut engine, handle) = engine(10, 1, ColorTier::Mono);
    let selected = Desc {
        style: Style { width: Dimension::Px(30.0), height: Dimension::Px(20.0), background: Some(Paint::Solid([255, 255, 255, 255])), ..Style::default() },
        ..Desc::default()
    };
    show(&mut engine, selected);
    let frames = handle.frames();
    let all = String::from_utf8_lossy(&frames.concat()).to_string();
    assert!(all.contains("\x1b[0;7m") || all.contains("7m"), "mono marks bright fills inverse: {all:?}");
}

#[test]
fn a_webview_draws_as_a_labelled_box() {
    let (mut engine, handle) = engine(14, 4, ColorTier::TrueColor);
    let surface = Desc {
        style: Style { width: Dimension::Px(120.0), height: Dimension::Px(60.0), ..Style::default() },
        surface: Some(7),
        ..Desc::default()
    };
    show(&mut engine, column(vec![surface]));
    assert_eq!(handle.snapshot(), "╭──────────╮\n│ web view │\n╰──────────╯\n\n");
}

#[test]
fn wheel_scrolling_a_list_lets_the_terminal_move_its_rows() {
    let (mut engine, handle) = engine(12, 8, ColorTier::TrueColor);
    let line = |i: usize| char::from(b'a' + i as u8).to_string().repeat(10);
    let rows = (0..26).map(|i| text(&line(i))).collect();
    let list = Desc {
        key: Some("list".into()),
        style: Style {
            height: Dimension::Px(120.0),
            overflow: pixel_core::Overflow::Scroll,
            layout: pixel_core::Layout::List,
            flex_direction: FlexDirection::Column,
            ..Style::default()
        },
        children: rows,
        ..Desc::default()
    };
    show(&mut engine, column(vec![text("title"), list, text("footer")]));
    let before = handle.frames().len();
    handle.send(Event::Mouse(pixel_core::Mouse {
        kind: pixel_core::MouseKind::ScrollDown,
        button: pixel_core::MouseButton::Middle,
        mods: pixel_core::Mods::default(),
        x: 15,
        y: 30,
    }));
    settle(&mut engine);
    let shown: Vec<String> = handle.snapshot().lines().map(|l| l.trim_end_matches([' ', '▐']).to_string()).collect();
    let expected: Vec<String> = ["title".to_string()].into_iter().chain((3..9).map(line)).chain(["footer".to_string()]).collect();
    assert_eq!(shown[..8], expected[..]);
    let text = String::from_utf8_lossy(&handle.frames()[before..].concat()).into_owned();
    assert!(text.contains("\x1b[2;7r\x1b[3S\x1b[r"), "rows 2-7 scroll up by three: {text:?}");
    for moved in 3..6 {
        assert!(!text.contains(&line(moved)), "row {moved} moved with the region and is not written again: {text:?}");
    }
    for uncovered in 6..9 {
        assert!(text.contains(&line(uncovered)), "uncovered row {uncovered} is written: {text:?}");
    }
}

#[test]
fn rows_that_barely_change_are_repainted_rather_than_scrolled() {
    let (mut engine, handle) = engine(12, 8, ColorTier::TrueColor);
    let rows = (0..40).map(|i| text(&format!("row {}", i % 10))).collect();
    let list = Desc {
        key: Some("list".into()),
        style: Style {
            height: Dimension::Px(120.0),
            overflow: pixel_core::Overflow::Scroll,
            layout: pixel_core::Layout::List,
            flex_direction: FlexDirection::Column,
            ..Style::default()
        },
        children: rows,
        ..Desc::default()
    };
    show(&mut engine, column(vec![text("title"), list, text("footer")]));
    let before = handle.frames().len();
    handle.send(Event::Mouse(pixel_core::Mouse {
        kind: pixel_core::MouseKind::ScrollDown,
        button: pixel_core::MouseButton::Middle,
        mods: pixel_core::Mods::default(),
        x: 15,
        y: 30,
    }));
    settle(&mut engine);
    let text = String::from_utf8_lossy(&handle.frames()[before..].concat()).into_owned();
    assert!(!text.contains("S\x1b[r"), "only one digit per row changed, so the rows are rewritten in place: {text:?}");
}

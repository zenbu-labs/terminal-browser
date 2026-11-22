use pixel_core::*;
use std::time::Instant;
use crate::canvas::Canvas;
use pixel_core::text_metrics::measure_text;

static FONT_BYTES: &[u8] =
    include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf");

fn font() -> pixel_core::fonts::Font {
    pixel_core::fonts::Font::single(fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap())
}

fn tree_of(window: (f32, f32), children: Vec<Desc>) -> Tree {
    let mut tree = Tree::new(window);
    tree.reconcile(Desc {
        children,
        ..Desc::default()
    });
    tree.flush_layout(&mut crate::tests::fonts(), 16.0);
    tree
}

fn painted(tree: &mut Tree, window: (u32, u32), cursor: Option<(f32, f32)>) -> Canvas {
    let mut canvas = Canvas::new(window.0, window.1);
    tree.flush_layout(&mut crate::tests::fonts(), 16.0);
    let scene = record_scene(tree, &[font()], cursor);
    crate::draw::paint_scene(&mut canvas, &scene.root, &[font()], false, None, None);
    canvas
}

fn pixel(canvas: &Canvas, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * canvas.width + x) * 4) as usize;
    canvas.pixels[i..i + 4].try_into().unwrap()
}

fn decode_signal() -> std::sync::mpsc::Receiver<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    pixel_core::image_cache::set_waker(move || {
        let _ = tx.send(());
    });
    rx
}

fn wait_for_decode(signal: &std::sync::mpsc::Receiver<()>) {
    signal
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("decode never landed");
    assert!(pixel_core::image_cache::drain_completed().landed);
}

#[test]
fn nodes_are_found_by_key_and_hover_swaps_their_background() {
    let block = || Desc {
        style: Style {
            width: Dimension::Px(10.0),
            height: Dimension::Px(10.0),
            background: Some(Paint::Solid([1, 1, 1, 255])),
            hover_background: Some([9, 9, 9, 255]),
            ..Style::default()
        },
        key: Some("panel".into()),
        ..Desc::default()
    };
    let mut tree = tree_of((10.0, 10.0), vec![block()]);
    let rect = tree.rect(tree.find("panel").unwrap()).unwrap();
    assert_eq!((rect.w, rect.h), (10.0, 10.0));
    assert!(tree.find("missing").is_none());
    let canvas = painted(&mut tree, (10, 10), Some((5.0, 5.0)));
    assert_eq!(pixel(&canvas, 0, 0), [9, 9, 9, 255]);
    assert!(tree.hover_at(5.0, 5.0).is_some());
    assert!(tree.hover_at(50.0, 50.0).is_none());

    let canvas = painted(&mut tree, (10, 10), Some((50.0, 50.0)));
    assert_eq!(pixel(&canvas, 0, 0), [1, 1, 1, 255]);
}

fn scroller(clickable_second: bool) -> Vec<Desc> {
    let block = |color: Color, clickable: bool, key: &str| Desc {
        style: Style {
            width: Dimension::Px(40.0),
            height: Dimension::Px(40.0),
            flex_shrink: 0.0,
            background: Some(Paint::Solid(color)),
            ..Style::default()
        },
        key: Some(key.into()),
        clickable,
        ..Desc::default()
    };
    vec![Desc {
        style: Style {
            flex_direction: FlexDirection::Column,
            width: Dimension::Px(40.0),
            height: Dimension::Px(40.0),
            overflow: Overflow::Scroll,
            ..Style::default()
        },
        key: Some("scroller".into()),
        children: vec![
            block([10, 0, 0, 255], false, "red"),
            block([0, 20, 0, 255], clickable_second, "green"),
        ],
        ..Desc::default()
    }]
}

#[test]
fn scroll_offset_shifts_children_and_clips_painting() {
    let mut tree = tree_of((40.0, 60.0), scroller(false));
    let id = tree.find("scroller").unwrap();
    tree.scroll_state_mut(id).unwrap().position = 10.0;
    tree.mark_place();
    let canvas = painted(&mut tree, (40, 60), None);
    // Offset 10 scrolls the red/green boundary from y=40 up to y=30.
    assert_eq!(pixel(&canvas, 0, 29), [10, 0, 0, 255]);
    assert_eq!(pixel(&canvas, 0, 30), [0, 20, 0, 255]);
    // The viewport ends at y=40; the green block must not paint below it.
    assert_eq!(pixel(&canvas, 0, 40), [0, 0, 0, 0]);
}

#[test]
fn absolute_nodes_place_by_inset_and_sit_on_top() {
    let mut tree = tree_of(
        (100.0, 100.0),
        vec![
            Desc {
                style: Style {
                    width: Dimension::Px(100.0),
                    height: Dimension::Px(100.0),
                    ..Style::default()
                },
                key: Some("under".into()),
                clickable: true,
                ..Desc::default()
            },
            Desc {
                style: Style {
                    position: Position::Absolute,
                    inset: pixel_core::Inset::top_left(30.0, 40.0),
                    width: Dimension::Px(20.0),
                    height: Dimension::Px(10.0),
                    background: Some(Paint::Solid([9, 9, 9, 255])),
                    ..Style::default()
                },
                key: Some("float".into()),
                clickable: true,
                ..Desc::default()
            },
        ],
    );
    let rect = tree.rect(tree.find("float").unwrap()).unwrap();
    assert_eq!((rect.x, rect.y, rect.w, rect.h), (30.0, 40.0, 20.0, 10.0));
    let canvas = painted(&mut tree, (100, 100), None);
    assert_eq!(
        pixel(&canvas, 35, 45),
        [9, 9, 9, 255],
        "floating node paints over the sibling that fills the window"
    );
    assert_eq!(
        tree.key_of(tree.hit_click(35.0, 45.0).unwrap()),
        Some("float")
    );
    assert_eq!(
        tree.key_of(tree.hit_click(5.0, 5.0).unwrap()),
        Some("under")
    );
}

fn editor(initial: &str) -> Vec<Desc> {
    vec![Desc {
        style: Style {
            width: Dimension::Px(200.0),
            height: Dimension::Px(60.0),
            ..Style::default()
        },
        children: vec![Desc {
            style: Style {
                padding: Edges::all(4.0),
                ..Style::default()
            },
            key: Some("in".into()),
            input: Some(InputProps {
                initial: initial.into(),
                caret_color: [255, 0, 0, 255],
                selection_color: [0, 255, 0, 255],
                ..InputProps::default()
            }),
            ..Desc::default()
        }],
        ..Desc::default()
    }]
}

fn editor_with_caret(initial: &str, shape: CaretShape) -> Vec<Desc> {
    let mut desc = editor(initial);
    desc[0].children[0].input.as_mut().unwrap().caret_shape = shape;
    desc
}

#[test]
fn block_caret_covers_the_next_character_and_redraws_it_on_top() {
    let mut tree = tree_of((200.0, 60.0), editor_with_caret("hWo", CaretShape::Block));
    let id = tree.find("in").unwrap();
    tree.input_mut(id).unwrap().set_cursor(1, false);
    tree.set_focus(Some(id));
    let fonts = [font()];
    let geometry = tree.input_geometry(id).unwrap();
    let block = geometry.caret_rect("hWo", &[], 1, &fonts);
    assert_eq!(block.w, measure_text(&fonts[0], "W", 16.0), "as wide as the character");
    let end = geometry.caret_rect("hWo", &[], 3, &fonts);
    assert_eq!(end.w, measure_text(&fonts[0], " ", 16.0), "one space wide past the end");

    let canvas = painted(&mut tree, (200, 60), None);
    let mut red = 0;
    let mut white = 0;
    for y in block.y as u32..(block.y + block.h) as u32 {
        for x in block.x.ceil() as u32..(block.x + block.w) as u32 {
            match pixel(&canvas, x, y) {
                [255, 0, 0, _] => red += 1,
                [r, g, b, _] if r > 200 && g > 200 && b > 200 => white += 1,
                _ => {}
            }
        }
    }
    assert!(red > 0, "block filled with the caret colour");
    assert!(white > 0, "the W is drawn in white on the red block");
}

#[test]
fn a_transparent_block_caret_draws_nothing() {
    let mut desc = editor_with_caret("hWo", CaretShape::Block);
    desc[0].children[0].input.as_mut().unwrap().caret_color = [0, 0, 0, 0];
    let mut tree = tree_of((200.0, 60.0), desc);
    let id = tree.find("in").unwrap();
    tree.input_mut(id).unwrap().set_cursor(1, false);
    let unfocused = painted(&mut tree, (200, 60), None);
    tree.set_focus(Some(id));
    tree.mark_paint();
    let focused = painted(&mut tree, (200, 60), None);
    assert!(unfocused.pixels == focused.pixels, "no letter redrawn under an invisible caret");
}

#[test]
fn a_block_caret_at_the_end_of_a_full_line_drops_to_a_reserved_line() {
    let fonts = [font()];
    let space = measure_text(&fonts[0], " ", 16.0);
    let fitting = ((192.0 + pixel_core::WRAP_SLACK) / space).floor() as usize;
    let text = "x".repeat(fitting);
    let auto_height = |shape| {
        let mut desc = editor_with_caret(&text, shape);
        desc[0].style.flex_direction = FlexDirection::Column;
        desc
    };
    let height = |shape| {
        let tree = tree_of((200.0, 60.0), auto_height(shape));
        tree.rect(tree.find("in").unwrap()).unwrap().h
    };
    let line = line_height(&fonts[0], 16.0);
    let reserved = height(CaretShape::Block) - height(CaretShape::Bar);
    assert!((reserved - line).abs() < 1.0, "one line reserved, got {reserved}");

    let mut tree = tree_of((200.0, 60.0), auto_height(CaretShape::Block));
    let id = tree.find("in").unwrap();
    let geometry = tree.input_geometry(id).unwrap();
    let end = geometry.caret_rect(&text, &[], text.len(), &fonts);
    assert_eq!((end.x, end.y), (geometry.origin.0, geometry.origin.1 + line));
    tree.input_mut(id).unwrap().set_cursor(text.len(), false);
    tree.set_focus(Some(id));
    let canvas = painted(&mut tree, (200, 60), None);
    assert_eq!(pixel(&canvas, end.x as u32 + 2, (end.y + end.h / 2.0) as u32)[..3], [255, 0, 0]);
}

#[test]
fn underscore_caret_sits_on_the_bottom_of_the_line() {
    let mut tree = tree_of((200.0, 60.0), editor_with_caret("hello", CaretShape::Underscore));
    let id = tree.find("in").unwrap();
    tree.input_mut(id).unwrap().set_cursor(5, false);
    tree.set_focus(Some(id));
    let rect = tree.input_geometry(id).unwrap().caret_rect("hello", &[], 5, &[font()]);
    let canvas = painted(&mut tree, (200, 60), None);
    let middle = (rect.x + rect.w / 2.0) as u32;
    assert_eq!(pixel(&canvas, middle, (rect.y + rect.h) as u32 - 1)[..3], [255, 0, 0]);
    assert_ne!(pixel(&canvas, middle, (rect.y + rect.h / 2.0) as u32)[..3], [255, 0, 0]);
}

#[test]
fn input_nodes_paint_caret_and_selection_and_expose_geometry() {
    let mut tree = tree_of((200.0, 60.0), editor("hello"));
    let id = tree.find("in").unwrap();
    tree.input_mut(id).unwrap().set_cursor(2, false);
    tree.mark_paint();

    let geometry = tree.input_geometry(id).unwrap();
    assert_eq!(geometry.origin, (4.0, 4.0), "origin is inside the padding");
    let fonts = [font()];
    let caret = geometry.caret_rect("hello", &[], 2, &fonts);
    let center = (
        (caret.x + caret.w / 2.0) as u32,
        (caret.y + caret.h / 2.0) as u32,
    );
    let canvas = painted(&mut tree, (200, 60), None);
    let [r, g, b, _] = pixel(&canvas, center.0, center.1);
    assert_ne!([r, g, b], [255, 0, 0], "no caret without focus");

    tree.set_focus(Some(id));
    let canvas = painted(&mut tree, (200, 60), None);
    let [r, g, b, _] = pixel(&canvas, center.0, center.1);
    assert_eq!([r, g, b], [255, 0, 0], "caret painted");
    assert_eq!(
        geometry.offset_at("hello", &[], (caret.x + 0.1, caret.y + 1.0), &fonts),
        2,
        "geometry maps points back to offsets"
    );

    tree.input_mut(id).unwrap().set_cursor(4, true);
    tree.mark_paint();
    let canvas = painted(&mut tree, (200, 60), None);
    let selected = geometry.caret_rect("hello", &[], 3, &fonts);
    let [r, g, b, _] = pixel(&canvas, selected.x as u32 + 1, selected.y as u32 + 1);
    assert_eq!(
        [r, g, b],
        [0, 255, 0],
        "selection painted behind the glyphs"
    );
    let [r, g, b, _] = pixel(&canvas, (caret.x + caret.w / 2.0) as u32, center.1);
    assert_eq!(
        [r, g, b],
        [0, 255, 0],
        "no caret while a selection is active"
    );
}

#[test]
fn spans_color_glyph_runs_within_one_text_node() {
    let mut tree = Tree::new((100.0, 40.0));
    let id = tree.create(Props {
        text: Some("XX".into()),
        spans: vec![TextSpan {
            start: 0,
            end: 1,
            color: [255, 0, 0, 255],
            background: None,
            ..TextSpan::default()
        }],
        ..Props::default()
    });
    tree.append(tree.root(), id);
    let canvas = painted(&mut tree, (100, 40), None);
    let cell = measure_text(&font(), "X", 16.0).ceil() as u32;
    let any_pixel = |x0: u32, x1: u32, pred: &dyn Fn([u8; 4]) -> bool| {
        (x0..x1).any(|x| (0..40).any(|y| pred(pixel(&canvas, x, y))))
    };
    assert!(
        any_pixel(0, cell, &|p| p[0] > 100 && p[1] == 0 && p[2] == 0),
        "first char paints in the span's red"
    );
    assert!(
        !any_pixel(0, cell / 2, &|p| p[1] > 0),
        "first char has no default-colored pixels"
    );
    assert!(
        any_pixel(cell, cell * 2, &|p| p[0] > 100 && p[1] == p[0] && p[2] == p[0]),
        "second char falls back to the node color"
    );
}

#[test]
fn span_background_fills_behind_the_byte_range_only() {
    let mut tree = Tree::new((100.0, 40.0));
    let id = tree.create(Props {
        text: Some("XX".into()),
        spans: vec![TextSpan {
            start: 0,
            end: 1,
            color: [255, 255, 255, 255],
            background: Some([0, 0, 255, 255]),
            ..TextSpan::default()
        }],
        ..Props::default()
    });
    tree.append(tree.root(), id);
    let canvas = painted(&mut tree, (100, 40), None);
    let cell = measure_text(&font(), "X", 16.0).floor() as u32;
    assert_eq!(
        pixel(&canvas, 1, 1),
        [0, 0, 255, 255],
        "background fills the first char's cell where no glyph covers"
    );
    assert_eq!(
        pixel(&canvas, cell + 2, 1),
        [0, 0, 0, 0],
        "second char's cell has no fill"
    );
}

#[test]
fn doc_selection_paints_with_the_inherited_color() {
    let children = vec![Desc {
        style: Style {
            selection_color: Some([0, 255, 0, 255]),
            ..Style::default()
        },
        key: Some("p".into()),
        text: Some("hello".into()),
        ..Desc::default()
    }];
    let mut tree = tree_of((200.0, 60.0), children);
    assert!(tree.doc_select_all());
    let id = tree.find("p").unwrap();
    assert_eq!(tree.doc_selection_range(id), Some(0..5));
    let fonts = [font()];
    let rect = tree
        .text_geometry(id)
        .unwrap()
        .caret_rect("hello", &[], 1, &fonts);
    let canvas = painted(&mut tree, (200, 60), None);
    let [r, g, b, _] = pixel(&canvas, rect.x as u32 + 1, rect.y as u32 + 1);
    assert_eq!([r, g, b], [0, 255, 0], "selection painted behind glyphs");
}

#[test]
fn unified_selection_bands_cover_the_gap_between_nodes() {
    let fonts = [font()];
    let mut children = labels("first", "second");
    children[0].style.selection_mode = SelectionMode::Unified;
    children[0].style.gap = 10.0;
    children[0].key = Some("wrap".into());
    let mut tree = tree_of((400.0, 200.0), children);
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
    tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);
    let blocks = tree.doc_selection_blocks(&fonts);
    let (container, bands, color) = blocks.first().cloned().unwrap();
    assert_eq!(tree.key_of(container), Some("wrap"));
    assert_eq!(bands.len(), 3);
    let wrap_rect = tree.rect(container).unwrap();
    assert_eq!((bands[1].x, bands[1].w), (wrap_rect.x, wrap_rect.w));
    let a_rect = tree.rect(a).unwrap();
    let gap = (a_rect.x + 2.0, a_rect.y + a_rect.h + 5.0);
    assert!(
        bands[1].y <= gap.1 && gap.1 <= bands[1].y + bands[1].h,
        "the gap row sits inside the middle band"
    );
    let canvas = painted(&mut tree, (400, 200), None);
    let [r, g, bl, _] = pixel(&canvas, gap.0 as u32, gap.1 as u32);
    assert_eq!([r, g, bl], [color[0], color[1], color[2]]);
}

#[test]
fn per_side_borders_paint_only_their_edges() {
    let mut tree = tree_of(
        (100.0, 50.0),
        vec![Desc {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(50.0),
                border: Some(Border {
                    top: Some(BorderSide {
                        width: 2.0,
                        color: [255, 0, 0, 255],
                    }),
                    bottom: Some(BorderSide {
                        width: 2.0,
                        color: [0, 255, 0, 255],
                    }),
                    ..Border::default()
                }),
                ..Style::default()
            },
            ..Desc::default()
        }],
    );
    let canvas = painted(&mut tree, (100, 50), None);
    assert_eq!(pixel(&canvas, 50, 0), [255, 0, 0, 255], "top strip");
    assert_eq!(pixel(&canvas, 50, 49), [0, 255, 0, 255], "bottom strip");
    assert_eq!(pixel(&canvas, 0, 25), [0, 0, 0, 0], "no left border");
    assert_eq!(pixel(&canvas, 99, 25), [0, 0, 0, 0], "no right border");
}

#[test]
fn unified_bands_stay_visible_over_child_backgrounds() {
    let fonts = [font()];
    let children = vec![Desc {
        style: Style {
            flex_direction: FlexDirection::Column,
            align_items: Some(Align::Start),
            selection_mode: SelectionMode::Unified,
            selection_color: Some([0, 200, 0, 255]),
            ..Style::default()
        },
        key: Some("wrap".into()),
        children: vec![
            Desc {
                key: Some("a".into()),
                text: Some("first".into()),
                ..Desc::default()
            },
            Desc {
                style: Style {
                    background: Some(Paint::Solid([40, 40, 40, 255])),
                    border: Some(Border::hairline([80, 80, 80, 255])),
                    padding: Edges::all(6.0),
                    ..Style::default()
                },
                key: Some("row".into()),
                children: vec![Desc {
                    key: Some("b".into()),
                    text: Some("second".into()),
                    ..Desc::default()
                }],
                ..Desc::default()
            },
        ],
        ..Desc::default()
    }];
    let mut tree = tree_of((400.0, 200.0), children);
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
    tree.doc_select_drag(point_at(&tree, b, 4, &fonts), &fonts);
    assert!(!tree.doc_selection_blocks(&fonts).is_empty());

    let row = tree.rect(tree.find("row").unwrap()).unwrap();
    let caret = tree
        .text_geometry(b)
        .unwrap()
        .caret_rect("second", &[], 0, &fonts);
    let canvas = painted(&mut tree, (400, 200), None);
    assert_eq!(
        pixel(&canvas, caret.x as u32 + 1, caret.y as u32 + 1),
        [0, 200, 0, 255],
        "band shows behind the glyphs inside the chromed row"
    );
    assert_eq!(
        pixel(&canvas, row.x as u32 + 2, caret.y as u32 + 1),
        [0, 200, 0, 255],
        "band covers the row's own background, not the other way around"
    );
}

#[test]
fn placeholder_slot_fills_the_image_rect_until_the_decode_lands() {
    let dir = std::env::temp_dir().join("pixel-tree-slot-test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("slot.png");
    image::RgbaImage::from_pixel(4, 2, image::Rgba([0, 200, 0, 255]))
        .save(&path)
        .unwrap();
    let decoded = decode_signal();
    let mut tree = tree_of(
        (200.0, 100.0),
        vec![Desc {
            style: Style {
                align_items: Some(Align::Start),
                ..Style::default()
            },
            children: vec![Desc {
                style: Style {
                    width: Dimension::Px(40.0),
                    ..Style::default()
                },
                image: Some(ImageProps {
                    src: path.to_string_lossy().to_string(),
                    equal_to: Vec::new(),
                    glyph: None,
                }),
                key: Some("img".into()),
                children: vec![Desc {
                    style: Style {
                        background: Some(Paint::Solid([50, 50, 50, 255])),
                        ..Style::default()
                    },
                    slot: Some(SlotKind::Placeholder),
                    key: Some("ph".into()),
                    ..Desc::default()
                }],
                ..Desc::default()
            }],
            ..Desc::default()
        }],
    );

    let img = tree.find("img").unwrap();
    let ph = tree.find("ph").unwrap();
    let img_rect = tree.rect(img).unwrap();
    assert_eq!(
        (img_rect.w, img_rect.h),
        (40.0, 20.0),
        "sniffed size drives layout while pending"
    );
    assert_eq!(
        tree.rect(ph).unwrap(),
        img_rect,
        "placeholder is pinned to the image rect"
    );
    let canvas = painted(&mut tree, (200, 100), None);
    assert_eq!(pixel(&canvas, 20, 10), [50, 50, 50, 255]);

    wait_for_decode(&decoded);
    tree.mark_place();
    let canvas = painted(&mut tree, (200, 100), None);
    assert_eq!(tree.rect(ph).unwrap(), PxRect::ZERO, "placeholder retires");
    assert_eq!(pixel(&canvas, 20, 10), [0, 200, 0, 255]);
}

#[test]
fn static_text_marks_place_widgets_like_inputs() {
    let mut tree = Tree::new((400.0, 100.0));
    let sentinel = pixel_core::MARK_CHAR;
    let text = tree.create(Props {
        style: Style {
            width: Dimension::Px(300.0),
            ..Style::default()
        },
        text: Some(format!("a{sentinel}b{sentinel}c")),
        // Claim only the first sentinel; the stray second one is stripped.
        marks: vec![(9, 1)],
        ..Props::default()
    });
    tree.append(tree.root(), text);
    let widget = tree.create(Props {
        style: Style {
            width: Dimension::Px(40.0),
            height: Dimension::Px(10.0),
            ..Style::default()
        },
        mark: Some(9),
        ..Props::default()
    });
    tree.append(text, widget);
    tree.flush_layout(&mut crate::tests::fonts(), 16.0);

    assert_eq!(
        tree.text_of(text).unwrap(),
        format!("a{sentinel}bc"),
        "unclaimed sentinel stripped"
    );
    let rect = tree.rect(widget).unwrap();
    assert_eq!((rect.w, rect.h), (40.0, 10.0));
    assert!(rect.x > 0.0, "widget placed inline");

    // The node stays a selectable doc-text leaf despite its widget child.
    assert!(tree.selectable_text_leaf(text));

    // Painting draws the widget background at its inline position.
    let mut painted_tree = tree;
    painted_tree.update(
        widget,
        Props {
            style: Style {
                width: Dimension::Px(40.0),
                height: Dimension::Px(10.0),
                background: Some(Paint::Solid([200, 30, 30, 255])),
                ..Style::default()
            },
            mark: Some(9),
            ..Props::default()
        },
    );
    let canvas = painted(&mut painted_tree, (400, 100), None);
    let rect = painted_tree.rect(widget).unwrap();
    assert_eq!(
        pixel(&canvas, (rect.x + 5.0) as u32, (rect.y + 5.0) as u32),
        [200, 30, 30, 255]
    );
}

fn paint_now(tree: &Tree, window: (u32, u32)) -> Canvas {
    let mut canvas = Canvas::new(window.0, window.1);
    let scene = record_scene(tree, &[font()], None);
    crate::draw::paint_scene(&mut canvas, &scene.root, &[font()], false, None, None);
    canvas
}

#[test]
fn scrolling_places_only_rows_on_screen_and_still_knows_where_the_rest_are() {
    let mut tree = tree_of((40.0, 100.0), rows(100, None));
    let row = |tree: &Tree, i: u8| tree.find(&format!("row{i}")).unwrap();
    scroll_on_screen(&mut tree, 1000.0);
    let canvas = paint_now(&tree, (40, 100));
    assert_eq!(pixel(&canvas, 0, 0), [50, 0, 0, 255]);
    assert_eq!(pixel(&canvas, 0, 99), [54, 0, 0, 255]);
    assert_eq!(tree.hit_click(5.0, 5.0), Some(row(&tree, 50)));
    assert_eq!(tree.hit_click(5.0, 85.0), Some(row(&tree, 54)));
    let first = tree.placement(row(&tree, 0)).unwrap();
    assert!(first.offscreen);
    assert_eq!(first.visible, PxRect::ZERO, "a row that scrolled away takes no clicks");
    assert_eq!(first.abs.y, 0.0, "a skipped row is not placed again");
    assert_eq!(tree.rect(row(&tree, 0)).unwrap().y, -1000.0);
    assert_eq!(tree.rect(row(&tree, 99)).unwrap().y, 980.0);
    assert_eq!(tree.text_geometry(row(&tree, 99)).unwrap().origin.1, 980.0);
}

#[test]
fn a_row_scrolled_away_still_paints_what_hangs_below_it() {
    let mut tree = tree_of((40.0, 100.0), rows(100, Some(49)));
    scroll_on_screen(&mut tree, 1000.0);
    let canvas = paint_now(&tree, (40, 100));
    assert_eq!(pixel(&canvas, 25, 30), [0, 0, 200, 255], "row 49 is above the viewport but its tall child reaches into it");
    assert_eq!(pixel(&canvas, 25, 45), [0, 0, 0, 0]);
    assert_eq!(pixel(&canvas, 5, 30), [51, 0, 0, 255]);
}

#[test]
fn a_row_growing_above_the_viewport_pushes_what_is_shown_down() {
    let mut tree = tree_of((40.0, 100.0), rows(100, None));
    let row = |tree: &Tree, i: u8| tree.find(&format!("row{i}")).unwrap();
    scroll_on_screen(&mut tree, 1000.0);
    let grown = row(&tree, 2);
    let mut list = rows(100, None);
    list[0].children[2].style.height = Dimension::Px(60.0);
    tree.reconcile(Desc { children: list, ..Desc::default() });
    tree.flush_layout(&mut crate::tests::fonts(), 16.0);
    assert_eq!(row(&tree, 2), grown);
    let canvas = paint_now(&tree, (40, 100));
    assert_eq!(pixel(&canvas, 0, 0), [48, 0, 0, 255]);
    assert_eq!(tree.hit_click(5.0, 5.0), Some(row(&tree, 48)));
    assert_eq!(tree.rect(grown).unwrap(), PxRect { x: 0.0, y: -960.0, w: 20.0, h: 60.0 });
    assert_eq!(tree.rect(row(&tree, 99)).unwrap().y, 1020.0);
}

#[test]
fn a_row_inserted_above_the_viewport_pushes_what_is_shown_down() {
    let mut tree = tree_of((40.0, 100.0), rows(100, None));
    let scroller = tree.find("scroller").unwrap();
    let first = tree.find("row0").unwrap();
    scroll_on_screen(&mut tree, 1000.0);
    let inserted = tree.create(Props {
        style: Style { width: Dimension::Px(20.0), height: Dimension::Px(20.0), flex_shrink: 0.0, ..Style::default() },
        ..Props::default()
    });
    tree.insert_before(scroller, inserted, Some(first));
    tree.flush_layout(&mut crate::tests::fonts(), 16.0);
    let canvas = paint_now(&tree, (40, 100));
    assert_eq!(pixel(&canvas, 0, 0), [49, 0, 0, 255]);
    assert_eq!(tree.hit_click(5.0, 5.0), tree.find("row49"));
}

fn list_of(count: usize, row_h: impl Fn(usize) -> f32, list: Style) -> Vec<Desc> {
    let row = |i: usize| Desc {
        style: Style { height: Dimension::Px(row_h(i)), background: Some(Paint::Solid([i as u8, 1, 0, 255])), ..Style::default() },
        key: Some(format!("row{i}")),
        clickable: true,
        ..Desc::default()
    };
    vec![Desc {
        style: Style { width: Dimension::Px(40.0), height: Dimension::Px(100.0), overflow: Overflow::Scroll, layout: Layout::List, ..list },
        key: Some("list".into()),
        children: (0..count).map(row).collect(),
        ..Desc::default()
    }]
}

#[test]
fn list_rows_stack_at_the_list_width_inside_padding_and_gap() {
    let list = Style { padding: Edges::all(5.0), gap: 2.0, ..Style::default() };
    let tree = tree_of((100.0, 100.0), list_of(3, |_| 20.0, list));
    let row = |tree: &Tree, i: usize| tree.rect(tree.find(&format!("row{i}")).unwrap()).unwrap();
    assert_eq!(row(&tree, 0), PxRect { x: 5.0, y: 5.0, w: 30.0, h: 20.0 });
    assert_eq!(row(&tree, 1).y, 27.0);
    assert_eq!(row(&tree, 2).y, 49.0);
    let list_id = tree.find("list").unwrap();
    assert_eq!(tree.scroll_max(list_id), 0.0, "74 px of rows and padding fit in 100");
    let canvas = paint_now(&tree, (100, 100));
    assert_eq!(pixel(&canvas, 6, 26), [0, 0, 0, 0], "the gap between rows is empty");
    assert_eq!(pixel(&canvas, 6, 27), [1, 1, 0, 255]);
}

#[test]
fn rows_changing_size_above_the_viewport_leave_the_reading_position_alone() {
    let rows = |grown: f32| list_of(300, move |i| if i == 10 { grown } else { 20.0 }, Style::default());
    let mut tree = tree_of((40.0, 100.0), rows(20.0));
    catch_up(&mut tree);
    scroll_list(&mut tree, 1000.0);
    let canvas = paint_now(&tree, (40, 100));
    assert_eq!(pixel(&canvas, 0, 0), [50, 1, 0, 255]);
    tree.reconcile(Desc { children: rows(120.0), ..Desc::default() });
    tree.flush_layout(&mut crate::tests::fonts(), 16.0);
    catch_up(&mut tree);
    let canvas = paint_now(&tree, (40, 100));
    assert_eq!(pixel(&canvas, 0, 0), [50, 1, 0, 255], "row 50 is still at the top after row 10 grew");
    assert_eq!(tree.scroll_state(tree.find("list").unwrap()).unwrap().position, 1100.0);
}

#[test]
fn a_sticky_header_holds_the_top_of_its_section_until_the_next_section_pushes_it_off() {
    let mut tree = tree_of((40.0, 50.0), sections(10));
    tree.take_stick_changes();
    scroll_list(&mut tree, 230.0);
    let header = tree.find("header2").unwrap();
    assert_eq!(tree.placement(header).unwrap().abs.y, 0.0);
    assert!(tree.placement(header).unwrap().stuck);
    assert_eq!(tree.take_stick_changes(), vec![(header, true)]);
    let canvas = paint_now(&tree, (40, 50));
    assert_eq!(pixel(&canvas, 0, 5), [200, 2, 0, 255], "the header paints over its section");
    assert_eq!(tree.hit_click(5.0, 5.0), Some(header));
    scroll_list(&mut tree, 295.0);
    assert_eq!(tree.placement(header).unwrap().abs.y, -5.0, "the end of the section pushes it up");
    scroll_list(&mut tree, 300.0);
    assert!(tree.take_stick_changes().contains(&(header, false)));
    assert_eq!(tree.rect(header).unwrap().y, -100.0);
}

#[test]
fn a_scrolled_list_is_described_as_content_that_moves_with_what_is_drawn_over_it() {
    let mut tree = tree_of((40.0, 100.0), list_of(300, |_| 20.0, Style::default()));
    scroll_list(&mut tree, 4000.4);
    let scene = record_scene(&tree, &[font()], None);
    let layer = crate::scroll_layer(&scene.root).expect("a tall list is shown as a layer");
    assert_eq!(layer.origin_y, -4000, "content moves in whole pixels");
    assert_eq!((layer.area.y, layer.area.h, layer.area.w), (0, 100, 40));
    assert!(layer.overlay_rects().is_empty());

    let mut list = sections(10);
    list[0].style.height = Dimension::Px(100.0);
    let mut tree = tree_of((40.0, 100.0), list);
    scroll_list(&mut tree, 230.0);
    let scene = record_scene(&tree, &[font()], None);
    let layer = crate::scroll_layer(&scene.root).unwrap();
    assert_eq!(layer.overlay_rects(), vec![pixel_core::surfaces::Rect { x: 0, y: 0, w: 40, h: 10 }], "the stuck header is drawn over the content");
}

#[test]
fn a_host_drawn_surface_reports_where_it_sits_and_what_covers_it() {
    let mut tree = Tree::new((200.0, 100.0));
    let surface = tree.create(Props {
        style: Style { width: Dimension::Px(200.0), height: Dimension::Px(60.0), ..Style::default() },
        surface: Some(7),
        ..Props::default()
    });
    let menu = tree.create(Props {
        style: Style {
            position: Position::Absolute,
            inset: pixel_core::Inset::top_left(40.0, 10.0),
            width: Dimension::Px(50.0),
            height: Dimension::Px(30.0),
            background: Some(Paint::Solid([20, 20, 20, 255])),
            ..Style::default()
        },
        ..Props::default()
    });
    tree.append(tree.root(), surface);
    tree.append(tree.root(), menu);
    let mut fonts = crate::tests::fonts();
    tree.flush_layout(&mut fonts, 16.0);

    let scene = record_scene(&tree, &fonts, None);
    let mut placed = Vec::new();
    crate::surface_items(&scene.root, None, &mut placed);
    let placed: Vec<_> = placed.into_iter().map(|(id, rect, _)| (id, rect.w, rect.h)).collect();
    assert_eq!(placed, vec![(7, 200.0, 60.0)]);
    let covers = crate::surface_covers(&scene.root);
    assert_eq!(covers.len(), 1, "the menu is drawn over the surface");
    let (id, rect, opaque) = covers[0];
    assert_eq!((id, rect.x, rect.y, rect.w, rect.h, opaque), (7, 40.0, 10.0, 50.0, 30.0, true));
}


fn sections(count: usize) -> Vec<Desc> {
    let section = |s: usize| Desc {
        style: Style { flex_direction: FlexDirection::Column, ..Style::default() },
        key: Some(format!("section{s}")),
        children: vec![
            Desc {
                style: Style { height: Dimension::Px(10.0), position: Position::Sticky, inset: pixel_core::Inset { top: Some(InsetValue::Px(0.0)), ..Default::default() }, background: Some(Paint::Solid([200, s as u8, 0, 255])), ..Style::default() },
                key: Some(format!("header{s}")),
                stick_events: true,
                clickable: true,
                ..Desc::default()
            },
            Desc { style: Style { height: Dimension::Px(90.0), background: Some(Paint::Solid([0, s as u8, 100, 255])), ..Style::default() }, clickable: true, ..Desc::default() },
        ],
        ..Desc::default()
    };
    vec![Desc {
        style: Style { width: Dimension::Px(40.0), height: Dimension::Px(50.0), overflow: Overflow::Scroll, layout: Layout::List, ..Style::default() },
        key: Some("list".into()),
        children: (0..count).map(section).collect(),
        ..Desc::default()
    }]
}


fn scroll_list(tree: &mut Tree, position: f32) {
    let id = tree.find("list").unwrap();
    let state = tree.scroll_state_mut(id).unwrap();
    state.position = position;
    state.set_target(position);
    tree.mark_place();
    tree.flush_layout(&mut crate::tests::fonts(), 16.0);
}

fn rows(count: u8, overflow_from: Option<u8>) -> Vec<Desc> {
    let row = |i: u8| Desc {
        style: Style {
            width: Dimension::Px(20.0),
            height: Dimension::Px(20.0),
            flex_shrink: 0.0,
            background: Some(Paint::Solid([i, 0, 0, 255])),
            ..Style::default()
        },
        key: Some(format!("row{i}")),
        clickable: true,
        children: (overflow_from == Some(i))
            .then(|| Desc {
                style: Style {
                    width: Dimension::Px(30.0),
                    height: Dimension::Px(60.0),
                    flex_shrink: 0.0,
                    background: Some(Paint::Solid([0, 0, 200, 255])),
                    ..Style::default()
                },
                ..Desc::default()
            })
            .into_iter()
            .collect(),
        ..Desc::default()
    };
    vec![Desc {
        style: Style {
            flex_direction: FlexDirection::Column,
            width: Dimension::Px(40.0),
            height: Dimension::Px(100.0),
            overflow: Overflow::Scroll,
            ..Style::default()
        },
        key: Some("scroller".into()),
        children: (0..count).map(row).collect(),
        ..Desc::default()
    }]
}

fn scroll_on_screen(tree: &mut Tree, position: f32) {
    let id = tree.find("scroller").unwrap();
    tree.scroll_state_mut(id).unwrap().position = position;
    tree.mark_place();
    assert!(tree.dirty());
    tree.flush_layout(&mut crate::tests::fonts(), 16.0);
}

fn point_at(tree: &Tree, id: NodeId, offset: usize, fonts: &[pixel_core::fonts::Font]) -> (f32, f32) {
    let geometry = tree.text_geometry(id).unwrap();
    let text = tree.text_of(id).unwrap();
    let rect = geometry.caret_rect(text, &[], offset, fonts);
    (rect.x + 0.1, rect.y + 1.0)
}

fn catch_up(tree: &mut Tree) {
    let fonts = crate::tests::fonts();
    while tree.rows_pending() {
        tree.catch_up_rows(&fonts, Instant::now() + std::time::Duration::from_secs(1));
        tree.flush_layout(&mut crate::tests::fonts(), 16.0);
    }
}

fn labels(a: &str, b: &str) -> Vec<Desc> {
    vec![Desc {
        style: Style {
            flex_direction: FlexDirection::Column,
            align_items: Some(Align::Start),
            ..Style::default()
        },
        children: label_items(a, b),
        ..Desc::default()
    }]
}

fn label_items(a: &str, b: &str) -> Vec<Desc> {
    vec![
        Desc {
            key: Some("a".into()),
            text: Some(a.into()),
            ..Desc::default()
        },
        Desc {
            key: Some("b".into()),
            text: Some(b.into()),
            ..Desc::default()
        },
    ]
}

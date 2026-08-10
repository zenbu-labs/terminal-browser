use super::*;
use crate::canvas::Canvas;
use crate::desc::Desc;
use crate::paint::paint;
use crate::style::{Align, Border, BorderSide, Edges, Position};

static FONT_BYTES: &[u8] =
    include_bytes!("../../../../assets/fonts/JetBrainsMono-Regular.ttf");

fn font() -> fontdue::Font {
    fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap()
}

fn tree_of(window: (f32, f32), children: Vec<Desc>) -> Tree {
    let mut tree = Tree::new(window);
    tree.reconcile(Desc {
        children,
        ..Desc::default()
    });
    tree.flush_layout(&[font()], 16.0);
    tree
}

fn painted(tree: &mut Tree, window: (u32, u32), cursor: Option<(f32, f32)>) -> Canvas {
    let mut canvas = Canvas::new(window.0, window.1);
    tree.flush_layout(&[font()], 16.0);
    paint(tree, &mut canvas, &[font()], cursor, None);
    canvas
}

fn pixel(canvas: &Canvas, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * canvas.width + x) * 4) as usize;
    canvas.pixels[i..i + 4].try_into().unwrap()
}

#[test]
fn hit_click_prefers_the_topmost_clickable_and_falls_back_to_ancestors() {
    let tree = tree_of(
        (200.0, 100.0),
        vec![Desc {
            style: Style {
                width: Dimension::Px(200.0),
                height: Dimension::Px(100.0),
                padding: Edges::all(10.0),
                ..Style::default()
            },
            key: Some("outer".into()),
            clickable: true,
            children: vec![Desc {
                style: Style {
                    width: Dimension::Px(50.0),
                    height: Dimension::Px(50.0),
                    ..Style::default()
                },
                key: Some("inner".into()),
                clickable: true,
                ..Desc::default()
            }],
            ..Desc::default()
        }],
    );
    let hit = tree.hit_click(15.0, 15.0).unwrap();
    assert_eq!(tree.key_of(hit), Some("inner"));
    let hit = tree.hit_click(150.0, 50.0).unwrap();
    assert_eq!(tree.key_of(hit), Some("outer"));
    assert!(tree.hit_click(500.0, 500.0).is_none());
}

#[test]
fn pointer_hit_prefers_the_topmost_pointer_surface() {
    let mut tree = Tree::new((200.0, 100.0));
    let bottom = tree.create(Props {
        style: Style {
            width: Dimension::Px(200.0),
            height: Dimension::Px(100.0),
            ..Style::default()
        },
        pointer_events: true,
        ..Props::default()
    });
    let top = tree.create(Props {
        style: Style {
            position: Position::Absolute,
            width: Dimension::Px(50.0),
            height: Dimension::Px(50.0),
            ..Style::default()
        },
        pointer_events: true,
        ..Props::default()
    });
    tree.append(tree.root(), bottom);
    tree.append(tree.root(), top);
    tree.flush_layout(&[font()], 16.0);
    assert_eq!(tree.hit_pointer(10.0, 10.0), Some(top));
    assert_eq!(tree.hit_pointer(100.0, 50.0), Some(bottom));
}

#[test]
fn exposes_rects_by_key_and_paints_background() {
    let mut tree = tree_of(
        (100.0, 40.0),
        vec![Desc {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(40.0),
                background: Some([10, 20, 30, 255]),
                ..Style::default()
            },
            key: Some("panel".into()),
            ..Desc::default()
        }],
    );
    let rect = tree.rect(tree.find("panel").unwrap()).unwrap();
    assert_eq!((rect.w, rect.h), (100.0, 40.0));
    assert!(tree.find("missing").is_none());
    let canvas = painted(&mut tree, (100, 40), None);
    assert_eq!(pixel(&canvas, 12, 0), [10, 20, 30, 255]);
}

#[test]
fn hover_swaps_background_under_cursor() {
    let block = || Desc {
        style: Style {
            width: Dimension::Px(10.0),
            height: Dimension::Px(10.0),
            background: Some([1, 1, 1, 255]),
            hover_background: Some([9, 9, 9, 255]),
            ..Style::default()
        },
        ..Desc::default()
    };
    let mut tree = tree_of((10.0, 10.0), vec![block()]);
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
            background: Some(color),
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
fn scroll_area_reports_overflowing_content() {
    let tree = tree_of((40.0, 40.0), scroller(false));
    let id = tree.find("scroller").unwrap();
    let area = tree.scroll_area(id).unwrap();
    assert_eq!(area.content_height, 80.0);
    assert_eq!(area.max_scroll(), 40.0);
    assert!(tree.scroll_area_at(5.0, 5.0).is_some());
    assert!(tree.scroll_area_at(100.0, 5.0).is_none());
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
fn scrolled_out_children_do_not_take_clicks() {
    let tree = tree_of((40.0, 40.0), scroller(true));
    assert!(
        tree.hit_click(5.0, 35.0).is_none(),
        "second block starts below the viewport"
    );

    let mut tree = tree_of((40.0, 40.0), scroller(true));
    let id = tree.find("scroller").unwrap();
    tree.scroll_state_mut(id).unwrap().position = 40.0;
    tree.mark_place();
    tree.flush_layout(&[font()], 16.0);
    let hit = tree.hit_click(5.0, 35.0).unwrap();
    assert_eq!(
        tree.key_of(hit),
        Some("green"),
        "fully scrolled, second block fills the viewport"
    );
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
                    inset: crate::style::Inset::top_left(30.0, 40.0),
                    width: Dimension::Px(20.0),
                    height: Dimension::Px(10.0),
                    background: Some([9, 9, 9, 255]),
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

#[test]
fn input_nodes_paint_caret_and_selection_and_expose_geometry() {
    let mut tree = tree_of((200.0, 60.0), editor("hello"));
    let id = tree.find("in").unwrap();
    tree.set_focus(Some(id));
    tree.input_mut(id).unwrap().set_cursor(2, false);
    tree.mark_paint();

    let geometry = tree.input_geometry(id).unwrap();
    assert_eq!(geometry.origin, (4.0, 4.0), "origin is inside the padding");
    let fonts = [font()];
    let caret = geometry.caret_rect("hello", &[], 2, &fonts);
    let canvas = painted(&mut tree, (200, 60), None);
    let center = (
        (caret.x + caret.w / 2.0) as u32,
        (caret.y + caret.h / 2.0) as u32,
    );
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
fn input_submit_prop_tracks_updates() {
    let mut tree = tree_of((200.0, 60.0), editor("hello"));
    let id = tree.find("in").unwrap();
    assert!(!tree.get(id).unwrap().input.as_ref().unwrap().submit);

    let mut children = editor("hello");
    children[0].children[0].input.as_mut().unwrap().submit = true;
    tree.reconcile(Desc {
        children,
        ..Desc::default()
    });
    let id = tree.find("in").unwrap();
    assert!(tree.get(id).unwrap().input.as_ref().unwrap().submit);
}

#[test]
fn caret_only_paints_on_the_focused_input() {
    let mut tree = tree_of((200.0, 60.0), editor("hello"));
    let id = tree.find("in").unwrap();
    tree.input_mut(id).unwrap().set_cursor(2, false);
    tree.mark_paint();
    let geometry = tree.input_geometry(id).unwrap();
    let caret = geometry.caret_rect("hello", &[], 2, &[font()]);
    let canvas = painted(&mut tree, (200, 60), None);
    let [r, g, b, _] = pixel(
        &canvas,
        (caret.x + caret.w / 2.0) as u32,
        (caret.y + caret.h / 2.0) as u32,
    );
    assert_ne!([r, g, b], [255, 0, 0], "no caret without focus");
}

#[test]
fn scroll_reveal_targets_the_nearest_edge() {
    let tree = tree_of((40.0, 40.0), scroller(false));
    let area = ScrollArea {
        node: tree.find("scroller").unwrap(),
        rect: PxRect {
            x: 0.0,
            y: 100.0,
            w: 100.0,
            h: 50.0,
        },
        content_height: 500.0,
        offset: 20.0,
    };
    let rect = |y: f32| PxRect {
        x: 0.0,
        y,
        w: 2.0,
        h: 10.0,
    };
    assert_eq!(area.target_to_reveal(rect(90.0), 20.0, 0.0), Some(10.0));
    assert_eq!(area.target_to_reveal(rect(110.0), 20.0, 0.0), None);
    assert_eq!(area.target_to_reveal(rect(160.0), 20.0, 0.0), Some(40.0));
    assert_eq!(area.target_to_reveal(rect(110.0), 20.0, 15.0), Some(15.0));
}

#[test]
fn text_leaves_size_the_layout() {
    let tree = tree_of(
        (400.0, 100.0),
        vec![Desc {
            key: Some("label".into()),
            text: Some("hello".into()),
            ..Desc::default()
        }],
    );
    let label = tree.rect(tree.find("label").unwrap()).unwrap();
    assert!(label.w > 0.0 && label.h > 0.0);
}

#[test]
fn updating_text_relayouts_the_leaf() {
    let mut tree = tree_of(
        (400.0, 100.0),
        vec![Desc {
            key: Some("label".into()),
            text: Some("hi".into()),
            ..Desc::default()
        }],
    );
    let id = tree.find("label").unwrap();
    let before = tree.rect(id).unwrap();
    tree.reconcile(Desc {
        children: vec![Desc {
            key: Some("label".into()),
            text: Some("hello there, much longer".into()),
            ..Desc::default()
        }],
        ..Desc::default()
    });
    tree.flush_layout(&[font()], 16.0);
    let after = tree.rect(id).unwrap();
    assert!(after.w > before.w, "{} > {}", after.w, before.w);
}

#[test]
fn reconcile_reuses_keyed_nodes_and_preserves_input_state() {
    let item = |key: &str| Desc {
        key: Some(key.into()),
        input: Some(InputProps {
            initial: format!("initial-{key}"),
            ..InputProps::default()
        }),
        ..Desc::default()
    };
    let mut tree = tree_of((400.0, 100.0), vec![item("a"), item("b")]);
    let a = tree.find("a").unwrap();
    tree.input_mut(a).unwrap().insert(" typed");
    tree.sync_input_text(a);

    // Reorder: b first. The keyed node must survive with its edits.
    tree.reconcile(Desc {
        children: vec![item("b"), item("a")],
        ..Desc::default()
    });
    assert_eq!(tree.find("a"), Some(a), "node reused, not recreated");
    assert_eq!(tree.input_text(a), Some("initial-a typed"));
    let root = tree.root();
    assert_eq!(tree.children(root).len(), 2);
    assert_eq!(tree.key_of(tree.children(root)[0]), Some("b"));
}

#[test]
fn reconcile_drops_nodes_missing_from_the_description() {
    let label = |key: &str| Desc {
        key: Some(key.into()),
        text: Some(key.into()),
        ..Desc::default()
    };
    let mut tree = tree_of((400.0, 100.0), vec![label("a"), label("b"), label("c")]);
    let b = tree.find("b").unwrap();
    tree.reconcile(Desc {
        children: vec![label("a"), label("c")],
        ..Desc::default()
    });
    assert!(tree.find("b").is_none());
    assert!(!tree.contains(b), "stale ids are dead");
    assert_eq!(tree.children(tree.root()).len(), 2);
}

#[test]
fn removed_ids_stay_dead_after_slot_reuse() {
    let mut tree = Tree::new((100.0, 100.0));
    let a = tree.create(Props::default());
    tree.append(tree.root(), a);
    tree.remove(a);
    let b = tree.create(Props::default());
    tree.append(tree.root(), b);
    assert!(!tree.contains(a), "generation bump kills the old id");
    assert!(tree.contains(b));
}

#[test]
fn queries_between_removal_and_flush_skip_dead_ids() {
    let mut tree = tree_of(
        (100.0, 100.0),
        vec![Desc {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(100.0),
                overflow: Overflow::Scroll,
                ..Style::default()
            },
            key: Some("gone".into()),
            clickable: true,
            ..Desc::default()
        }],
    );
    tree.reconcile(Desc::default());
    // No flush yet: the paint lists still hold the removed id.
    assert!(tree.hit_click(50.0, 50.0).is_none());
    assert!(tree.hover_at(50.0, 50.0).is_none());
    assert!(tree.hit_target(50.0, 50.0).is_none());
    assert!(tree.scroll_area_at(50.0, 50.0).is_none());
}

#[test]
fn percent_inset_anchors_to_the_parent_edge() {
    let tree = tree_of(
        (100.0, 100.0),
        vec![Desc {
            style: Style {
                margin: Edges {
                    left: 10.0,
                    top: 50.0,
                    ..Edges::default()
                },
                width: Dimension::Px(20.0),
                height: Dimension::Px(10.0),
                ..Style::default()
            },
            key: Some("trigger".into()),
            children: vec![Desc {
                style: Style {
                    position: Position::Absolute,
                    inset: crate::style::Inset {
                        left: Some(crate::style::InsetValue::Px(0.0)),
                        bottom: Some(crate::style::InsetValue::Percent(1.0)),
                        ..crate::style::Inset::default()
                    },
                    width: Dimension::Px(30.0),
                    height: Dimension::Px(40.0),
                    ..Style::default()
                },
                key: Some("menu".into()),
                ..Desc::default()
            }],
            ..Desc::default()
        }],
    );
    let rect = tree.rect(tree.find("menu").unwrap()).unwrap();
    assert_eq!(
        (rect.x, rect.y, rect.w, rect.h),
        (10.0, 10.0, 30.0, 40.0),
        "bottom: 100% puts the menu's bottom edge at the trigger's top"
    );
}

#[test]
fn outside_click_targets_report_flagged_nodes_not_containing_the_point() {
    let mut tree = Tree::new((100.0, 100.0));
    let id = tree.create(Props {
        style: Style {
            position: Position::Absolute,
            inset: crate::style::Inset::top_left(30.0, 40.0),
            width: Dimension::Px(20.0),
            height: Dimension::Px(10.0),
            ..Style::default()
        },
        outside_click_events: true,
        ..Props::default()
    });
    tree.append(tree.root(), id);
    tree.flush_layout(&[font()], 16.0);
    assert!(tree.outside_click_targets(35.0, 45.0).is_empty());
    assert_eq!(tree.outside_click_targets(5.0, 5.0), vec![id]);
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
    let cell = crate::canvas::measure_text(&font(), "X", 16.0).ceil() as u32;
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
    let cell = crate::canvas::measure_text(&font(), "X", 16.0).floor() as u32;
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
fn overlays_occlude_inputs_from_clicks() {
    let mut children = editor("hello");
    children[0].style.overflow = Overflow::Scroll;
    children.push(Desc {
        style: Style {
            position: Position::Absolute,
            inset: crate::style::Inset::top_left(10.0, 10.0),
            width: Dimension::Px(40.0),
            height: Dimension::Px(20.0),
            ..Style::default()
        },
        key: Some("overlay".into()),
        clickable: true,
        ..Desc::default()
    });
    let tree = tree_of((200.0, 60.0), children);
    let overlay = tree.find("overlay").unwrap();
    let input = tree.find("in").unwrap();
    assert_eq!(tree.hit_target(15.0, 15.0), Some(HitTarget::Click(overlay)));
    assert_eq!(tree.hit_target(8.0, 8.0), Some(HitTarget::Input(input)));
    // Past the text but inside the scroll viewport: still the input.
    assert_eq!(tree.hit_target(150.0, 50.0), Some(HitTarget::Input(input)));
}

#[test]
fn dropping_input_props_clears_focus() {
    let mut tree = tree_of((200.0, 60.0), editor("hello"));
    let id = tree.find("in").unwrap();
    tree.set_focus(Some(id));
    assert_eq!(tree.focus(), Some(id));
    tree.update(
        id,
        Props {
            key: Some("in".into()),
            text: Some("plain".into()),
            ..Props::default()
        },
    );
    assert_eq!(tree.focus(), None, "focus cannot point at a non-input");
}

#[test]
fn shrinking_content_clamps_the_scroll_position() {
    let mut tree = tree_of((40.0, 40.0), scroller(false));
    let id = tree.find("scroller").unwrap();
    let state = tree.scroll_state_mut(id).unwrap();
    state.position = 40.0;
    state.set_target(40.0);
    tree.mark_place();
    tree.flush_layout(&[font()], 16.0);
    assert_eq!(tree.scroll_state(id).unwrap().position, 40.0);

    // Drop the second block: content now fits, so scroll snaps to 0.
    let mut desc = scroller(false);
    desc[0].children.truncate(1);
    tree.reconcile(Desc {
        children: desc,
        ..Desc::default()
    });
    tree.flush_layout(&[font()], 16.0);
    let state = tree.scroll_state(id).unwrap();
    assert_eq!(state.position, 0.0);
    assert_eq!(state.target, 0.0);
}

#[test]
fn hidden_nodes_zero_their_rects() {
    let mut tree = tree_of(
        (100.0, 100.0),
        vec![Desc {
            style: Style {
                width: Dimension::Px(50.0),
                height: Dimension::Px(50.0),
                ..Style::default()
            },
            key: Some("panel".into()),
            ..Desc::default()
        }],
    );
    let id = tree.find("panel").unwrap();
    assert_eq!(tree.rect(id).unwrap().w, 50.0);
    let mut props = Props {
        key: Some("panel".into()),
        hidden: true,
        ..Props::default()
    };
    props.style.width = Dimension::Px(50.0);
    props.style.height = Dimension::Px(50.0);
    tree.update(id, props);
    tree.flush_layout(&[font()], 16.0);
    assert_eq!(tree.rect(id), Some(PxRect::ZERO));
}

#[test]
fn content_height_overrides_measured_scroll_range() {
    let mut tree = tree_of(
        (100.0, 200.0),
        vec![Desc {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(200.0),
                overflow: Overflow::Scroll,
                ..Style::default()
            },
            key: Some("virtual".into()),
            content_height: Some(800.0),
            children: vec![Desc {
                style: Style {
                    height: Dimension::Px(30.0),
                    flex_shrink: 0.0,
                    ..Style::default()
                },
                ..Desc::default()
            }],
            ..Desc::default()
        }],
    );
    let id = tree.find("virtual").unwrap();
    assert_eq!(
        tree.scroll_max(id),
        600.0,
        "virtual height wins over measured"
    );

    let rects = tree.scrollbar_rects(id).unwrap();
    let expected_thumb = rects.track.h * 200.0 / 800.0;
    assert!(
        (rects.thumb.h - expected_thumb).abs() < 0.5,
        "thumb is viewport/content of the track: {} vs {expected_thumb}",
        rects.thumb.h
    );
    assert_eq!(
        rects.thumb.y, rects.track.y,
        "unscrolled thumb sits at the top"
    );

    tree.scroll_state_mut(id).unwrap().position = 600.0;
    let rects = tree.scrollbar_rects(id).unwrap();
    assert!(
        (rects.thumb.y + rects.thumb.h - (rects.track.y + rects.track.h)).abs() < 0.5,
        "fully scrolled thumb reaches the bottom"
    );
    assert_eq!(
        tree.scroll_pos_for_thumb(id, rects.track.y).unwrap(),
        0.0,
        "thumb position maps back to scroll offsets"
    );
}

#[test]
fn scrollbar_rects_absent_without_overflow() {
    let tree = tree_of(
        (100.0, 200.0),
        vec![Desc {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(200.0),
                overflow: Overflow::Scroll,
                ..Style::default()
            },
            key: Some("fits".into()),
            children: vec![Desc {
                style: Style {
                    height: Dimension::Px(30.0),
                    flex_shrink: 0.0,
                    ..Style::default()
                },
                ..Desc::default()
            }],
            ..Desc::default()
        }],
    );
    let id = tree.find("fits").unwrap();
    assert!(tree.scrollbar_rects(id).is_none(), "no overflow, no bar");
}

#[test]
fn wrapped_text_grows_taller_as_width_shrinks() {
    let label = |width: f32| {
        vec![Desc {
            style: Style {
                width: Dimension::Px(width),
                align_items: Some(Align::Start),
                ..Style::default()
            },
            children: vec![Desc {
                key: Some("p".into()),
                text: Some("several words that will need to wrap around".into()),
                ..Desc::default()
            }],
            ..Desc::default()
        }]
    };
    let wide = tree_of((400.0, 400.0), label(380.0));
    let narrow = tree_of((400.0, 400.0), label(120.0));
    let wide_h = wide.rect(wide.find("p").unwrap()).unwrap().h;
    let narrow_h = narrow.rect(narrow.find("p").unwrap()).unwrap().h;
    assert!(
        narrow_h >= wide_h * 2.0 - 0.5,
        "narrow wraps to more lines: {narrow_h} vs {wide_h}"
    );

    let mut nowrap = label(120.0);
    nowrap[0].children[0].style.wrap = false;
    let pre = tree_of((400.0, 400.0), nowrap);
    let pre_h = pre.rect(pre.find("p").unwrap()).unwrap().h;
    assert!(
        pre_h < wide_h,
        "wrap: false keeps one logical line: {pre_h} vs {wide_h}"
    );
}

#[test]
fn soft_wrapped_input_maps_offsets_through_wrap_boundaries() {
    let mut editor = editor("alpha beta gamma delta epsilon zeta");
    editor[0].style.width = Dimension::Px(120.0);
    editor[0].children[0].style.width = Dimension::Px(120.0);
    let tree = tree_of((400.0, 300.0), editor);
    let id = tree.find("in").unwrap();
    let geometry = tree.input_geometry(id).unwrap();
    let width = geometry.max_width.expect("wrapping on by default");
    assert!(width <= 120.0);

    let fonts = [font()];
    let text = "alpha beta gamma delta epsilon zeta";
    let last = geometry.caret_rect(text, &[], text.len(), &fonts);
    let first = geometry.caret_rect(text, &[], 0, &fonts);
    assert!(
        last.y > first.y,
        "caret wraps to later visual lines: {} > {}",
        last.y,
        first.y
    );
    let round_trip = geometry.offset_at(text, &[], (last.x + 0.1, last.y + 1.0), &fonts);
    assert_eq!(round_trip, text.len(), "click maps back through the wrap");
}

#[test]
fn flex_basis_zero_keeps_siblings_stable_as_text_grows() {
    let build = |text: &str, basis: Dimension| {
        vec![
            Desc {
                style: Style {
                    width: Dimension::Px(200.0),
                    ..Style::default()
                },
                key: Some("side".into()),
                ..Desc::default()
            },
            Desc {
                style: Style {
                    flex_grow: 1.0,
                    flex_basis: basis,
                    overflow: Overflow::Hidden,
                    ..Style::default()
                },
                children: vec![Desc {
                    text: Some(text.into()),
                    ..Desc::default()
                }],
                ..Desc::default()
            },
        ]
    };
    let long = "no spaces here just one enormous line of text ".repeat(40);

    let tree = tree_of((800.0, 200.0), build(&long, Dimension::Px(0.0)));
    let side = tree.rect(tree.find("side").unwrap()).unwrap();
    assert_eq!(side.w, 200.0, "flex: 1 sibling never squeezes the sidebar");

    let tree = tree_of((800.0, 200.0), build(&long, Dimension::Auto));
    let side = tree.rect(tree.find("side").unwrap()).unwrap();
    assert!(
        side.w < 200.0,
        "basis auto grows with content and squeezes: {}",
        side.w
    );
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

fn point_at(tree: &Tree, id: NodeId, offset: usize, fonts: &[fontdue::Font]) -> (f32, f32) {
    let geometry = tree.text_geometry(id).unwrap();
    let text = tree.text_of(id).unwrap();
    let rect = geometry.caret_rect(text, &[], offset, fonts);
    (rect.x + 0.1, rect.y + 1.0)
}

#[test]
fn doc_selection_spans_text_nodes() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("first line", "second line"));
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    assert!(tree.doc_select_down(point_at(&tree, a, 6, &fonts), &fonts));
    tree.doc_select_drag(point_at(&tree, b, 6, &fonts), &fonts);
    tree.doc_select_up();
    assert_eq!(tree.doc_selection_range(a), Some(6..10));
    assert_eq!(tree.doc_selection_range(b), Some(0..6));
    assert_eq!(tree.doc_selected_text().as_deref(), Some("line\nsecond"));
}

#[test]
fn backwards_drags_normalize_by_document_order() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("first line", "second line"));
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    assert!(tree.doc_select_down(point_at(&tree, b, 6, &fonts), &fonts));
    tree.doc_select_drag(point_at(&tree, a, 6, &fonts), &fonts);
    assert_eq!(tree.doc_selection_range(a), Some(6..10));
    assert_eq!(tree.doc_selection_range(b), Some(0..6));
}

#[test]
fn chained_clicks_on_text_select_word_then_line() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("foo bar baz", "x"));
    let a = tree.find("a").unwrap();
    let point = point_at(&tree, a, 5, &fonts);
    assert!(tree.doc_select_down(point, &fonts));
    assert_eq!(tree.doc_selection_range(a), None, "single click places");
    tree.doc_select_down(point, &fonts);
    assert_eq!(tree.doc_selected_text().as_deref(), Some("bar"));
    tree.doc_select_down(point, &fonts);
    assert_eq!(tree.doc_selected_text().as_deref(), Some("foo bar baz"));
}

#[test]
fn clickable_and_optout_subtrees_are_not_selectable() {
    let mut children = label_items("copy me", "label");
    children[1] = Desc {
        key: Some("button".into()),
        clickable: true,
        children: vec![Desc {
            key: Some("b".into()),
            text: Some("label".into()),
            ..Desc::default()
        }],
        ..Desc::default()
    };
    children.push(Desc {
        style: Style {
            selectable: Some(false),
            ..Style::default()
        },
        children: vec![Desc {
            key: Some("c".into()),
            text: Some("locked".into()),
            ..Desc::default()
        }],
        ..Desc::default()
    });
    let mut tree = tree_of((400.0, 200.0), children);
    let fonts = [font()];
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    let c = tree.find("c").unwrap();
    let at = |tree: &Tree, id| point_at(tree, id, 1, &fonts);
    let p = at(&tree, a);
    assert_eq!(tree.hit_target(p.0, p.1), Some(HitTarget::Text(a)));
    let button = tree.find("button").unwrap();
    let p = at(&tree, b);
    assert_eq!(
        tree.hit_target(p.0, p.1),
        Some(HitTarget::Click(button)),
        "the clickable ancestor still owns the click"
    );
    assert!(
        tree.doc_select_down(p, &fonts),
        "but its label still takes a selection gesture"
    );
    let p = at(&tree, c);
    assert_eq!(
        tree.hit_target(p.0, p.1),
        None,
        "selectable: false opts the subtree out"
    );
    assert!(!tree.doc_select_down(p, &fonts));
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
fn structural_changes_drop_the_doc_selection() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
    tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);
    assert!(tree.doc_selected_text().is_some());
    tree.remove(b);
    assert!(tree.doc_selection().is_none(), "endpoint removal clears");

    let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
    tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);
    tree.update(
        a,
        Props {
            key: Some("a".into()),
            text: Some("rewritten".into()),
            ..Props::default()
        },
    );
    assert!(tree.doc_selection().is_none(), "text change clears");
}

#[test]
fn shift_arrows_extend_the_selection_across_nodes() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("ab", "cd"));
    let a = tree.find("a").unwrap();
    tree.doc_select_down(point_at(&tree, a, 2, &fonts), &fonts);
    assert!(tree.doc_extend(false, Granularity::Char), "cross into b");
    assert!(tree.doc_extend(false, Granularity::Char));
    assert_eq!(tree.doc_selected_text().as_deref(), Some("c"));
    assert!(tree.doc_extend(true, Granularity::Char));
    assert!(
        tree.doc_extend(true, Granularity::Char),
        "cross back into a"
    );
    assert_eq!(tree.doc_selected_text(), None, "shrunk to the anchor");
    assert!(tree.doc_extend(true, Granularity::Word));
    assert_eq!(tree.doc_selected_text().as_deref(), Some("ab"));
}

#[test]
fn vertical_extension_crosses_into_the_next_node() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("one\ntwo", "three"));
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
    assert!(
        tree.doc_extend_vertical(false, &fonts),
        "into a's second line"
    );
    assert_eq!(tree.doc_selection_range(b), None);
    assert!(tree.doc_extend_vertical(false, &fonts), "into b");
    assert!(tree.doc_selection_range(b).is_some());
    assert!(tree.doc_extend_edge(true));
    assert_eq!(
        tree.doc_selected_text().as_deref(),
        Some("o"),
        "cmd+shift+up reaches the document start"
    );
}

#[test]
fn select_all_joins_rows_with_newlines_but_not_columns() {
    let mut tree = tree_of((400.0, 200.0), labels("ab", "cd"));
    assert!(tree.doc_select_all());
    assert_eq!(tree.doc_selected_text().as_deref(), Some("ab\ncd"));

    let mut tree = tree_of(
        (400.0, 200.0),
        vec![Desc {
            style: Style {
                flex_direction: FlexDirection::Row,
                ..Style::default()
            },
            children: label_items("ab", "cd"),
            ..Desc::default()
        }],
    );
    assert!(tree.doc_select_all());
    assert_eq!(
        tree.doc_selected_text().as_deref(),
        Some("abcd"),
        "same visual row concatenates"
    );
}

#[test]
fn programmatic_focus_keeps_the_doc_selection() {
    let fonts = [font()];
    let mut children = editor("hello");
    children.extend(labels("pick", "me"));
    let mut tree = tree_of((400.0, 200.0), children);
    let a = tree.find("a").unwrap();
    tree.doc_select_down(point_at(&tree, a, 0, &fonts), &fonts);
    tree.doc_select_drag(point_at(&tree, a, 4, &fonts), &fonts);
    assert_eq!(tree.doc_selected_text().as_deref(), Some("pick"));
    // An app refocusing its composer on stray keys must not eat the
    // selection out from under a pending copy.
    tree.set_focus(Some(tree.find("in").unwrap()));
    assert_eq!(tree.doc_selected_text().as_deref(), Some("pick"));
}

#[test]
fn drags_can_start_in_empty_space() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    let rect = tree.rect(b).unwrap();
    // The x of an outside press must not pick a column: below means
    // the end of the text, above means the beginning.
    let below = (rect.x + 2.0, rect.y + rect.h + 40.0);
    assert!(!tree.doc_select_down(below, &fonts), "no text under point");
    assert!(tree.doc_select_down_near(below, &fonts));
    assert_eq!(
        tree.doc_selected_text(),
        None,
        "click alone selects nothing"
    );
    tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);
    assert_eq!(tree.doc_selected_text().as_deref(), Some("ond"));

    let a_rect = tree.rect(a).unwrap();
    let above = (a_rect.x + a_rect.w - 2.0, a_rect.y - 20.0);
    assert!(tree.doc_select_down_near(above, &fonts));
    tree.doc_select_drag(point_at(&tree, a, 2, &fonts), &fonts);
    assert_eq!(tree.doc_selected_text().as_deref(), Some("fi"));
}

#[test]
fn an_outside_click_dismisses_the_selection_and_repaints() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
    let a = tree.find("a").unwrap();
    tree.doc_select_down(point_at(&tree, a, 0, &fonts), &fonts);
    tree.doc_select_drag(point_at(&tree, a, 5, &fonts), &fonts);
    tree.doc_select_up();
    assert_eq!(tree.doc_selected_text().as_deref(), Some("first"));
    tree.flush_layout(&[font()], 16.0);
    tree.clear_paint_flag();

    let rect = tree.rect(a).unwrap();
    assert!(tree.doc_select_down_near((rect.x, rect.y + 150.0), &fonts));
    assert_eq!(tree.doc_selected_text(), None);
    assert!(tree.dirty(), "the stale highlight must repaint away");
}

#[test]
fn selection_stays_inside_the_scroll_container_it_started_in() {
    let fonts = [font()];
    let column = |key: &str, text_a: &str, text_b: &str| Desc {
        key: Some(key.into()),
        style: Style {
            flex_direction: FlexDirection::Column,
            flex_grow: 1.0,
            flex_basis: Dimension::Px(0.0),
            overflow: crate::style::Overflow::Scroll,
            align_items: Some(Align::Start),
            ..Style::default()
        },
        children: vec![
            Desc {
                key: Some(format!("{key}-a")),
                text: Some(text_a.into()),
                ..Desc::default()
            },
            Desc {
                key: Some(format!("{key}-b")),
                text: Some(text_b.into()),
                ..Desc::default()
            },
        ],
        ..Desc::default()
    };
    let mut tree = tree_of(
        (400.0, 200.0),
        vec![
            column("left", "chat message", "another"),
            column("right", "panel title", "panel body"),
        ],
    );
    let right_a = tree.find("right-a").unwrap();
    let left_a = tree.find("left-a").unwrap();
    tree.doc_select_down(point_at(&tree, right_a, 2, &fonts), &fonts);
    // drag to a point over the LEFT column; the selection must not follow
    let left_rect = tree.rect(left_a).unwrap();
    tree.doc_select_drag((left_rect.x + 2.0, left_rect.y + left_rect.h + 30.0), &fonts);
    let selected = tree.doc_selected_text().unwrap_or_default();
    assert!(
        !selected.contains("chat") && !selected.contains("another"),
        "selection leaked into the other scroll container: {selected:?}"
    );
    assert!(selected.contains("nel"), "selection extends within its own container: {selected:?}");

    // clicking empty space in the LEFT column must not adopt right-column text,
    // even when a right-column node is geometrically nearer
    tree.doc_collapse();
    let left_rect = tree.rect(left_a).unwrap();
    let empty = (left_rect.x + left_rect.w + 20.0, left_rect.y + 2.0);
    if !tree.doc_select_down(empty, &fonts) {
        tree.doc_select_down_near(empty, &fonts);
    }
    tree.doc_select_drag((left_rect.x, left_rect.y + 60.0), &fonts);
    let selected = tree.doc_selected_text().unwrap_or_default();
    assert!(
        !selected.contains("panel"),
        "empty-space click adopted the other container: {selected:?}"
    );
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
fn unified_selection_on_one_line_is_a_single_tight_band() {
    let fonts = [font()];
    let mut tree = tree_of(
        (400.0, 200.0),
        vec![Desc {
            style: Style {
                flex_direction: FlexDirection::Row,
                gap: 12.0,
                selection_mode: SelectionMode::Unified,
                ..Style::default()
            },
            children: label_items("ab", "cd"),
            ..Desc::default()
        }],
    );
    let a = tree.find("a").unwrap();
    let b = tree.find("b").unwrap();
    tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
    tree.doc_select_drag(point_at(&tree, b, 1, &fonts), &fonts);
    let blocks = tree.doc_selection_blocks(&fonts);
    let (_, bands, _) = blocks.first().cloned().unwrap();
    assert_eq!(bands.len(), 1);
    let a_rect = tree.rect(a).unwrap();
    let b_rect = tree.rect(b).unwrap();
    assert!(bands[0].x > a_rect.x && bands[0].x + bands[0].w < b_rect.x + b_rect.w);
    assert!(
        bands[0].x + bands[0].w > b_rect.x,
        "the inter-node gap is inside the band"
    );
}

#[test]
fn selections_without_a_unified_ancestor_have_no_bands() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
    let a = tree.find("a").unwrap();
    tree.doc_select_down(point_at(&tree, a, 0, &fonts), &fonts);
    tree.doc_select_drag(point_at(&tree, a, 4, &fonts), &fonts);
    assert!(tree.doc_selected_text().is_some());
    assert!(tree.doc_selection_blocks(&fonts).is_empty());
}

#[test]
fn blocks_render_even_when_the_selection_starts_outside() {
    let fonts = [font()];
    let mut wrap = labels("first", "second");
    wrap[0].style.selection_mode = SelectionMode::Unified;
    wrap[0].key = Some("wrap".into());
    let children = vec![Desc {
        style: Style {
            flex_direction: FlexDirection::Column,
            align_items: Some(Align::Start),
            ..Style::default()
        },
        children: {
            let mut kids = vec![Desc {
                key: Some("head".into()),
                text: Some("header line".into()),
                ..Desc::default()
            }];
            kids.append(&mut wrap);
            kids
        },
        ..Desc::default()
    }];
    let mut tree = tree_of((400.0, 200.0), children);
    let head = tree.find("head").unwrap();
    let b = tree.find("b").unwrap();
    tree.doc_select_down(point_at(&tree, head, 1, &fonts), &fonts);
    tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);

    let blocks = tree.doc_selection_blocks(&fonts);
    assert_eq!(blocks.len(), 1, "one block for the designated area");
    let (container, bands, _) = blocks.first().cloned().unwrap();
    assert_eq!(tree.key_of(container), Some("wrap"));
    let rect = tree.rect(container).unwrap();
    assert_eq!(
        bands[0].x, rect.x,
        "start outside the block clamps its first row to full width"
    );
    assert!(
        tree.doc_selection_range(head).is_some(),
        "text outside the block still selects tightly"
    );
}

#[test]
fn controlled_input_value_updates_are_undoable() {
    let mut tree = tree_of((400.0, 100.0), editor("hello"));
    let id = tree.find("in").unwrap();
    tree.set_input_text(id, "external");
    assert_eq!(tree.input_text(id), Some("external"));
    let input = tree.input_mut(id).unwrap();
    assert!(input.undo());
    assert_eq!(input.text(), "hello");
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
fn negative_margins_bleed_out_of_parent_padding() {
    let tree = tree_of(
        (200.0, 100.0),
        vec![Desc {
            style: Style {
                flex_direction: FlexDirection::Column,
                width: Dimension::Px(200.0),
                height: Dimension::Px(100.0),
                padding: Edges::all(20.0),
                ..Style::default()
            },
            children: vec![Desc {
                style: Style {
                    margin: Edges {
                        left: -20.0,
                        right: -20.0,
                        top: 0.0,
                        bottom: 0.0,
                    },
                    height: Dimension::Px(30.0),
                    ..Style::default()
                },
                key: Some("bleed".into()),
                ..Desc::default()
            }],
            ..Desc::default()
        }],
    );
    let rect = tree.rect(tree.find("bleed").unwrap()).unwrap();
    assert_eq!(rect.x, 0.0, "negative margin cancels the parent padding");
    assert_eq!(rect.w, 200.0, "row spans the full parent width");
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
                    background: Some([40, 40, 40, 255]),
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
                }),
                key: Some("img".into()),
                children: vec![Desc {
                    style: Style {
                        background: Some([50, 50, 50, 255]),
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

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !crate::image_cache::drain_completed().landed {
        assert!(std::time::Instant::now() < deadline, "decode never landed");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    tree.mark_place();
    let canvas = painted(&mut tree, (200, 100), None);
    assert_eq!(tree.rect(ph).unwrap(), PxRect::ZERO, "placeholder retires");
    assert_eq!(pixel(&canvas, 20, 10), [0, 200, 0, 255]);
}

#[test]
fn mark_widgets_reserve_width_and_place_inline() {
    let fonts = [font()];
    let mut tree = Tree::new((400.0, 100.0));
    let input = tree.create(Props {
        style: Style {
            width: Dimension::Px(300.0),
            ..Style::default()
        },
        input: Some(InputProps {
            initial: "ab".into(),
            ..InputProps::default()
        }),
        ..Props::default()
    });
    tree.append(tree.root(), input);
    tree.edit_input(input, |i| {
        i.set_cursor(1, false);
        i.insert_mark(5, None);
    });
    let widget = tree.create(Props {
        style: Style {
            width: Dimension::Px(40.0),
            height: Dimension::Px(10.0),
            ..Style::default()
        },
        mark: Some(5),
        ..Props::default()
    });
    tree.append(input, widget);
    tree.flush_layout(&fonts, 16.0);

    let geometry = tree.input_geometry(input).unwrap();
    let text = tree.input_text(input).unwrap().to_string();
    let marks = tree.input(input).unwrap().marks().to_vec();
    assert_eq!(marks[0].advance, 40.0, "widget width becomes the mark advance");

    let after = 1 + crate::text_input::MARK_CHAR.len_utf8();
    let before_caret = geometry.caret_rect(&text, &marks, 1, &fonts);
    let after_caret = geometry.caret_rect(&text, &marks, after, &fonts);
    assert!(
        (after_caret.x - before_caret.x - 40.0).abs() < 0.01,
        "caret crosses the widget: {} -> {}",
        before_caret.x,
        after_caret.x
    );

    let rect = tree.rect(widget).unwrap();
    assert!(
        (rect.x - before_caret.x).abs() < 0.5,
        "widget sits at the mark: {} vs {}",
        rect.x,
        before_caret.x
    );
    assert_eq!((rect.w, rect.h), (40.0, 10.0));

    tree.edit_input(input, |i| {
        i.set_cursor(after, false);
        i.delete_backward(Granularity::Char);
    });
    tree.flush_layout(&fonts, 16.0);
    assert_eq!(
        tree.rect(widget),
        Some(PxRect::ZERO),
        "widget hides once its sentinel is deleted"
    );

    tree.edit_input(input, |i| {
        assert!(i.undo());
    });
    tree.flush_layout(&fonts, 16.0);
    assert_eq!(
        tree.rect(widget).map(|r| r.w),
        Some(40.0),
        "undo restores the mark and the widget comes back"
    );
}

#[test]
fn static_text_marks_place_widgets_like_inputs() {
    let fonts = [font()];
    let mut tree = Tree::new((400.0, 100.0));
    let sentinel = crate::text_input::MARK_CHAR;
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
    tree.flush_layout(&fonts, 16.0);

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
    let widget_bg = painted_tree.find("w");
    let _ = widget_bg;
    painted_tree.update(
        widget,
        Props {
            style: Style {
                width: Dimension::Px(40.0),
                height: Dimension::Px(10.0),
                background: Some([200, 30, 30, 255]),
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

#[test]
fn failed_image_with_unknown_dims_occupies_a_square() {
    let fonts = [font()];
    let mut tree = Tree::new((300.0, 200.0));
    let row = tree.create(Props {
        style: Style {
            align_items: Some(Align::Start),
            ..Style::default()
        },
        ..Props::default()
    });
    tree.append(tree.root(), row);
    let image = tree.create(Props {
        style: Style {
            height: Dimension::Px(40.0),
            ..Style::default()
        },
        image: Some(ImageProps {
            src: "/nonexistent/never.png".into(),
            equal_to: Vec::new(),
        }),
        ..Props::default()
    });
    tree.append(row, image);
    tree.flush_layout(&fonts, 16.0);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !crate::image_cache::drain_completed().landed {
        assert!(std::time::Instant::now() < deadline, "decode never settled");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    tree.mark_layout();
    tree.flush_layout(&fonts, 16.0);
    let rect = tree.rect(image).unwrap();
    assert_eq!(
        (rect.w, rect.h),
        (40.0, 40.0),
        "failed image squares off its known dimension so the glyph shows"
    );
}

use super::*;
use crate::desc::Desc;
use crate::text_input::{MARK_CHAR, Mark};
use crate::style::{Align, Edges, Paint, Position};

static FONT_BYTES: &[u8] =
    include_bytes!("../../../../assets/fonts/JetBrainsMono-Regular.ttf");

fn font() -> crate::fonts::Font {
    crate::fonts::Font::single(fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap())
}

fn tree_of(window: (f32, f32), children: Vec<Desc>) -> Tree {
    let mut tree = Tree::new(window);
    tree.reconcile(Desc {
        children,
        ..Desc::default()
    });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    tree
}

fn decode_signal() -> std::sync::mpsc::Receiver<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    crate::image_cache::set_waker(move || {
        let _ = tx.send(());
    });
    rx
}

fn wait_for_decode(signal: &std::sync::mpsc::Receiver<()>) {
    signal
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("decode never landed");
    assert!(crate::image_cache::drain_completed().landed);
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
fn pointer_shape_resolves_explicit_shapes_then_inputs_then_selectable_text() {
    let sized = |x: f32, w: f32| Style {
        position: Position::Absolute,
        inset: crate::style::Inset {
            left: Some(crate::style::InsetValue::Px(x)),
            top: Some(crate::style::InsetValue::Px(0.0)),
            ..Default::default()
        },
        width: Dimension::Px(w),
        height: Dimension::Px(40.0),
        ..Style::default()
    };
    let label = |selectable: bool| Desc {
        text: Some("label".into()),
        style: Style {
            selectable: Some(selectable),
            ..Style::default()
        },
        ..Desc::default()
    };
    let tree = tree_of(
        (500.0, 100.0),
        vec![
            Desc {
                style: Style {
                    pointer_shape: Some("pointer".into()),
                    ..sized(0.0, 100.0)
                },
                clickable: true,
                children: vec![label(true)],
                ..Desc::default()
            },
            Desc {
                style: sized(100.0, 100.0),
                children: vec![label(true)],
                ..Desc::default()
            },
            Desc {
                style: sized(200.0, 100.0),
                clickable: true,
                children: vec![label(true)],
                ..Desc::default()
            },
            Desc {
                style: sized(300.0, 100.0),
                children: vec![label(false)],
                ..Desc::default()
            },
            Desc {
                style: Style {
                    pointer_shape: Some("pointer".into()),
                    ..sized(400.0, 100.0)
                },
                children: vec![Desc {
                    style: Style {
                        width: Dimension::Px(100.0),
                        height: Dimension::Px(40.0),
                        ..Style::default()
                    },
                    input: Some(InputProps::default()),
                    ..Desc::default()
                }],
                ..Desc::default()
            },
        ],
    );
    assert_eq!(tree.pointer_shape_at(5.0, 5.0), "pointer");
    assert_eq!(tree.pointer_shape_at(105.0, 5.0), "text");
    assert_eq!(tree.pointer_shape_at(205.0, 5.0), "default");
    assert_eq!(tree.pointer_shape_at(305.0, 5.0), "default");
    assert_eq!(tree.pointer_shape_at(405.0, 5.0), "text");
    assert_eq!(tree.pointer_shape_at(150.0, 80.0), "default");
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
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(tree.hit_pointer(10.0, 10.0), Some(top));
    assert_eq!(tree.hit_pointer(100.0, 50.0), Some(bottom));
}

#[test]
fn pointer_hit_stops_at_a_drag_surface_drawn_over_it() {
    let mut tree = Tree::new((200.0, 100.0));
    let page = tree.create(Props {
        style: Style {
            width: Dimension::Px(200.0),
            height: Dimension::Px(100.0),
            ..Style::default()
        },
        pointer_events: true,
        ..Props::default()
    });
    let canvas = tree.create(Props {
        style: Style {
            position: Position::Absolute,
            width: Dimension::Px(50.0),
            height: Dimension::Px(50.0),
            ..Style::default()
        },
        drag_events: true,
        ..Props::default()
    });
    tree.append(tree.root(), page);
    tree.append(tree.root(), canvas);
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(tree.hit_pointer(10.0, 10.0), None);
    assert_eq!(tree.hit_drag(10.0, 10.0), Some(canvas));
    assert_eq!(tree.hit_pointer(100.0, 50.0), Some(page));
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
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    let hit = tree.hit_click(5.0, 35.0).unwrap();
    assert_eq!(
        tree.key_of(hit),
        Some("green"),
        "fully scrolled, second block fills the viewport"
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
fn a_wrapping_row_moves_children_that_do_not_fit_onto_the_next_line() {
    let card = |key: &str| Desc {
        style: Style { width: Dimension::Px(120.0), height: Dimension::Px(30.0), ..Style::default() },
        key: Some(key.into()),
        ..Desc::default()
    };
    let row = |wrap| {
        vec![Desc {
            style: Style { width: Dimension::Px(200.0), flex_wrap: wrap, ..Style::default() },
            children: vec![card("a"), card("b")],
            ..Desc::default()
        }]
    };
    let wrapped = tree_of((300.0, 100.0), row(true));
    let (a, b) = (wrapped.rect(wrapped.find("a").unwrap()).unwrap(), wrapped.rect(wrapped.find("b").unwrap()).unwrap());
    assert_eq!((b.x, b.y), (a.x, a.y + 30.0), "the second card starts the next line");

    let single = tree_of((300.0, 100.0), row(false));
    let b = single.rect(single.find("b").unwrap()).unwrap();
    assert_eq!(b.y, 0.0, "without wrapping the cards share a line and shrink");
}

#[test]
fn a_block_caret_stays_on_the_line_when_the_input_is_only_as_wide_as_its_text() {
    let fonts = [font()];
    for text in ["", "test"] {
        let mut desc = editor_with_caret(text, CaretShape::Block);
        desc[0].style.align_items = Some(Align::Start);
        let tree = tree_of((200.0, 60.0), desc);
        let id = tree.find("in").unwrap();
        let geometry = tree.input_geometry(id).unwrap();
        let end = geometry.caret_rect(text, &[], text.len(), &fonts);
        assert_eq!(end.y, geometry.origin.1, "caret after {text:?} stays on its line");
    }
}

#[test]
fn a_block_caret_on_a_mark_is_as_wide_as_the_mark() {
    let fonts = [font()];
    let marks = [Mark { id: 1, offset: 1, advance: 40.0, data: None }];
    let text = format!("a{MARK_CHAR}b");
    let geometry = InputGeometry {
        origin: (0.0, 0.0),
        font: 0,
        px: 16.0,
        caret: CaretShape::Block,
        max_width: None,
    };
    assert_eq!(geometry.caret_rect(&text, &marks, 1, &fonts).w, 40.0);
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
fn text_leaves_size_the_layout_and_relayout_when_text_changes() {
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
    assert!(before.w > 0.0 && before.h > 0.0);
    tree.reconcile(Desc {
        children: vec![Desc {
            key: Some("label".into()),
            text: Some("hello there, much longer".into()),
            ..Desc::default()
        }],
        ..Desc::default()
    });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
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
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert!(tree.outside_click_targets(35.0, 45.0).is_empty());
    assert_eq!(tree.outside_click_targets(5.0, 5.0), vec![id]);
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
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(tree.scroll_state(id).unwrap().position, 40.0);

    // Drop the second block: content now fits, so scroll snaps to 0.
    let mut desc = scroller(false);
    desc[0].children.truncate(1);
    tree.reconcile(Desc {
        children: desc,
        ..Desc::default()
    });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
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
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(tree.rect(id), Some(PxRect::ZERO));
}

#[test]
fn scroll_range_follows_content_height_and_no_overflow_hides_the_bar() {
    let virtual_list = |content_height: Option<f32>| {
        vec![Desc {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(200.0),
                overflow: Overflow::Scroll,
                ..Style::default()
            },
            key: Some("virtual".into()),
            content_height,
            children: vec![Desc {
                style: Style {
                    height: Dimension::Px(30.0),
                    flex_shrink: 0.0,
                    ..Style::default()
                },
                ..Desc::default()
            }],
            ..Desc::default()
        }]
    };
    let mut tree = tree_of((100.0, 200.0), virtual_list(None));
    let id = tree.find("virtual").unwrap();
    assert!(tree.scrollbar_rects(id).is_none(), "no overflow, no bar");

    tree.reconcile(Desc {
        children: virtual_list(Some(800.0)),
        ..Desc::default()
    });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
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

fn point_at(tree: &Tree, id: NodeId, offset: usize, fonts: &[crate::fonts::Font]) -> (f32, f32) {
    let geometry = tree.text_geometry(id).unwrap();
    let text = tree.text_of(id).unwrap();
    let rect = geometry.caret_rect(text, &[], offset, fonts);
    (rect.x + 0.1, rect.y + 1.0)
}

#[test]
fn doc_selection_spans_text_nodes_in_document_order() {
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
    assert!(
        tree.doc_selection_blocks(&fonts).is_empty(),
        "no bands without a unified ancestor"
    );

    assert!(tree.doc_select_down(point_at(&tree, b, 6, &fonts), &fonts));
    tree.doc_select_drag(point_at(&tree, a, 6, &fonts), &fonts);
    assert_eq!(tree.doc_selection_range(a), Some(6..10), "backwards drag");
    assert_eq!(tree.doc_selection_range(b), Some(0..6));
}

#[test]
fn a_click_on_text_places_the_caret_without_putting_the_whole_tree_in_paint_order() {
    let fonts = [font()];
    let mut tree = tree_of((400.0, 200.0), labels("foo bar baz", "x"));
    let a = tree.find("a").unwrap();
    tree.order_stale = true;
    tree.doc_collapse();
    assert!(tree.doc_select_down_near((399.0, 199.0), &fonts), "a click below the text starts at its end");
    assert!(tree.doc_select_down(point_at(&tree, a, 5, &fonts), &fonts));
    assert!(tree.order_stale);
    tree.doc_select_drag(point_at(&tree, a, 9, &fonts), &fonts);
    assert_eq!(tree.doc_selected_text().as_deref(), Some("ar b"));
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
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
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
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);

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
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(
        tree.rect(widget),
        Some(PxRect::ZERO),
        "widget hides once its sentinel is deleted"
    );

    tree.edit_input(input, |i| {
        assert!(i.undo());
    });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(
        tree.rect(widget).map(|r| r.w),
        Some(40.0),
        "undo restores the mark and the widget comes back"
    );
}

#[test]
fn failed_image_with_unknown_dims_occupies_a_square() {
    let decoded = decode_signal();
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
            glyph: None,
        }),
        ..Props::default()
    });
    tree.append(row, image);
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);

    wait_for_decode(&decoded);
    tree.mark_layout();
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    let rect = tree.rect(image).unwrap();
    assert_eq!(
        (rect.w, rect.h),
        (40.0, 40.0),
        "failed image squares off its known dimension so the glyph shows"
    );
}

fn unwrapped_input(initial: &str) -> Vec<Desc> {
    vec![Desc {
        style: Style {
            width: Dimension::Px(60.0),
            height: Dimension::Px(30.0),
            ..Style::default()
        },
        children: vec![Desc {
            style: Style {
                padding: Edges::all(4.0),
                width: Dimension::Px(52.0),
                wrap: false,
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
fn input_scroll_x_shifts_geometry_and_hit_testing_until_blur_resets_it() {
    let text = "hello world wide";
    let mut tree = tree_of((60.0, 30.0), unwrapped_input(text));
    let id = tree.find("in").unwrap();
    let fonts = [font()];
    let before = tree.input_geometry(id).unwrap();
    let caret_before = before.caret_rect(text, &[], 5, &fonts);
    tree.input_mut(id).unwrap().set_scroll_x(10.0);
    let after = tree.input_geometry(id).unwrap();
    assert_eq!(after.origin.0, before.origin.0 - 10.0);
    let caret_after = after.caret_rect(text, &[], 5, &fonts);
    assert_eq!(caret_after.x, caret_before.x - 10.0);
    assert_eq!(
        after.offset_at(text, &[], (caret_after.x + 0.1, caret_after.y + 1.0), &fonts),
        5,
        "clicks map to the same offset under scroll"
    );

    tree.set_focus(Some(id));
    tree.set_focus(None);
    assert_eq!(
        tree.input(id).unwrap().scroll_x(),
        0.0,
        "blur resets scroll"
    );
}

#[test]
fn unwrapped_input_does_not_grow_past_its_flex_width() {
    let tree = tree_of(
        (100.0, 30.0),
        vec![Desc {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(30.0),
                ..Style::default()
            },
            children: vec![Desc {
                style: Style {
                    flex_grow: 1.0,
                    flex_basis: Dimension::Px(0.0),
                    wrap: false,
                    ..Style::default()
                },
                key: Some("in".into()),
                input: Some(InputProps {
                    initial: "a very long line of text much wider than the row".into(),
                    ..InputProps::default()
                }),
                ..Desc::default()
            }],
            ..Desc::default()
        }],
    );
    let id = tree.find("in").unwrap();
    let width = tree.content_width(id).unwrap();
    assert!(width <= 100.0, "input clamped to the row, got {width}");
}


fn field(wrap: bool) -> Vec<Desc> {
    vec![Desc {
        style: Style {
            width: Dimension::Px(200.0),
            height: Dimension::Px(60.0),
            ..Style::default()
        },
        children: vec![Desc {
            style: Style {
                padding: Edges::all(4.0),
                wrap,
                ..Style::default()
            },
            key: Some("in".into()),
            input: Some(InputProps {
                initial: "hello".into(),
                ..InputProps::default()
            }),
            ..Desc::default()
        }],
        ..Desc::default()
    }]
}

#[test]
fn single_line_inputs_center_their_text_vertically() {
    let line = line_height(&font(), DEFAULT_RESOLVED.px);
    let expected = 4.0 + ((52.0 - line) / 2.0).round();

    let single = tree_of((200.0, 60.0), field(false));
    let id = single.find("in").unwrap();
    assert_eq!(single.input_geometry(id).unwrap().origin.1, expected, "text centered inside the padding box");

    let multi = tree_of((200.0, 60.0), field(true));
    let id = multi.find("in").unwrap();
    assert_eq!(multi.input_geometry(id).unwrap().origin.1, 4.0, "wrapping inputs stay top aligned");
}

#[test]
fn font_family_weight_and_style_inherit_separately() {
    let mut fonts = crate::fonts::FontRegistry::bundled();
    let sans = fonts.families(&["sans-serif".to_string()]);
    let mut tree = Tree::new((200.0, 100.0));
    tree.reconcile(Desc {
        children: vec![Desc {
            style: Style { font_family: Some(sans), ..Style::default() },
            children: vec![Desc {
                text: Some("bold".into()),
                style: Style { font_weight: Some(crate::fonts::BOLD), ..Style::default() },
                ..Desc::default()
            }],
            ..Desc::default()
        }],
        ..Desc::default()
    });
    tree.flush_layout(&mut fonts, 16.0);
    let parent = tree.children(tree.root())[0];
    let text = tree.children(parent)[0];
    let resolved = tree.node(text).resolved;
    assert_eq!((resolved.families, resolved.weight), (sans, crate::fonts::BOLD), "the child keeps the parent's family");
    assert_eq!(resolved.font, fonts.resolve(sans, crate::fonts::BOLD, false));
    assert_ne!(resolved.font, tree.node(parent).resolved.font);
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
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
}

#[test]
fn content_y_is_exact_for_rows_that_were_never_placed_at_this_offset() {
    let mut tree = tree_of((40.0, 100.0), rows(100, None));
    let scroller = tree.find("scroller").unwrap();
    scroll_on_screen(&mut tree, 700.0);
    let last = tree.find("row99").unwrap();
    assert_eq!(tree.content_y(last, scroller), Some(1980.0));
    assert_eq!(tree.content_y(tree.find("row35").unwrap(), scroller), Some(700.0));
}

#[test]
fn restyling_a_container_recolors_text_inside_it() {
    let colored = |color: Color| {
        vec![Desc {
            key: Some("box".into()),
            style: Style { color: Some(color), ..Style::default() },
            children: vec![Desc { key: Some("text".into()), text: Some("hi".into()), ..Desc::default() }],
            ..Desc::default()
        }]
    };
    let mut tree = tree_of((100.0, 40.0), colored([200, 0, 0, 255]));
    let text = tree.find("text").unwrap();
    tree.reconcile(Desc { children: colored([0, 0, 200, 255]), ..Desc::default() });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(tree.find("text"), Some(text));
    assert_eq!(tree.get(text).unwrap().resolved.color, [0, 0, 200, 255]);
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

fn scroll_list(tree: &mut Tree, position: f32) {
    let id = tree.find("list").unwrap();
    let state = tree.scroll_state_mut(id).unwrap();
    state.position = position;
    state.set_target(position);
    tree.mark_place();
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
}

fn catch_up(tree: &mut Tree) {
    let fonts = crate::fonts::FontRegistry::bundled();
    while tree.rows_pending() {
        tree.catch_up_rows(&fonts, Instant::now() + std::time::Duration::from_secs(1));
        tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    }
}

#[test]
fn far_rows_wait_with_an_estimated_height_until_caught_up() {
    let mut tree = tree_of((40.0, 100.0), list_of(300, |i| if i % 2 == 0 { 20.0 } else { 40.0 }, Style::default()));
    let far = tree.find("row299").unwrap();
    assert!(tree.get(far).unwrap().measured_width.is_nan());
    assert!(tree.rows_pending());
    let list = tree.find("list").unwrap();
    assert!(tree.scroll_max(list) > 0.0, "unmeasured rows still give the list a height");
    let estimate = tree.rect(far).unwrap();
    assert!(estimate.y > 100.0);
    catch_up(&mut tree);
    assert!(!tree.rows_pending());
    assert_eq!(tree.rect(far).unwrap().y, 150.0 * 20.0 + 149.0 * 40.0);
    assert_eq!(tree.scroll_max(list), 150.0 * 60.0 - 100.0);
    assert_eq!(tree.content_y(far, list), Some(8960.0));
}

#[test]
fn a_list_anchored_to_its_end_follows_growth_only_while_at_the_end() {
    let rows = |count: usize| list_of(count, |_| 20.0, Style { scroll_anchor: ScrollAnchor::End, ..Style::default() });
    let mut tree = tree_of((40.0, 100.0), rows(20));
    let list = tree.find("list").unwrap();
    assert_eq!(tree.scroll_state(list).unwrap().position, 300.0, "starts at the end");
    tree.reconcile(Desc { children: rows(25), ..Desc::default() });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(tree.scroll_state(list).unwrap().position, 400.0);
    scroll_list(&mut tree, 100.0);
    tree.reconcile(Desc { children: rows(30), ..Desc::default() });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(tree.scroll_state(list).unwrap().position, 100.0);
}

#[test]
fn a_list_anchored_to_its_end_lays_out_its_whole_last_screen_at_once() {
    let height = |i: usize| 10.0 + (i % 3) as f32 * 10.0;
    let tree = tree_of((40.0, 100.0), list_of(300, height, Style { scroll_anchor: ScrollAnchor::End, ..Style::default() }));
    for i in 280..300 {
        let rect = tree.rect(tree.find(&format!("row{i}")).unwrap()).unwrap();
        if rect.y + rect.h > 0.0 {
            assert_eq!(rect.h, height(i), "row{i} is on screen");
        }
    }
}

#[test]
fn a_list_following_its_end_stays_there_while_rows_are_added_above() {
    let height = |i: usize| 10.0 + (i % 3) as f32 * 10.0;
    let style = Style { scroll_anchor: ScrollAnchor::End, ..Style::default() };
    let rows = |from: usize| {
        let mut list = list_of(300, height, style.clone());
        list[0].children.drain(..from);
        list
    };
    let mut tree = tree_of((40.0, 100.0), rows(290));
    let list = tree.find("list").unwrap();
    let fonts = crate::fonts::FontRegistry::bundled();
    for from in (0..290).rev().step_by(7) {
        tree.reconcile(Desc { children: rows(from), ..Desc::default() });
        tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
        assert_eq!(tree.scroll_state(list).unwrap().position, tree.scroll_max(list), "after adding rows from {from}");
        tree.catch_up_rows(&fonts, Instant::now() + std::time::Duration::from_micros(50));
        assert_eq!(tree.scroll_state(list).unwrap().position, tree.scroll_max(list), "after catching up from {from}");
        tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    }
}

#[test]
fn a_row_far_above_the_screen_that_grows_moves_the_rows_below_it_once_caught_up() {
    let rows = |grown: bool| {
        let row = |i: usize| {
            let line = |k: usize| Desc { style: Style { height: Dimension::Px(20.0), ..Style::default() }, key: Some(format!("line{i}-{k}")), ..Desc::default() };
            let lines = if grown && i == 10 { 3 } else { 1 };
            Desc {
                style: Style { flex_direction: FlexDirection::Column, ..Style::default() },
                key: Some(format!("row{i}")),
                children: (0..lines).map(line).collect(),
                ..Desc::default()
            }
        };
        vec![Desc {
            style: Style { width: Dimension::Px(40.0), height: Dimension::Px(100.0), overflow: Overflow::Scroll, layout: Layout::List, ..Style::default() },
            key: Some("list".into()),
            children: (0..300).map(row).collect(),
            ..Desc::default()
        }]
    };
    let mut tree = tree_of((40.0, 100.0), rows(false));
    scroll_list(&mut tree, 4000.0);
    catch_up(&mut tree);
    tree.reconcile(Desc { children: rows(true), ..Desc::default() });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    catch_up(&mut tree);
    let row = tree.find("row11").unwrap();
    assert_eq!(tree.node(row).list_y, 260.0);
}

#[test]
fn rows_added_above_while_following_the_end_line_up_once_caught_up() {
    let height = |i: usize| 10.0 + (i % 3) as f32 * 10.0;
    let style = Style { scroll_anchor: ScrollAnchor::End, ..Style::default() };
    let rows = |from: usize| {
        let mut list = list_of(300, height, style.clone());
        list[0].children.drain(..from);
        list
    };
    let mut tree = tree_of((40.0, 100.0), rows(290));
    let list = tree.find("list").unwrap();
    for from in (0..290).rev().step_by(7) {
        tree.reconcile(Desc { children: rows(from), ..Desc::default() });
        tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    }
    tree.reconcile(Desc { children: rows(0), ..Desc::default() });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    catch_up(&mut tree);
    let mut expected = 0.0;
    for i in 0..300 {
        let row = tree.find(&format!("row{i}")).unwrap();
        assert_eq!(tree.node(row).list_y, expected, "row {i}");
        expected += height(i);
    }
    assert_eq!(tree.scroll_max(list), expected - 100.0);
}

#[test]
fn hits_and_selection_find_rows_of_a_list() {
    let mut tree = tree_of((40.0, 100.0), list_of(300, |_| 20.0, Style::default()));
    scroll_list(&mut tree, 4000.0);
    assert_eq!(tree.hit_click(5.0, 5.0), tree.find("row200"));
    assert_eq!(tree.hit_click(5.0, 95.0), tree.find("row204"));
}

#[test]
fn painting_a_scrolled_list_walks_only_the_rows_near_the_screen() {
    let mut tree = tree_of((40.0, 100.0), list_of(20_000, |_| 20.0, Style::default()));
    scroll_list(&mut tree, 200_000.0);
    let list = tree.find("list").unwrap();
    let walked: Vec<NodeId> = tree.paint_children(list).collect();
    assert!(walked.len() < 20, "walked {} rows", walked.len());
    assert!(walked.contains(&tree.find("row10000").unwrap()));
    assert_eq!(tree.hit_click(5.0, 5.0), tree.find("row10000"));
}

#[test]
fn a_row_changing_far_below_the_screen_keeps_the_walk_near_the_screen() {
    let mut tree = tree_of((40.0, 100.0), list_of(20_000, |_| 20.0, Style::default()));
    scroll_list(&mut tree, 200_000.0);
    tree.reconcile(Desc { children: list_of(20_000, |i| if i == 19_999 { 60.0 } else { 20.0 }, Style::default()), ..Desc::default() });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    let list = tree.find("list").unwrap();
    assert!(tree.paint_children(list).count() < 20);
    assert_eq!(tree.hit_click(5.0, 5.0), tree.find("row10000"));
}


#[test]
fn a_modal_makes_everything_outside_it_inert() {
    let mut tree = Tree::new((200.0, 100.0));
    let scroller = tree.create(Props {
        style: Style { width: Dimension::Px(200.0), height: Dimension::Px(100.0), overflow: Overflow::Scroll, ..Style::default() },
        ..Props::default()
    });
    let prompt = tree.create(Props {
        style: Style { width: Dimension::Px(200.0), height: Dimension::Px(20.0), ..Style::default() },
        input: Some(InputProps::default()),
        ..Props::default()
    });
    tree.append(tree.root(), scroller);
    tree.append(scroller, prompt);
    let backdrop_props = |modal| Props {
        style: Style {
            position: Position::Absolute,
            inset: crate::style::Inset::top_left(100.0, 0.0),
            width: Dimension::Px(100.0),
            height: Dimension::Px(100.0),
            ..Style::default()
        },
        clickable: true,
        modal,
        ..Props::default()
    };
    let backdrop = tree.create(backdrop_props(false));
    let field = tree.create(Props {
        style: Style { width: Dimension::Px(100.0), height: Dimension::Px(20.0), ..Style::default() },
        input: Some(InputProps::default()),
        ..Props::default()
    });
    tree.append(tree.root(), backdrop);
    tree.append(backdrop, field);
    let mut fonts = crate::fonts::FontRegistry::bundled();
    tree.flush_layout(&mut fonts, 16.0);
    assert_eq!(tree.hit_target(10.0, 10.0), Some(HitTarget::Input(prompt)));
    assert!(tree.scroll_area_at(10.0, 10.0).is_some());

    tree.update(backdrop, backdrop_props(true));
    tree.flush_layout(&mut fonts, 16.0);
    assert_eq!(tree.modal_root(), Some(backdrop));
    assert!(tree.inert(prompt) && tree.inert(scroller));
    assert!(!tree.inert(backdrop) && !tree.inert(field));
    assert_eq!(tree.hit_target(10.0, 10.0), Some(HitTarget::Click(backdrop)), "a click outside lands on the modal");
    assert_eq!(tree.hit_target(110.0, 10.0), Some(HitTarget::Input(field)));
    assert!(tree.scroll_area_at(10.0, 10.0).is_none());
}

#[test]
fn a_removed_modal_leaves_the_tree_interactive() {
    let mut tree = Tree::new((200.0, 100.0));
    let prompt = tree.create(Props {
        style: Style { width: Dimension::Px(200.0), height: Dimension::Px(20.0), ..Style::default() },
        input: Some(InputProps::default()),
        ..Props::default()
    });
    let sheet = tree.create(Props {
        style: Style { position: Position::Absolute, width: Dimension::Px(200.0), height: Dimension::Px(50.0), ..Style::default() },
        modal: true,
        ..Props::default()
    });
    tree.append(tree.root(), prompt);
    tree.append(tree.root(), sheet);
    let mut fonts = crate::fonts::FontRegistry::bundled();
    tree.flush_layout(&mut fonts, 16.0);
    assert!(tree.inert(prompt));

    tree.remove(sheet);
    tree.flush_layout(&mut fonts, 16.0);
    assert_eq!(tree.modal_root(), None);
    assert!(!tree.inert(prompt));
    assert_eq!(tree.hit_target(10.0, 10.0), Some(HitTarget::Input(prompt)));
}

#[test]
fn a_one_word_caption_stays_one_line_when_its_card_wraps() {
    let captioned = |width: f32| Desc {
        style: Style { flex_direction: FlexDirection::Column, align_items: Some(Align::Start), gap: 8.0, flex_shrink: 0.0, width: Dimension::Px(width), ..Style::default() },
        children: vec![
            Desc { style: Style { width: Dimension::Px(width), height: Dimension::Px(264.0), flex_shrink: 0.0, ..Style::default() }, ..Desc::default() },
            Desc { text: Some("pic.png".into()), ..Desc::default() },
        ],
        ..Desc::default()
    };
    let tree = tree_of(
        (1650.0, 1100.0),
        vec![Desc {
            style: Style { flex_direction: FlexDirection::Column, width: Dimension::Px(1650.0), height: Dimension::Px(1000.0), overflow: Overflow::Scroll, ..Style::default() },
            children: vec![Desc {
                style: Style { flex_direction: FlexDirection::Column, ..Style::default() },
                children: vec![Desc {
                    style: Style { flex_direction: FlexDirection::Column, flex_shrink: 0.0, ..Style::default() },
                    children: vec![Desc {
                        style: Style { flex_wrap: true, align_items: Some(Align::Start), gap: 16.0, padding: Edges { top: 16.0, left: 30.0, ..Edges::default() }, ..Style::default() },
                        key: Some("row".into()),
                        children: vec![captioned(620.0), captioned(890.0)],
                        ..Desc::default()
                    }],
                    ..Desc::default()
                }],
                ..Desc::default()
            }],
            ..Desc::default()
        }],
    );
    let line = line_height(&font(), 16.0);
    let row = tree.rect(tree.find("row").unwrap()).unwrap().h;
    assert!((row - (16.0 + 264.0 + 8.0 + line)).abs() < 1.0, "one line of cards with their captions, got {row}");
}

#[test]
fn a_row_with_a_flex_shrink_0_child_pulled_up_by_a_negative_margin_keeps_its_height() {
    let row = |i: usize| Desc {
        style: Style { flex_direction: FlexDirection::Column, ..Style::default() },
        key: Some(format!("row{i}")),
        children: vec![
            Desc { style: Style { height: Dimension::Px(40.0), ..Style::default() }, ..Desc::default() },
            Desc {
                style: Style {
                    height: Dimension::Px(30.0),
                    flex_shrink: 0.0,
                    position: Position::Sticky,
                    inset: crate::style::Inset { top: Some(InsetValue::Px(0.0)), ..Default::default() },
                    margin: Edges { top: -30.0, ..Default::default() },
                    ..Style::default()
                },
                ..Desc::default()
            },
            Desc { style: Style { height: Dimension::Px(20.0), ..Style::default() }, ..Desc::default() },
        ],
        ..Desc::default()
    };
    let mut tree = tree_of((40.0, 100.0), vec![Desc {
        style: Style { width: Dimension::Px(40.0), height: Dimension::Px(100.0), overflow: Overflow::Scroll, layout: Layout::List, ..Style::default() },
        key: Some("list".into()),
        children: (0..3).map(row).collect(),
        ..Desc::default()
    }]);
    catch_up(&mut tree);
    let ys: Vec<f32> = (0..3).map(|i| tree.node(tree.find(&format!("row{i}")).unwrap()).list_y).collect();
    assert_eq!(ys, vec![0.0, 60.0, 120.0]);
}

#[test]
fn laying_out_images_reads_their_headers_and_decodes_none() {
    let dir = std::env::temp_dir().join(format!("pixel-tree-undrawn-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut tree = Tree::new((300.0, 200.0));
    let mut images = Vec::new();
    for i in 0..8 {
        let path = dir.join(format!("shot-{i}.png"));
        image::RgbaImage::from_pixel(30, 60, image::Rgba([0, 0, 200, 255])).save(&path).unwrap();
        let image = tree.create(Props {
            image: Some(ImageProps { src: path.to_string_lossy().to_string(), equal_to: Vec::new(), glyph: None }),
            ..Props::default()
        });
        tree.append(tree.root(), image);
        images.push(image);
    }
    for _ in 0..3 {
        tree.mark_layout();
        tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    }
    let rect = tree.rect(images[7]).unwrap();
    assert!(rect.h > 0.0 && rect.h == rect.w * 2.0, "sized from the header before any pixels: {rect:?}");
    std::thread::sleep(std::time::Duration::from_millis(50));
    let drained = crate::image_cache::drain_completed();
    assert!(!drained.landed && !drained.redraw, "layout decoded nothing");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn rows_on_screen_below_a_row_taller_than_the_screen_are_measured_again() {
    let rows = |grown: usize, added: bool| {
        let block = |key: &str, lines: usize| Desc {
            key: Some(key.into()),
            style: Style { flex_direction: FlexDirection::Column, flex_shrink: 0.0, ..Style::default() },
            children: (0..lines).map(|k| Desc { key: Some(format!("{key}-{k}")), style: Style { height: Dimension::Px(10.0), ..Style::default() }, ..Desc::default() }).collect(),
            ..Desc::default()
        };
        let mut children = vec![block("tall", 20), block("cards", 2 + grown)];
        if added {
            children.push(block("sent", 3));
        }
        vec![Desc {
            style: Style { width: Dimension::Px(40.0), height: Dimension::Px(100.0), overflow: Overflow::Scroll, layout: Layout::List, ..Style::default() },
            key: Some("list".into()),
            children,
            ..Desc::default()
        }]
    };
    let mut tree = tree_of((40.0, 100.0), rows(0, false));
    scroll_list(&mut tree, 150.0);
    tree.reconcile(Desc { children: rows(4, false), ..Desc::default() });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    tree.reconcile(Desc { children: rows(4, true), ..Desc::default() });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    let cards = tree.rect(tree.find("cards").unwrap()).unwrap();
    let sent = tree.rect(tree.find("sent").unwrap()).unwrap();
    assert_eq!(cards.h, 60.0, "the grown row is drawn at its new height");
    assert_eq!(sent.y, cards.y + cards.h, "the row after it starts where it ends, not over it");
}

#[test]
fn a_list_following_its_end_measures_its_last_row_again_when_it_grows() {
    let rows = |last: f32| list_of(20, move |i| if i == 19 { last } else { 20.0 }, Style { scroll_anchor: ScrollAnchor::End, ..Style::default() });
    let mut tree = tree_of((40.0, 100.0), rows(20.0));
    tree.reconcile(Desc { children: rows(60.0), ..Desc::default() });
    tree.flush_layout(&mut crate::fonts::FontRegistry::bundled(), 16.0);
    assert_eq!(tree.rect(tree.find("row19").unwrap()).unwrap().h, 60.0);
}

#[test]
fn cards_that_exactly_fill_a_wrapping_row_stay_on_one_line() {
    let cw = 14.0411f32;
    let room = 59.0 * cw;
    let card = ((room - cw) / 2.0).floor();
    let grid = Desc {
        key: Some("grid".into()),
        style: Style { flex_direction: FlexDirection::Row, flex_wrap: true, gap: cw, ..Style::default() },
        children: (0..2).map(|i| Desc { key: Some(format!("c{i}")), style: Style { width: Dimension::Px(card), height: Dimension::Px(281.0), flex_shrink: 0.0, ..Style::default() }, ..Desc::default() }).collect(),
        ..Desc::default()
    };
    let holder = Desc { style: Style { padding: crate::style::Edges { left: 2.0 * cw, ..Default::default() }, ..Style::default() }, children: vec![grid], ..Desc::default() };
    let width = 63.0 * cw;
    let tree = tree_of((width, 1000.0), vec![Desc { style: Style { width: Dimension::Px(width), flex_direction: FlexDirection::Column, padding: crate::style::Edges { left: cw, right: cw, ..Default::default() }, ..Style::default() }, children: vec![holder], ..Desc::default() }]);
    let rect = |key: &str| tree.rect(tree.find(key).unwrap()).unwrap();
    assert_eq!(rect("c1").y, rect("c0").y, "the second card stays beside the first");
    assert!(rect("c1").y + rect("c1").h <= rect("grid").y + rect("grid").h, "the row is as tall as its cards");
}

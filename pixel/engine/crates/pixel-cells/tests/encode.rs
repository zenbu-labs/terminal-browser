use pixel_cells::grid::{BOLD, CellGrid};
use pixel_cells::{Caret, CellColor, Encoder};
use pixel_core::CaretShape;

fn grid(rows: &[&str]) -> CellGrid {
    let width = 6;
    let mut grid = CellGrid::new(width, rows.len() as u16);
    for (y, row) in rows.iter().enumerate() {
        let mut x = 0u16;
        for ch in row.chars() {
            let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(1).max(1);
            let i = grid.index(x, y as u16);
            let mut buf = [0u8; 4];
            grid.put(i, ch.encode_utf8(&mut buf), w);
            x += w as u16;
        }
    }
    grid
}

fn diff(prev: &CellGrid, next: &CellGrid, encoder: &mut Encoder, caret: Option<Caret>) -> String {
    let mut out = Vec::new();
    encoder.diff(prev, next, caret, &mut out);
    String::from_utf8(out).unwrap()
}

fn primed(prev: &CellGrid) -> Encoder {
    let mut encoder = Encoder::default();
    let mut out = Vec::new();
    encoder.full(prev, None, &mut out);
    encoder
}

#[test]
fn identical_grids_write_zero_bytes() {
    let a = grid(&["hello", "world"]);
    let mut encoder = primed(&a);
    assert_eq!(diff(&a, &a.clone(), &mut encoder, None), "");
}

#[test]
fn one_changed_cell_is_one_move_and_one_char_inside_a_synchronized_update() {
    let a = grid(&["hello", "world"]);
    let b = grid(&["hello", "wOrld"]);
    let mut encoder = primed(&a);
    assert_eq!(diff(&a, &b, &mut encoder, None), "\x1b[?2026h\x1b[2;2HO\x1b[?2026l");
}

#[test]
fn neighbouring_changes_in_a_row_need_no_second_move_or_restyle() {
    let a = grid(&["abcdef"]);
    let mut b = grid(&["aXYdeZ"]);
    let i = b.index(5, 0);
    b.attrs[i] = BOLD;
    let mut encoder = primed(&a);
    assert_eq!(diff(&a, &b, &mut encoder, None), "\x1b[?2026h\x1b[1;2HXY\x1b[2C\x1b[1mZ\x1b[?2026l");
}

#[test]
fn colors_are_only_sent_when_they_change() {
    let a = grid(&["abc"]);
    let mut b = grid(&["xyz"]);
    for i in 0..3 {
        b.fg[i] = CellColor::Rgb(1, 2, 3);
    }
    b.bg[2] = CellColor::Indexed(4);
    let mut encoder = primed(&a);
    assert_eq!(diff(&a, &b, &mut encoder, None), "\x1b[?2026h\x1b[1;1H\x1b[38;2;1;2;3mxy\x1b[44mz\x1b[?2026l");
}

#[test]
fn replacing_a_wide_glyph_with_narrow_ones_rewrites_both_cells() {
    let a = grid(&["你x"]);
    let b = grid(&["abx"]);
    let mut encoder = primed(&a);
    assert_eq!(diff(&a, &b, &mut encoder, None), "\x1b[?2026h\x1b[1;1Hab\x1b[?2026l");
}

#[test]
fn writing_over_the_second_half_of_a_wide_glyph_repaints_the_first() {
    let a = grid(&["你x"]);
    let b = grid(&[" Qx"]);
    let mut encoder = primed(&a);
    assert_eq!(diff(&a, &b, &mut encoder, None), "\x1b[?2026h\x1b[1;1H Q\x1b[?2026l");
}

#[test]
fn an_emoji_with_a_variation_selector_clears_its_trailing_cell_first() {
    let a = grid(&["abc"]);
    let mut b = grid(&["a"]);
    let i = b.index(1, 0);
    b.put(i, "❤\u{fe0f}", 2);
    let mut encoder = primed(&a);
    assert_eq!(diff(&a, &b, &mut encoder, None), "\x1b[?2026h\x1b[1;3H \x1b[1;2H❤\u{fe0f}\x1b[?2026l");
}

#[test]
fn the_cursor_is_placed_and_shaped_after_the_cells() {
    let a = grid(&["ab"]);
    let b = grid(&["ac"]);
    let mut encoder = primed(&a);
    let caret = Caret { x: 2, y: 0, shape: CaretShape::Bar };
    assert_eq!(diff(&a, &b, &mut encoder, Some(caret)), "\x1b[?2026h\x1b[1;2Hc\x1b[1;3H\x1b[6 q\x1b[?25h\x1b[?2026l");
    assert_eq!(diff(&b, &b.clone(), &mut encoder, Some(caret)), "", "an unchanged screen and cursor write nothing");
    let moved = Caret { x: 0, y: 0, shape: CaretShape::Bar };
    assert_eq!(diff(&b, &b.clone(), &mut encoder, Some(moved)), "\x1b[?2026h\x1b[1;1H\x1b[?2026l");
    assert_eq!(diff(&b, &b.clone(), &mut encoder, None), "\x1b[?2026h\x1b[?25l\x1b[?2026l");
}

#[test]
fn a_scrolled_region_is_moved_by_the_terminal_and_only_the_uncovered_row_is_written() {
    let a = grid(&["head", "one", "two", "three", "foot"]);
    let b = grid(&["head", "two", "three", "four", "foot"]);
    let mut encoder = primed(&a);
    let mut shown = a.clone();
    let scroll = pixel_cells::encode::Scroll { top: 1, bottom: 4, by: 1 };
    shown.scroll(scroll.top, scroll.bottom, scroll.by);
    let mut out = Vec::new();
    encoder.diff_scrolled(&shown, &b, &[scroll], None, &mut out);
    assert_eq!(String::from_utf8(out).unwrap(), "\x1b[?2026h\x1b[2;4r\x1b[1S\x1b[r\x1b[4;1Hfour  \x1b[?2026l");
}

#[test]
fn scrolling_down_moves_rows_the_other_way() {
    let a = grid(&["one", "two", "three"]);
    let b = grid(&["zero", "one", "two"]);
    let mut encoder = primed(&a);
    let mut shown = a.clone();
    shown.scroll(0, 3, -1);
    let mut out = Vec::new();
    encoder.diff_scrolled(&shown, &b, &[pixel_cells::encode::Scroll { top: 0, bottom: 3, by: -1 }], None, &mut out);
    assert_eq!(String::from_utf8(out).unwrap(), "\x1b[?2026h\x1b[1;3r\x1b[1T\x1b[r\x1b[1;1Hzero  \x1b[?2026l");
}

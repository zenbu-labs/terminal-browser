
use crate::text_metrics::measure_marked;
use crate::style::{Align, Dimension, Edges, FlexDirection, InsetValue, Justify, Overflow, Position, Style};
use crate::text_input::Mark;
use crate::wrap::wrap_lines;

#[derive(PartialEq)]
pub(crate) enum MeasureCtx {
    Text {
        text: String,
        px: f32,
        font: usize,
        font_id: usize,
        wrap: bool,
        marks: Vec<Mark>,
        cell_caret: bool,
    },
    Image {
        src: String,
        size: Option<(u32, u32)>,
    },
}

pub(super) fn measure(
    known: taffy::Size<Option<f32>>,
    available: taffy::Size<taffy::AvailableSpace>,
    context: Option<&MeasureCtx>,
    fonts: &[crate::fonts::Font],
) -> taffy::Size<f32> {
    match context {
        None => taffy::Size::ZERO,
        Some(MeasureCtx::Image { size, .. }) => measure_image(known, available, *size),
        Some(MeasureCtx::Text {
            text,
            px,
            font,
            wrap,
            marks,
            cell_caret,
            ..
        }) => measure_wrapped_text(
            known,
            available,
            text,
            *px,
            *font,
            *wrap,
            marks,
            *cell_caret,
            fonts,
        ),
    }
}

fn measure_image(
    known: taffy::Size<Option<f32>>,
    available: taffy::Size<taffy::AvailableSpace>,
    size: Option<(u32, u32)>,
) -> taffy::Size<f32> {
    let Some((nw, nh)) = size else {
        return taffy::Size::ZERO;
    };
    let (nw, nh) = (nw as f32, nh as f32);
    match (known.width, known.height) {
        (Some(w), Some(h)) => taffy::Size {
            width: w,
            height: h,
        },
        (Some(w), None) => taffy::Size {
            width: w,
            height: w * nh / nw,
        },
        (None, Some(h)) => taffy::Size {
            width: h * nw / nh,
            height: h,
        },
        (None, None) => {
            let width = match available.width {
                taffy::AvailableSpace::Definite(aw) => nw.min(aw),
                _ => nw,
            };
            taffy::Size {
                width,
                height: width * nh / nw,
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn measure_wrapped_text(
    known: taffy::Size<Option<f32>>,
    available: taffy::Size<taffy::AvailableSpace>,
    text: &str,
    px: f32,
    font: usize,
    wrap: bool,
    marks: &[Mark],
    cell_caret: bool,
    fonts: &[crate::fonts::Font],
) -> taffy::Size<f32> {
    let font = &fonts[font.min(fonts.len() - 1)];
    let line = font
        .horizontal_line_metrics(px)
        .map_or(px, |m| m.new_line_size);
    let max_width = if wrap {
        match (known.width, available.width) {
            (Some(w), _) => Some(w),
            (None, taffy::AvailableSpace::Definite(w)) => Some(w),
            (None, taffy::AvailableSpace::MinContent) => Some(0.0),
            (None, taffy::AvailableSpace::MaxContent) => None,
        }
    } else {
        None
    };
    let lines = wrap_lines(text, font, px, max_width, marks);
    let widest = lines
        .iter()
        .map(|r| {
            if cell_caret {
                let full = measure_marked(font, text, r.clone(), px, marks)
                    + crate::text_metrics::measure_text(font, " ", px);
                return max_width.map_or(full, |w| full.min(w));
            }
            let visible_len = text[r.clone()].trim_end_matches(' ').len();
            measure_marked(font, text, r.start..r.start + visible_len, px, marks)
        })
        .fold(0.0f32, f32::max);
    let caret_line = cell_caret
        && max_width.zip(lines.last()).is_some_and(|(width, last)| {
            let end = measure_marked(font, text, last.clone(), px, marks);
            end + crate::text_metrics::measure_text(font, " ", px) > width + crate::wrap::WRAP_SLACK
        });
    taffy::Size {
        width: widest.ceil(),
        height: line * (lines.len() + usize::from(caret_line)) as f32,
    }
}

pub(super) fn to_taffy(style: &Style, hidden: bool, input: bool, lattice: (f32, f32)) -> taffy::Style {
    if lattice == (1.0, 1.0) {
        return to_taffy_px(style, hidden, input);
    }
    let room = border_room(style, lattice);
    let mut taffy = to_taffy_px(&whole_units(style, lattice, room), hidden, input);
    taffy.border = taffy::Rect {
        left: taffy::LengthPercentage::length(room.left),
        right: taffy::LengthPercentage::length(room.right),
        top: taffy::LengthPercentage::length(room.top),
        bottom: taffy::LengthPercentage::length(room.bottom),
    };
    taffy
}

fn border_room(style: &Style, (x, y): (f32, f32)) -> Edges {
    let border = style.border.unwrap_or_default();
    let room = |side: Option<crate::style::BorderSide>, unit: f32| {
        side.filter(|s| s.width > 0.0 && s.color[3] > 0).map_or(0.0, |s| (unit - s.width).max(0.0))
    };
    Edges { left: room(border.left, x), right: room(border.right, x), top: room(border.top, y), bottom: room(border.bottom, y) }
}

fn whole_units(style: &Style, (x, y): (f32, f32), room: Edges) -> Style {
    let round_x = |v: f32| (v / x).round().max(0.0) * x;
    let round_y = |v: f32| (v / y - 0.2).round().max(0.0) * y;
    let size_x = |d: Dimension| match d {
        Dimension::Px(v) if v > 0.0 => Dimension::Px(round_x(v).max(x)),
        other => other,
    };
    let size_y = |d: Dimension| match d {
        Dimension::Px(v) if v > 0.0 => Dimension::Px(round_y(v).max(y)),
        other => other,
    };
    let signed = |round: &dyn Fn(f32) -> f32, v: f32| round(v.abs()).copysign(v);
    let inset = |round: &dyn Fn(f32) -> f32, v: Option<InsetValue>| match v {
        Some(InsetValue::Px(v)) => Some(InsetValue::Px(signed(round, v))),
        other => other,
    };
    let strokes = style.border.map_or((0.0, 0.0), |b| {
        let w = |s: Option<crate::style::BorderSide>| s.map_or(0.0, |s| s.width);
        (w(b.left) + w(b.right), w(b.top) + w(b.bottom))
    });
    let grow = |d: Dimension, room: f32, strokes: f32, unit: f32| match d {
        Dimension::Px(v) if room > 0.0 && v - room - strokes < unit => Dimension::Px(v + room),
        other => other,
    };
    let mut snapped = style.clone();
    snapped.width = size_x(grow(style.width, room.left + room.right, strokes.0, x));
    snapped.height = size_y(grow(style.height, room.top + room.bottom, strokes.1, y));
    snapped.min_width = size_x(style.min_width);
    snapped.max_width = size_x(style.max_width);
    snapped.max_height = size_y(style.max_height);
    snapped.padding = Edges {
        left: round_x(style.padding.left),
        right: round_x(style.padding.right),
        top: round_y(style.padding.top),
        bottom: round_y(style.padding.bottom),
    };
    snapped.margin = Edges {
        left: signed(&round_x, style.margin.left),
        right: signed(&round_x, style.margin.right),
        top: signed(&round_y, style.margin.top),
        bottom: signed(&round_y, style.margin.bottom),
    };
    snapped.inset.left = inset(&round_x, style.inset.left);
    snapped.inset.right = inset(&round_x, style.inset.right);
    snapped.inset.top = inset(&round_y, style.inset.top);
    snapped.inset.bottom = inset(&round_y, style.inset.bottom);
    snapped.gap = if style.flex_direction == FlexDirection::Column { round_y(style.gap) } else { round_x(style.gap) };
    snapped
}

fn to_taffy_px(style: &Style, hidden: bool, input: bool) -> taffy::Style {
    use taffy::prelude::{auto, length, percent};

    fn dimension(d: Dimension) -> taffy::Dimension {
        match d {
            Dimension::Auto => auto(),
            Dimension::Px(v) => length(v),
            Dimension::Percent(f) => percent(f),
        }
    }

    fn inset_edge(v: Option<InsetValue>) -> taffy::LengthPercentageAuto {
        match v {
            None => auto(),
            Some(InsetValue::Px(v)) => length(v),
            Some(InsetValue::Percent(f)) => percent(f),
        }
    }

    let overflow = match style.overflow {
        Overflow::Visible => taffy::Overflow::Visible,
        Overflow::Hidden => taffy::Overflow::Hidden,
        Overflow::Scroll => taffy::Overflow::Scroll,
    };

    taffy::Style {
        display: if hidden {
            taffy::Display::None
        } else {
            taffy::Display::Flex
        },
        position: match style.position {
            Position::Flow | Position::Sticky => taffy::Position::Relative,
            Position::Absolute => taffy::Position::Absolute,
        },
        inset: if style.position == Position::Sticky {
            taffy::Rect { left: auto(), right: auto(), top: auto(), bottom: auto() }
        } else {
            taffy::Rect {
                left: inset_edge(style.inset.left),
                right: inset_edge(style.inset.right),
                top: inset_edge(style.inset.top),
                bottom: inset_edge(style.inset.bottom),
            }
        },
        overflow: taffy::Point {
            x: overflow,
            y: overflow,
        },
        flex_direction: match style.flex_direction {
            FlexDirection::Row => taffy::FlexDirection::Row,
            FlexDirection::Column => taffy::FlexDirection::Column,
        },
        flex_wrap: if style.flex_wrap {
            taffy::FlexWrap::Wrap
        } else {
            taffy::FlexWrap::NoWrap
        },
        align_content: style.flex_wrap.then_some(taffy::AlignContent::FlexStart),
        flex_grow: style.flex_grow,
        flex_shrink: style.flex_shrink,
        flex_basis: dimension(style.flex_basis),
        size: taffy::Size {
            width: dimension(style.width),
            height: dimension(style.height),
        },
        min_size: taffy::Size {
            width: if input && !style.wrap {
                length(0.0)
            } else {
                dimension(style.min_width)
            },
            height: auto(),
        },
        max_size: taffy::Size {
            width: dimension(style.max_width),
            height: dimension(style.max_height),
        },
        padding: taffy::Rect {
            left: length(style.padding.left),
            right: length(style.padding.right),
            top: length(style.padding.top),
            bottom: length(style.padding.bottom),
        },
        margin: taffy::Rect {
            left: length(style.margin.left),
            right: length(style.margin.right),
            top: length(style.margin.top),
            bottom: length(style.margin.bottom),
        },
        gap: taffy::Size {
            width: length(style.gap),
            height: length(style.gap),
        },
        justify_content: style.justify_content.map(|j| match j {
            Justify::Start => taffy::JustifyContent::Start,
            Justify::Center => taffy::JustifyContent::Center,
            Justify::End => taffy::JustifyContent::End,
            Justify::SpaceBetween => taffy::JustifyContent::SpaceBetween,
        }),
        align_items: style.align_items.map(|a| match a {
            Align::Start => taffy::AlignItems::Start,
            Align::Center => taffy::AlignItems::Center,
            Align::End => taffy::AlignItems::End,
            Align::Stretch => taffy::AlignItems::Stretch,
        }),
        ..taffy::Style::default()
    }
}

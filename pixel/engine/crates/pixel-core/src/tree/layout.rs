
use crate::canvas::measure_marked;
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
                    + crate::canvas::measure_text(font, " ", px);
                return max_width.map_or(full, |w| full.min(w));
            }
            let visible_len = text[r.clone()].trim_end_matches(' ').len();
            measure_marked(font, text, r.start..r.start + visible_len, px, marks)
        })
        .fold(0.0f32, f32::max);
    let caret_line = cell_caret
        && max_width.zip(lines.last()).is_some_and(|(width, last)| {
            let end = measure_marked(font, text, last.clone(), px, marks);
            end + crate::canvas::measure_text(font, " ", px) > width + crate::wrap::WRAP_SLACK
        });
    taffy::Size {
        width: widest.ceil(),
        height: line * (lines.len() + usize::from(caret_line)) as f32,
    }
}

pub(super) fn to_taffy(style: &Style, hidden: bool, input: bool, grid: Option<(f32, f32)>) -> taffy::Style {
    match grid {
        Some(cell) => to_taffy_px(&snap_to_grid(style, cell), hidden, input),
        None => to_taffy_px(style, hidden, input),
    }
}

// On a character grid every length becomes whole cells. A length under half a cell is a hairline, which still
// needs a whole row or column to draw its line in, and a visible border needs a cell of padding to be drawn in.
// Vertical lengths round up only from 0.7 of a row, so rows sized 1.4 or 1.5 lines stay one row, as in a terminal UI.
fn snap_to_grid(style: &Style, (cw, ch): (f32, f32)) -> Style {
    let round_x = |v: f32| (v / cw).round().max(0.0) * cw;
    let round_y = |v: f32| (v / ch - 0.2).round().max(0.0) * ch;
    let size_x = |d: Dimension| match d {
        Dimension::Px(v) if v > 0.0 => Dimension::Px(round_x(v).max(cw)),
        other => other,
    };
    let size_y = |d: Dimension| match d {
        Dimension::Px(v) if v > 0.0 => Dimension::Px(round_y(v).max(ch)),
        other => other,
    };
    let inset_x = |v: Option<InsetValue>| match v {
        Some(InsetValue::Px(v)) => Some(InsetValue::Px(round_x(v.abs()).copysign(v))),
        other => other,
    };
    let inset_y = |v: Option<InsetValue>| match v {
        Some(InsetValue::Px(v)) => Some(InsetValue::Px(round_y(v.abs()).copysign(v))),
        other => other,
    };
    let visible = |side: Option<crate::style::BorderSide>| side.is_some_and(|s| s.width > 0.0 && s.color[3] > 0);
    let border = style.border.unwrap_or_default();
    let pad = |snapped: f32, step: f32, bordered: bool| if bordered { snapped.max(step) } else { snapped };
    let padding = Edges {
        left: pad(round_x(style.padding.left), cw, visible(border.left)),
        right: pad(round_x(style.padding.right), cw, visible(border.right)),
        top: pad(round_y(style.padding.top), ch, visible(border.top)),
        bottom: pad(round_y(style.padding.bottom), ch, visible(border.bottom)),
    };
    let extra_w = padding.left - round_x(style.padding.left) + padding.right - round_x(style.padding.right);
    let extra_h = padding.top - round_y(style.padding.top) + padding.bottom - round_y(style.padding.bottom);
    let grown = |d: Dimension, extra: f32| match d {
        Dimension::Px(v) => Dimension::Px(v + extra),
        other => other,
    };
    let mut snapped = style.clone();
    snapped.width = grown(size_x(style.width), extra_w);
    snapped.height = grown(size_y(style.height), extra_h);
    snapped.min_width = size_x(style.min_width);
    snapped.max_width = size_x(style.max_width);
    snapped.max_height = size_y(style.max_height);
    snapped.padding = padding;
    snapped.margin = Edges {
        left: round_x(style.margin.left.abs()).copysign(style.margin.left),
        right: round_x(style.margin.right.abs()).copysign(style.margin.right),
        top: round_y(style.margin.top.abs()).copysign(style.margin.top),
        bottom: round_y(style.margin.bottom.abs()).copysign(style.margin.bottom),
    };
    snapped.inset.left = inset_x(style.inset.left);
    snapped.inset.right = inset_x(style.inset.right);
    snapped.inset.top = inset_y(style.inset.top);
    snapped.inset.bottom = inset_y(style.inset.bottom);
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

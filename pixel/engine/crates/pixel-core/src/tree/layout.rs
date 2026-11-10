
use crate::canvas::measure_marked;
use crate::style::{Align, Dimension, FlexDirection, InsetValue, Justify, Overflow, Paint, Position, Style};
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

pub(super) fn to_taffy(style: &Style, hidden: bool, input: bool, lattice: (f32, f32)) -> taffy::Style {
    let mut taffy = to_taffy_px(&at_least_one_unit(style, lattice), hidden, input);
    if let Some(border) = style.border {
        // A border is drawn at least one lattice unit wide, so it keeps room for whatever of that unit its
        // stroke doesn't cover.
        let room = |side: Option<crate::style::BorderSide>, unit: f32| {
            side.filter(|s| s.width > 0.0 && s.color[3] > 0).map_or(0.0, |s| (unit - s.width).max(0.0))
        };
        let (x, y) = lattice;
        taffy.border = taffy::Rect {
            left: taffy::LengthPercentage::length(room(border.left, x)),
            right: taffy::LengthPercentage::length(room(border.right, x)),
            top: taffy::LengthPercentage::length(room(border.top, y)),
            bottom: taffy::LengthPercentage::length(room(border.bottom, y)),
        };
    }
    taffy
}

// A box that paints never shrinks below one lattice unit, so a hairline still gets a row or column of its own.
fn at_least_one_unit(style: &Style, (x, y): (f32, f32)) -> std::borrow::Cow<'_, Style> {
    let paints = match &style.background {
        Some(Paint::Solid(color)) => color[3] > 0,
        Some(Paint::Gradient(_)) => true,
        None => false,
    };
    let thin = |d: Dimension, unit: f32| matches!(d, Dimension::Px(v) if v > 0.0 && v < unit);
    if !paints || !(thin(style.width, x) || thin(style.height, y)) {
        return std::borrow::Cow::Borrowed(style);
    }
    let mut grown = style.clone();
    if thin(style.width, x) {
        grown.width = Dimension::Px(x);
    }
    if thin(style.height, y) {
        grown.height = Dimension::Px(y);
    }
    std::borrow::Cow::Owned(grown)
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

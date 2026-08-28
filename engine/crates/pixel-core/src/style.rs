pub type Color = [u8; 4];

pub const DEFAULT_SELECTION_COLOR: Color = [90, 90, 140, 255];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SelectionMode {
    #[default]
    Text,
    Unified,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Dimension {
    #[default]
    Auto,
    Px(f32),
    Percent(f32),
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Edges {
    pub left: f32,
    pub right: f32,
    pub top: f32,
    pub bottom: f32,
}

impl Edges {
    pub fn all(v: f32) -> Self {
        Self {
            left: v,
            right: v,
            top: v,
            bottom: v,
        }
    }

    pub fn symmetric(horizontal: f32, vertical: f32) -> Self {
        Self {
            left: horizontal,
            right: horizontal,
            top: vertical,
            bottom: vertical,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlexDirection {
    #[default]
    Row,
    Column,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Justify {
    Start,
    Center,
    End,
    SpaceBetween,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Start,
    Center,
    End,
    Stretch,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Overflow {
    #[default]
    Visible,
    Hidden,
    Scroll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Position {
    #[default]
    Flow,
    Absolute,
}

/**
 * hm, not sure if we want an explicit inset api
 */
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InsetValue {
    Px(f32),
    Percent(f32),
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Inset {
    pub left: Option<InsetValue>,
    pub top: Option<InsetValue>,
    pub right: Option<InsetValue>,
    pub bottom: Option<InsetValue>,
}

impl Inset {
    pub fn top_left(x: f32, y: f32) -> Self {
        Self {
            left: Some(InsetValue::Px(x)),
            top: Some(InsetValue::Px(y)),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BorderSide {
    pub width: f32,
    pub color: Color,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Border {
    pub top: Option<BorderSide>,
    pub right: Option<BorderSide>,
    pub bottom: Option<BorderSide>,
    pub left: Option<BorderSide>,
}

impl Border {
    pub fn all(width: f32, color: Color) -> Self {
        let side = Some(BorderSide { width, color });
        Self {
            top: side,
            right: side,
            bottom: side,
            left: side,
        }
    }

    pub fn hairline(color: Color) -> Self {
        Self::all(1.0, color)
    }

    pub(crate) fn uniform(&self) -> Option<BorderSide> {
        let side = self.top?;
        (self.right == Some(side) && self.bottom == Some(side) && self.left == Some(side))
            .then_some(side)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrollbarStyle {
    pub width: f32,
    pub hover_width: f32,
    pub margin: f32,
    pub min_thumb: f32,
    pub thumb_color: Color,
    pub thumb_hover_color: Color,
    pub track_color: Color,
}

impl ScrollbarStyle {
    pub fn for_rem(rem: f32) -> Self {
        Self {
            width: (rem * 0.3).max(3.0),
            hover_width: (rem * 0.55).max(6.0),
            margin: (rem * 0.15).max(2.0),
            min_thumb: rem * 1.5,
            thumb_color: [150, 150, 150, 140],
            thumb_hover_color: [175, 175, 175, 210],
            track_color: [128, 128, 128, 40],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinearGradient {
    pub from: (f32, f32),
    pub to: (f32, f32),
    pub stops: Vec<(f32, Color)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Paint {
    Solid(Color),
    Gradient(LinearGradient),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Style {
    pub flex_direction: FlexDirection,
    pub flex_grow: f32,
    pub flex_shrink: f32,
    pub flex_basis: Dimension,
    pub width: Dimension,
    pub height: Dimension,
    pub min_width: Dimension,
    pub max_width: Dimension,
    pub max_height: Dimension,
    pub padding: Edges,
    pub margin: Edges,
    pub gap: f32,
    pub position: Position,
    pub inset: Inset,
    pub overflow: Overflow,
    pub justify_content: Option<Justify>,
    pub align_items: Option<Align>,
    pub background: Option<Paint>,
    pub corner_radius: [f32; 4], // i dont love this, maybe deconstruct into sepearte api's
    pub border: Option<Border>,
    pub color: Option<Color>,
    pub font_size: Option<f32>,
    pub font: Option<usize>,
    pub hover_background: Option<Color>, // seems weird but is not that bad of a representation
    pub hover_color: Option<Color>,
    pub scrollbar: Option<ScrollbarStyle>,
    pub wrap: bool,
    pub selectable: Option<bool>,
    pub selection_color: Option<Color>,
    pub selection_mode: SelectionMode,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            flex_direction: FlexDirection::default(),
            flex_grow: 0.0,
            flex_shrink: 1.0,
            flex_basis: Dimension::default(),
            width: Dimension::default(),
            height: Dimension::default(),
            min_width: Dimension::default(),
            max_width: Dimension::default(),
            max_height: Dimension::default(),
            padding: Edges::default(),
            margin: Edges::default(),
            gap: 0.0,
            position: Position::default(),
            inset: Inset::default(),
            overflow: Overflow::default(),
            justify_content: None,
            align_items: None,
            background: None,
            corner_radius: [0.0; 4],
            border: None,
            color: None,
            font_size: None,
            font: None,
            hover_background: None,
            hover_color: None,
            scrollbar: None,
            wrap: true,
            selectable: None,
            selection_color: None,
            selection_mode: SelectionMode::default(),
        }
    }
}

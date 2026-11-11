use crate::image_cache::ImageStatus;
use crate::shape::ShapeProps;
use crate::style::{Color, LinearGradient};
use crate::text_input::{CaretShape, Mark};
use crate::tree::PxRect;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Scene {
    pub root: Item,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Item {
    pub node: u64,
    pub bounds: PxRect,
    pub clips: bool,
    pub opaque: bool,
    pub radius: [f32; 4],
    pub fills: Fills,
    pub surface: Option<u32>,
    pub layer: Option<Layer>,
    pub ops: Vec<Op>,
    pub inner: Vec<Op>,
    pub children: Vec<Item>,
    pub after: Vec<Op>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Fills {
    pub content: bool,
    pub solid: bool,
    pub hover: bool,
    pub border: bool,
    pub sides: [f32; 4],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layer {
    pub z: u32,
    pub kind: LayerKind,
    pub change: Change,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LayerKind {
    Scroll(Scroll),
    Sticky { stuck: bool },
    Surface,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scroll {
    pub offset: f32,
    pub extent: f32,
    pub anchored: i64,
    pub list: bool,
    pub bar: Option<BarState>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BarState {
    pub zone: PxRect,
    pub thumb: PxRect,
    pub opacity: f32,
    pub expand: f32,
    pub thumb_color: Color,
    pub thumb_hover_color: Color,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Change {
    #[default]
    New,
    Content,
    Offset { by: i64 },
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Rect { rect: PxRect, radius: [f32; 4], color: Color },
    Gradient { rect: PxRect, radius: [f32; 4], gradient: LinearGradient },
    Border { rect: PxRect, radius: [f32; 4], width: f32, color: Color },
    Rule { rect: PxRect, color: Color },
    Text(Text),
    Image(Image),
    Surface(Surface),
    Icon(Icon),
    Caret(Caret),
    Selection { rect: PxRect, color: Color },
    Scrollbar(Scrollbar),
    Clip(PxRect),
    Unclip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextStyle {
    Run,
    Span { underline: bool, strikethrough: bool },
    Label,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Text {
    pub text: String,
    pub font: usize,
    pub face: usize,
    pub px: f32,
    pub x: f32,
    pub top: f32,
    pub ascent: f32,
    pub width: f32,
    pub color: Color,
    pub bold: bool,
    pub italic: bool,
    pub style: TextStyle,
    pub marks: Vec<Mark>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub rect: PxRect,
    pub radius: [f32; 4],
    pub src: String,
    pub equal_to: Vec<String>,
    pub status: ImageStatus,
    pub broken_icon: bool,
    pub px: f32,
    pub color: Color,
    pub glyph: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Surface {
    pub rect: PxRect,
    pub radius: [f32; 4],
    pub surface: u32,
    pub empty: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Icon {
    pub rect: PxRect,
    pub path: ShapeProps,
    pub glyph: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Caret {
    pub rect: PxRect,
    pub shape: CaretShape,
    pub color: Color,
    pub under: Option<char>,
    pub font: usize,
    pub px: f32,
    pub ascent: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Scrollbar {
    pub track: Option<(PxRect, Color)>,
    pub thumb: (PxRect, Color),
}

impl Scene {
    pub fn layers(&self) -> Vec<&Item> {
        let mut out = Vec::new();
        self.root.collect_layers(&mut out);
        out
    }

    pub fn find(&self, node: u64) -> Option<&Item> {
        self.root.find(node)
    }
}

impl Item {
    fn collect_layers<'a>(&'a self, out: &mut Vec<&'a Item>) {
        if self.layer.is_some() {
            out.push(self);
        }
        for child in &self.children {
            child.collect_layers(out);
        }
    }

    pub fn find(&self, node: u64) -> Option<&Item> {
        if self.node == node {
            return Some(self);
        }
        self.children.iter().find_map(|child| child.find(node))
    }

    pub fn scroll(&self) -> Option<&Scroll> {
        match &self.layer {
            Some(Layer { kind: LayerKind::Scroll(scroll), .. }) => Some(scroll),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Divider {
    pub x: u32,
    pub width: u32,
    pub engaged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Damage<'a> {
    None,
    Whole { surfaces: &'a [crate::surfaces::Rect] },
    Parts(&'a [crate::surfaces::Rect]),
}

#[derive(Debug, Clone, Copy)]
pub struct ViewFrame<'a> {
    pub view: usize,
    pub origin_x: u32,
    pub size: (u32, u32),
    pub clear: Color,
    pub scene: &'a Scene,
    pub damage: Damage<'a>,
}

#[derive(Clone, Copy)]
pub struct Frame<'a> {
    pub window: (u32, u32),
    pub fonts: &'a [crate::fonts::Font],
    pub views: &'a [ViewFrame<'a>],
    pub divider: Option<Divider>,
    pub overlay: &'a [Op],
    pub relayout: bool,
}

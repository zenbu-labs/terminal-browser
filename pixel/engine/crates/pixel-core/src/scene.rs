use crate::style::{Color, LinearGradient};
use crate::text_input::CaretShape;
use crate::tree::PxRect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RectKind {
    Fill,
    Edge,
    Selection,
    Scrollbar,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextRun {
    pub text: String,
    pub x: f32,
    pub top: f32,
    pub color: Color,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub gaps: Vec<(usize, f32)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ImageState {
    Ready,
    Pending,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SceneOp {
    Rect { rect: PxRect, radius: [f32; 4], color: Color, kind: RectKind },
    Gradient { rect: PxRect, radius: [f32; 4], gradient: LinearGradient },
    Border { rect: PxRect, radius: [f32; 4], width: f32, color: Color },
    Text(TextRun),
    Image { rect: PxRect, src: String, equal_to: Vec<String>, state: ImageState, fallback: Option<String>, color: Color },
    Surface { rect: PxRect },
    Shape { rect: PxRect, color: Color, fallback: Option<String> },
    Caret { rect: PxRect, shape: CaretShape, color: Color },
    PushClip(PxRect),
    PopClip,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Scene {
    pub ops: Vec<SceneOp>,
}

impl Scene {
    pub fn caret(&self) -> Option<(PxRect, CaretShape, Color)> {
        self.ops.iter().rev().find_map(|op| match op {
            SceneOp::Caret { rect, shape, color } => Some((*rect, *shape, *color)),
            _ => None,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ViewScene<'a> {
    pub view: usize,
    pub origin: (u32, u32),
    pub size: (u32, u32),
    pub clear: Color,
    pub scene: &'a Scene,
    pub changed: bool,
}

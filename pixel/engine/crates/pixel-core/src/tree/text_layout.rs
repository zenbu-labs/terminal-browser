use super::{NodeId, PxRect, Tree};
use crate::text_input::line_height;
use crate::text_metrics::char_advance;
use crate::wrap::wrap_lines;

#[derive(Debug, Clone, PartialEq)]
pub struct TextLayout {
    pub scope: NodeId,
    pub clip: PxRect,
    pub leaves: Vec<TextLeaf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextLeaf {
    pub node: NodeId,
    pub text: String,
    pub lines: Vec<TextLine>,
    pub links: Vec<super::TextLink>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    pub start: usize,
    pub end: usize,
    pub y: f32,
    pub height: f32,
    pub carets: Vec<f32>,
}

impl Tree {
    pub fn text_document_at(&self, point: (f32, f32)) -> Option<NodeId> {
        self.nodes_at(point.0, point.1).into_iter().find(|&id| self.node(id).selection_events)
    }

    pub fn text_layout(&mut self, scope: NodeId, fonts: &[crate::fonts::Font]) -> Option<TextLayout> {
        let clip = self.get(scope)?.visible;
        let mut leaves = Vec::new();
        let mut stack = vec![scope];
        while let Some(id) = stack.pop() {
            let node = self.node(id);
            if node.hidden || (node.mark.is_some() && !node.mark_visible) || (node.slot.is_some() && !node.slot_visible) {
                continue;
            }
            stack.extend(node.children.iter().rev());
            if self.selectable_text_leaf(id) {
                leaves.push(TextLeaf {
                    node: id,
                    text: self.text_of(id).unwrap_or_default().to_string(),
                    lines: self.drawn_lines(id, clip, fonts),
                    links: self.node(id).links.clone(),
                });
            }
        }
        Some(TextLayout { scope, clip, leaves })
    }

    fn drawn_lines(&self, id: NodeId, clip: PxRect, fonts: &[crate::fonts::Font]) -> Vec<TextLine> {
        let node = self.node(id);
        let visible = node.visible;
        let shown = !node.offscreen && visible.w > 0.0 && visible.h > 0.0 && visible.y < clip.y + clip.h && visible.y + visible.h > clip.y;
        let (Some(geometry), Some(text)) = (self.text_geometry(id), self.text_of(id)) else {
            return Vec::new();
        };
        if !shown || fonts.is_empty() {
            return Vec::new();
        }
        let font = &fonts[geometry.font.min(fonts.len() - 1)];
        let marks = node.marks();
        let height = line_height(font, geometry.px);
        wrap_lines(text, font, geometry.px, geometry.max_width, marks)
            .into_iter()
            .enumerate()
            .map(|(row, range)| {
                let mut pen = geometry.origin.0;
                let mut carets = vec![pen];
                for (i, c) in text[range.clone()].char_indices() {
                    pen += char_advance(font, c, range.start + i, geometry.px, marks);
                    carets.push(pen);
                }
                TextLine { start: range.start, end: range.end, y: geometry.origin.1 + row as f32 * height, height, carets }
            })
            .collect()
    }
}

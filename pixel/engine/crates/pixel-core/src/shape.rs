use crate::style::Color;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LineCap {
    Butt,
    #[default]
    Round,
    Square,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LineJoin {
    Miter,
    #[default]
    Round,
    Bevel,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShapeStroke {
    pub width: f32,
    pub color: Color,
    pub cap: LineCap,
    pub join: LineJoin,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathCmd {
    MoveTo(f32, f32),
    LineTo(f32, f32),
    QuadTo(f32, f32, f32, f32),
    CubicTo(f32, f32, f32, f32, f32, f32),
    Close,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShapeProps {
    pub cmds: Vec<PathCmd>,
    pub stroke: ShapeStroke,
    pub view_box: Option<f32>,
}

pub fn parse_path_data(d: &str) -> Vec<PathCmd> {
    let mut cmds = Vec::new();
    let mut nums: Vec<f32> = Vec::new();
    let mut verb = None;
    let mut pending = String::new();
    let flush_num = |pending: &mut String, nums: &mut Vec<f32>| {
        if !pending.is_empty() {
            if let Ok(v) = pending.parse::<f32>() {
                nums.push(v);
            }
            pending.clear();
        }
    };
    let flush_verb = |verb: char, nums: &mut Vec<f32>, cmds: &mut Vec<PathCmd>| {
        let take = |n: &mut Vec<f32>, count: usize| -> Vec<Vec<f32>> {
            let groups = n.len() / count;
            let out = (0..groups)
                .map(|g| n[g * count..(g + 1) * count].to_vec())
                .collect();
            n.clear();
            out
        };
        match verb {
            'M' => {
                for (i, p) in take(nums, 2).into_iter().enumerate() {
                    if i == 0 {
                        cmds.push(PathCmd::MoveTo(p[0], p[1]));
                    } else {
                        cmds.push(PathCmd::LineTo(p[0], p[1]));
                    }
                }
            }
            'L' => {
                for p in take(nums, 2) {
                    cmds.push(PathCmd::LineTo(p[0], p[1]));
                }
            }
            'Q' => {
                for p in take(nums, 4) {
                    cmds.push(PathCmd::QuadTo(p[0], p[1], p[2], p[3]));
                }
            }
            'C' => {
                for p in take(nums, 6) {
                    cmds.push(PathCmd::CubicTo(p[0], p[1], p[2], p[3], p[4], p[5]));
                }
            }
            'Z' => {
                nums.clear();
                cmds.push(PathCmd::Close);
            }
            _ => nums.clear(),
        }
    };
    for ch in d.chars() {
        match ch {
            'M' | 'L' | 'Q' | 'C' | 'Z' | 'z' => {
                flush_num(&mut pending, &mut nums);
                if let Some(v) = verb {
                    flush_verb(v, &mut nums, &mut cmds);
                }
                verb = Some(ch.to_ascii_uppercase());
            }
            '0'..='9' | '.' | 'e' | 'E' => pending.push(ch),
            '-' | '+' => {
                if pending.ends_with(['e', 'E']) {
                    pending.push(ch);
                } else {
                    flush_num(&mut pending, &mut nums);
                    pending.push(ch);
                }
            }
            _ => flush_num(&mut pending, &mut nums),
        }
    }
    flush_num(&mut pending, &mut nums);
    if let Some(v) = verb {
        flush_verb(v, &mut nums, &mut cmds);
    }
    cmds
}

pub fn build_path(cmds: &[PathCmd]) -> Option<tiny_skia::Path> {
    let mut pb = tiny_skia::PathBuilder::new();
    for cmd in cmds {
        match *cmd {
            PathCmd::MoveTo(x, y) => pb.move_to(x, y),
            PathCmd::LineTo(x, y) => pb.line_to(x, y),
            PathCmd::QuadTo(cx, cy, x, y) => pb.quad_to(cx, cy, x, y),
            PathCmd::CubicTo(c1x, c1y, c2x, c2y, x, y) => pb.cubic_to(c1x, c1y, c2x, c2y, x, y),
            PathCmd::Close => pb.close(),
        }
    }
    pb.finish()
}

pub fn skia_stroke(stroke: &ShapeStroke, scale: f32) -> tiny_skia::Stroke {
    tiny_skia::Stroke {
        width: (stroke.width * scale).max(0.1),
        line_cap: match stroke.cap {
            LineCap::Butt => tiny_skia::LineCap::Butt,
            LineCap::Round => tiny_skia::LineCap::Round,
            LineCap::Square => tiny_skia::LineCap::Square,
        },
        line_join: match stroke.join {
            LineJoin::Miter => tiny_skia::LineJoin::Miter,
            LineJoin::Round => tiny_skia::LineJoin::Round,
            LineJoin::Bevel => tiny_skia::LineJoin::Bevel,
        },
        ..tiny_skia::Stroke::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_path_handles_verbs_and_negatives() {
        let cmds = parse_path_data("M 0 0 L 10 -5 C 1 2 3 4 5 6 Z");
        assert_eq!(
            cmds,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(10.0, -5.0),
                PathCmd::CubicTo(1.0, 2.0, 3.0, 4.0, 5.0, 6.0),
                PathCmd::Close,
            ]
        );
    }

    #[test]
    fn parse_path_repeats_implicit_lineto_after_moveto() {
        let cmds = parse_path_data("M0,0 10,10 20,0");
        assert_eq!(
            cmds,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(10.0, 10.0),
                PathCmd::LineTo(20.0, 0.0),
            ]
        );
    }

}

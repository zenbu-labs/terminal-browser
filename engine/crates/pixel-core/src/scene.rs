use crate::style::Color;
use crate::tree::PxRect;

// World point at the scene's top-left corner, plus scale. screen = origin + (world - camera) * zoom.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Camera {
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

impl Camera {
    pub fn to_screen(&self, origin: (f32, f32), wx: f32, wy: f32) -> (f32, f32) {
        (
            origin.0 + (wx - self.x) * self.zoom,
            origin.1 + (wy - self.y) * self.zoom,
        )
    }

    pub fn to_world(&self, origin: (f32, f32), sx: f32, sy: f32) -> (f32, f32) {
        (
            (sx - origin.0) / self.zoom + self.x,
            (sy - origin.1) / self.zoom + self.y,
        )
    }

    pub fn rect_to_screen(&self, origin: (f32, f32), r: PxRect) -> PxRect {
        let (x, y) = self.to_screen(origin, r.x, r.y);
        PxRect {
            x,
            y,
            w: r.w * self.zoom,
            h: r.h * self.zoom,
        }
    }

    pub(crate) fn transform(&self, origin: (f32, f32)) -> tiny_skia::Transform {
        tiny_skia::Transform::from_row(
            self.zoom,
            0.0,
            0.0,
            self.zoom,
            origin.0 - self.x * self.zoom,
            origin.1 - self.y * self.zoom,
        )
    }
}

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

// Geometry is in world coordinates. Text and Image reuse the node's regular
// `text`/`image` props for content; the shape only supplies placement.
#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    Rect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        corner_radius: f32,
    },
    Ellipse {
        cx: f32,
        cy: f32,
        rx: f32,
        ry: f32,
    },
    // Flat [x0, y0, x1, y1, ...]; stroke only.
    Polyline {
        points: Vec<f32>,
    },
    Path {
        cmds: Vec<PathCmd>,
    },
    Text {
        x: f32,
        y: f32,
    },
    Image {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShapeProps {
    pub shape: Shape,
    pub fill: Option<Color>,
    pub stroke: Option<ShapeStroke>,
}

impl ShapeProps {
    // World-space bounds for placement and hit testing. Text is measured by
    // the caller since it needs fonts; this returns None for it.
    pub(crate) fn world_bounds(&self) -> Option<PxRect> {
        let outset = self.stroke.map_or(0.0, |s| s.width / 2.0);
        let raw = match &self.shape {
            Shape::Rect { x, y, w, h, .. } => PxRect {
                x: *x,
                y: *y,
                w: *w,
                h: *h,
            },
            Shape::Ellipse { cx, cy, rx, ry } => PxRect {
                x: cx - rx,
                y: cy - ry,
                w: rx * 2.0,
                h: ry * 2.0,
            },
            Shape::Polyline { points } => points_bounds(points.chunks_exact(2).map(|p| (p[0], p[1])))?,
            Shape::Path { cmds } => points_bounds(cmds.iter().flat_map(cmd_points))?,
            Shape::Image { x, y, w, h } => PxRect {
                x: *x,
                y: *y,
                w: *w,
                h: *h,
            },
            Shape::Text { .. } => return None,
        };
        Some(PxRect {
            x: raw.x - outset,
            y: raw.y - outset,
            w: raw.w + outset * 2.0,
            h: raw.h + outset * 2.0,
        })
    }
}

fn cmd_points(cmd: &PathCmd) -> Vec<(f32, f32)> {
    match *cmd {
        PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => vec![(x, y)],
        PathCmd::QuadTo(cx, cy, x, y) => vec![(cx, cy), (x, y)],
        PathCmd::CubicTo(c1x, c1y, c2x, c2y, x, y) => vec![(c1x, c1y), (c2x, c2y), (x, y)],
        PathCmd::Close => vec![],
    }
}

fn points_bounds(points: impl Iterator<Item = (f32, f32)>) -> Option<PxRect> {
    let mut bounds: Option<(f32, f32, f32, f32)> = None;
    for (x, y) in points {
        bounds = Some(match bounds {
            None => (x, y, x, y),
            Some((x1, y1, x2, y2)) => (x1.min(x), y1.min(y), x2.max(x), y2.max(y)),
        });
    }
    let (x1, y1, x2, y2) = bounds?;
    Some(PxRect {
        x: x1,
        y: y1,
        w: x2 - x1,
        h: y2 - y1,
    })
}

// Absolute-coordinate subset of SVG path data: M, L, Q, C, Z.
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

pub(crate) fn build_path(shape: &Shape) -> Option<tiny_skia::Path> {
    match shape {
        Shape::Rect {
            x,
            y,
            w,
            h,
            corner_radius,
        } => crate::canvas::rounded_rect_path(*x, *y, *w, *h, [*corner_radius; 4]),
        Shape::Ellipse { cx, cy, rx, ry } => {
            let mut pb = tiny_skia::PathBuilder::new();
            pb.push_oval(tiny_skia::Rect::from_xywh(
                cx - rx,
                cy - ry,
                rx * 2.0,
                ry * 2.0,
            )?);
            pb.finish()
        }
        Shape::Polyline { points } => {
            let mut pb = tiny_skia::PathBuilder::new();
            let mut chunks = points.chunks_exact(2);
            let first = chunks.next()?;
            pb.move_to(first[0], first[1]);
            for p in chunks {
                pb.line_to(p[0], p[1]);
            }
            pb.finish()
        }
        Shape::Path { cmds } => {
            let mut pb = tiny_skia::PathBuilder::new();
            for cmd in cmds {
                match *cmd {
                    PathCmd::MoveTo(x, y) => pb.move_to(x, y),
                    PathCmd::LineTo(x, y) => pb.line_to(x, y),
                    PathCmd::QuadTo(cx, cy, x, y) => pb.quad_to(cx, cy, x, y),
                    PathCmd::CubicTo(c1x, c1y, c2x, c2y, x, y) => {
                        pb.cubic_to(c1x, c1y, c2x, c2y, x, y)
                    }
                    PathCmd::Close => pb.close(),
                }
            }
            pb.finish()
        }
        Shape::Text { .. } | Shape::Image { .. } => None,
    }
}

pub(crate) fn skia_stroke(stroke: &ShapeStroke, zoom: f32) -> tiny_skia::Stroke {
    tiny_skia::Stroke {
        width: (stroke.width * zoom).max(0.1),
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
    fn camera_round_trips_points() {
        let cam = Camera {
            x: 100.0,
            y: 50.0,
            zoom: 2.0,
        };
        let origin = (10.0, 20.0);
        let (sx, sy) = cam.to_screen(origin, 130.0, 80.0);
        assert_eq!((sx, sy), (70.0, 80.0));
        assert_eq!(cam.to_world(origin, sx, sy), (130.0, 80.0));
    }

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

    #[test]
    fn polyline_bounds_include_stroke_outset() {
        let props = ShapeProps {
            shape: Shape::Polyline {
                points: vec![0.0, 0.0, 10.0, 20.0],
            },
            fill: None,
            stroke: Some(ShapeStroke {
                width: 4.0,
                color: [0, 0, 0, 255],
                cap: LineCap::Round,
                join: LineJoin::Round,
            }),
        };
        let b = props.world_bounds().unwrap();
        assert_eq!((b.x, b.y, b.w, b.h), (-2.0, -2.0, 14.0, 24.0));
    }
}

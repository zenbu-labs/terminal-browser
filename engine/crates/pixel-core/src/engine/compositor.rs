use crate::canvas::Canvas;
use crate::style::Color;
use crate::surfaces::Rect;
use crate::tree::Tree;

const DIVIDER_W: u32 = 6;
const DIVIDER_GRAB: f32 = 5.0;
const MIN_PANE: u32 = 160;

const DIVIDER_BG: Color = [32, 33, 38, 255];
const DIVIDER_BG_ACTIVE: Color = [58, 96, 168, 255];
const DIVIDER_GRIP: Color = [118, 122, 132, 255];

pub struct View {
    pub tree: Tree,
    pub canvas: Canvas,
    pub clear_color: Color,
    pub clear_color_owned: bool,
    pub origin_x: u32,
    pub size: (u32, u32),
    pub damage: Rect,
}

impl View {
    fn new(window: (u32, u32)) -> Self {
        Self {
            tree: Tree::new((window.0 as f32, window.1 as f32)),
            canvas: Canvas::new(window.0, window.1),
            clear_color: [0, 0, 0, 255],
            clear_color_owned: false,
            origin_x: 0,
            size: window,
            damage: Rect::default(),
        }
    }

    fn contains(&self, x: f32) -> bool {
        x >= self.origin_x as f32 && x < (self.origin_x + self.size.0) as f32
    }
}

pub struct Compositor {
    pub views: Vec<View>,
    pub window: (u32, u32),
    pub frame: Canvas,
    pub dirty: bool,
    pub divider_drag: bool,
    pub split: Option<f32>,
    pub relayout: bool,
    panes: [usize; 2],
    divider_hover: bool,
}

impl Compositor {
    pub(crate) fn new(window: (u32, u32)) -> Self {
        Self {
            views: vec![View::new(window), View::new((0, 0))],
            window,
            frame: Canvas::new(window.0, window.1),
            dirty: true,
            divider_drag: false,
            split: None,
            relayout: true,
            panes: [0, 1],
            divider_hover: false,
        }
    }

    pub(crate) fn add_view(&mut self) -> usize {
        self.views.push(View::new((0, 0)));
        self.views.len() - 1
    }

    pub(crate) fn set_split(&mut self, split: Option<f32>) -> bool {
        let split = split.map(|f| f.clamp(0.15, 0.85));
        if self.split == split {
            return false;
        }
        self.split = split;
        true
    }

    pub(crate) fn set_pane(&mut self, slot: usize, view: usize) -> bool {
        if slot >= self.panes.len() || view >= self.views.len() {
            return false;
        }
        let other = self.panes[1 - slot];
        if self.panes[slot] == view || other == view {
            return false;
        }
        self.panes[slot] = view;
        true
    }

    pub(crate) fn active_views(&self) -> Vec<usize> {
        if self.split.is_some() {
            vec![self.panes[0], self.panes[1]]
        } else {
            vec![self.panes[0]]
        }
    }

    pub(crate) fn is_active(&self, view: usize) -> bool {
        self.active_views().contains(&view)
    }

    pub(crate) fn view_at(&self, x: f32) -> usize {
        if self.split.is_some() && self.views[self.panes[1]].contains(x) {
            self.panes[1]
        } else {
            self.panes[0]
        }
    }

    pub(crate) fn to_local(&self, view: usize, point: (f32, f32)) -> (f32, f32) {
        (point.0 - self.views[view].origin_x as f32, point.1)
    }

    pub(crate) fn divider_x(&self) -> Option<u32> {
        let f = self.split?;
        let w = self.window.0;
        if w <= 2 * MIN_PANE + DIVIDER_W {
            return Some(w.saturating_sub(DIVIDER_W) / 2);
        }
        let x = (w as f32 * f).round() as u32;
        Some(x.clamp(MIN_PANE, w - MIN_PANE - DIVIDER_W))
    }

    pub(crate) fn on_divider(&self, x: f32) -> bool {
        self.divider_x().is_some_and(|dx| {
            x >= dx as f32 - DIVIDER_GRAB && x < (dx + DIVIDER_W) as f32 + DIVIDER_GRAB
        })
    }

    pub(crate) fn set_divider_hover(&mut self, on: bool) {
        if self.divider_hover != on {
            self.divider_hover = on;
            self.dirty = true;
        }
    }

    pub(crate) fn apply_layout(&mut self, force: bool) -> Vec<(usize, (u32, u32))> {
        let (w, h) = self.window;
        let rects: [(u32, u32); 2] = match self.divider_x() {
            Some(dx) => [(0, dx), (dx + DIVIDER_W, w.saturating_sub(dx + DIVIDER_W))],
            None => [(0, w), (0, 0)],
        };
        let active = self.active_views();
        let mut resized = Vec::new();
        for (slot, (origin, width)) in rects.iter().enumerate() {
            let index = self.panes[slot];
            let view = &mut self.views[index];
            let size = (*width, h);
            let changed = force || view.size != size || view.origin_x != *origin;
            view.origin_x = *origin;
            view.size = size;
            if !changed || !active.contains(&index) {
                continue;
            }
            view.tree.set_window((size.0 as f32, size.1 as f32));
            resized.push((index, size));
        }
        self.dirty = true;
        self.relayout = true;
        resized
    }

    pub(crate) fn drag_divider(&mut self, x: f32) -> Vec<(usize, (u32, u32))> {
        let w = self.window.0.max(1) as f32;
        let f = (x / w).clamp(0.15, 0.85);
        if self.split == Some(f) {
            return Vec::new();
        }
        self.split = Some(f);
        self.apply_layout(false)
    }

    pub(crate) fn compose(&mut self, painted: &[(usize, Rect)], whole_frame: bool) {
        let resized = (self.frame.width, self.frame.height) != self.window;
        if resized {
            self.frame = Canvas::new(self.window.0, self.window.1);
        }
        let everything = resized || whole_frame || std::mem::take(&mut self.relayout);
        for view in self.active_views() {
            let size = self.views[view].size;
            let rect = if everything {
                Rect::sized(size.0, size.1)
            } else {
                painted
                    .iter()
                    .find(|(index, _)| *index == view)
                    .map_or(Rect::default(), |(_, rect)| *rect)
            };
            if rect.is_empty() {
                continue;
            }
            let origin = self.views[view].origin_x;
            let (canvas, frame) = (&self.views[view].canvas, &mut self.frame);
            blit(frame, canvas, origin, rect);
        }
        self.draw_divider();
    }

    fn draw_divider(&mut self) {
        let Some(dx) = self.divider_x() else {
            return;
        };
        let engaged = self.divider_hover || self.divider_drag;
        let bg = if engaged {
            DIVIDER_BG_ACTIVE
        } else {
            DIVIDER_BG
        };
        self.frame.fill_rect(dx, 0, DIVIDER_W, self.window.1, bg);
        let cx = dx as f32 + DIVIDER_W as f32 / 2.0;
        let cy = self.window.1 as f32 / 2.0;
        for i in -1..=1i32 {
            self.frame.fill_rounded_rect(
                cx - 1.0,
                cy + (i as f32) * 7.0 - 1.0,
                2.0,
                2.0,
                [1.0; 4],
                DIVIDER_GRIP,
            );
        }
    }
}

fn blit(dst: &mut Canvas, src: &Canvas, origin_x: u32, region: Rect) {
    let region = region.clamped(src.width, src.height);
    let dst_x = origin_x + region.x;
    if region.is_empty() || dst_x >= dst.width || region.y >= dst.height {
        return;
    }
    let cols = (region.w.min(dst.width - dst_x)) as usize * 4;
    let rows = region.h.min(dst.height - region.y) as usize;
    let src_stride = src.width as usize * 4;
    let dst_stride = dst.width as usize * 4;
    let src_col = region.x as usize * 4;
    let dst_col = dst_x as usize * 4;
    let y0 = region.y as usize;
    let dst_rows = &mut dst.pixels[y0 * dst_stride..(y0 + rows) * dst_stride];
    crate::parallel::row_bands(
        dst_rows,
        dst_stride,
        rows,
        1 << 20,
        |band, first, count| {
            for r in 0..count {
                let src_start = (y0 + first + r) * src_stride + src_col;
                let dst_start = r * dst_stride + dst_col;
                band[dst_start..dst_start + cols]
                    .copy_from_slice(&src.pixels[src_start..src_start + cols]);
            }
        },
        |(), ()| (),
    );
}

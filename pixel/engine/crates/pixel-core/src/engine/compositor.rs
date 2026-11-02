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
    pub origin_x: u32,
    pub size: (u32, u32),
    pub damage_parts: Vec<Rect>,
    pub painted: bool,
    pub opaque: Vec<crate::surfaces::OpaqueArea>,
    pub ui_over_surfaces: Vec<Rect>,
}

impl View {
    fn new(window: (u32, u32)) -> Self {
        Self {
            tree: Tree::new((window.0 as f32, window.1 as f32)),
            canvas: Canvas::new(window.0, window.1),
            clear_color: [0, 0, 0, 0],
            origin_x: 0,
            size: window,
            damage_parts: Vec::new(),
            painted: false,
            opaque: Vec::new(),
            ui_over_surfaces: Vec::new(),
        }
    }

    pub(crate) fn add_damage(&mut self, rect: Rect) {
        self.damage_parts.push(rect);
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
    pub opaque: Vec<crate::surfaces::OpaqueArea>,
    pub ui_over_surfaces: Vec<Rect>,
    changed: Vec<Rect>,
    repainted: Vec<Rect>,
    moves: Vec<crate::canvas::Move>,
    pub work_ms: f32,
    pub kind: u8,
    pub keeps_frames: bool,
    direct: Option<usize>,
    panes: [usize; 2],
    divider_hover: bool,
    last_divider: Option<(u32, bool)>,
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
            opaque: Vec::new(),
            ui_over_surfaces: Vec::new(),
            changed: Vec::new(),
            repainted: Vec::new(),
            moves: Vec::new(),
            work_ms: 0.0,
            kind: 0,
            keeps_frames: false,
            direct: None,
            panes: [0, 1],
            divider_hover: false,
            last_divider: None,
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

    pub(crate) fn compose(&mut self, painted: &[Painted], whole_frame: bool, direct: bool) {
        let resized = (self.frame.width, self.frame.height) != self.window;
        if resized {
            self.frame = Canvas::new(self.window.0, self.window.1);
        }
        let everything = resized || whole_frame || std::mem::take(&mut self.relayout);
        let active = self.active_views();
        let alone = active.len() == 1
            && self.views[active[0]].origin_x == 0
            && self.views[active[0]].size == self.window
            && !everything
            && direct;
        self.direct = alone.then(|| active[0]);
        self.changed.clear();
        self.repainted.clear();
        self.moves.clear();
        let mut divider = None;
        if !alone {
            for &view in &active {
                let size = self.views[view].size;
                let origin = self.views[view].origin_x;
                let straighten = self.views[view].clear_color[3] < 255;
                let (canvas, frame) = (&self.views[view].canvas, &mut self.frame);
                if everything {
                    blit(frame, canvas, origin, Rect::sized(size.0, size.1), straighten);
                    continue;
                }
                let Some(p) = painted.iter().find(|p| p.view == view) else {
                    continue;
                };
                crate::profiler::count("compose.px", || p.parts.iter().map(|r| r.area()).sum());
                for part in p.parts.iter().chain(p.moves.iter().map(|m| &m.rect)) {
                    blit(frame, canvas, origin, *part, straighten);
                }
            }
            divider = self.draw_divider();
        }
        self.collect_opaque();
        let (width, height) = (self.frame.width, self.frame.height);
        if everything {
            self.repainted.push(Rect::sized(width, height));
            return;
        }
        for p in painted {
            let origin = self.views[p.view].origin_x;
            let moved = |part: &Rect| Rect { x: part.x + origin, ..*part }.clamped(width, height);
            if p.whole {
                let size = self.views[p.view].size;
                self.repainted.push(moved(&Rect::sized(size.0, size.1)));
                self.changed.extend(p.surface_parts.iter().map(moved).filter(|r| !r.is_empty()));
            } else {
                for shift in &p.moves {
                    let rect = moved(&shift.rect);
                    if self.keeps_frames && alone {
                        self.moves.push(crate::canvas::Move { rect, dy: shift.dy });
                    } else {
                        self.changed.push(rect);
                    }
                }
                self.changed.extend(p.parts.iter().map(moved).filter(|r| !r.is_empty()));
            }
        }
        self.changed.extend(divider);
    }

    pub(crate) fn frame(&self) -> crate::canvas::Frame<'_> {
        crate::canvas::Frame {
            canvas: self.direct.map_or(&self.frame, |view| &self.views[view].canvas),
            premultiplied: self.direct.is_some(),
            moves: &self.moves,
            changed: &self.changed,
            repainted: &self.repainted,
            opaque: &self.opaque,
            ui_over_surfaces: &self.ui_over_surfaces,
            work_ms: self.work_ms,
            kind: self.kind,
        }
    }

    fn collect_opaque(&mut self) {
        self.opaque.clear();
        self.ui_over_surfaces.clear();
        for view in self.active_views() {
            let origin = self.views[view].origin_x;
            for area in &self.views[view].opaque {
                let moved = Rect { x: area.rect.x + origin, ..area.rect }.clamped(self.frame.width, self.frame.height);
                if !moved.is_empty() {
                    self.opaque.push(crate::surfaces::OpaqueArea { surface: area.surface, rect: moved });
                }
            }
            for rect in &self.views[view].ui_over_surfaces {
                let moved = Rect { x: rect.x + origin, ..*rect }.clamped(self.frame.width, self.frame.height);
                if !moved.is_empty() {
                    self.ui_over_surfaces.push(moved);
                }
            }
        }
    }

    fn draw_divider(&mut self) -> Option<Rect> {
        let Some(dx) = self.divider_x() else {
            self.last_divider = None;
            return None;
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
        let changed = self.last_divider != Some((dx, engaged));
        self.last_divider = Some((dx, engaged));
        changed.then_some(Rect {
            x: dx,
            y: 0,
            w: DIVIDER_W,
            h: self.window.1,
        })
    }
}

pub(crate) struct Painted {
    pub view: usize,
    pub parts: Vec<Rect>,
    pub whole: bool,
    pub surface_parts: Vec<Rect>,
    pub moves: Vec<crate::canvas::Move>,
}

fn blit(dst: &mut Canvas, src: &Canvas, origin_x: u32, region: Rect, straighten: bool) {
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
        cols / 4,
        1 << 20,
        |band, first, count| {
            for r in 0..count {
                let src_start = (y0 + first + r) * src_stride + src_col;
                let dst_start = r * dst_stride + dst_col;
                let row = &mut band[dst_start..dst_start + cols];
                row.copy_from_slice(&src.pixels[src_start..src_start + cols]);
                if straighten {
                    for px in row.chunks_exact_mut(4) {
                        let a = px[3];
                        if a != 0 && a != 255 {
                            for c in &mut px[..3] {
                                *c = ((u32::from(*c) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8;
                            }
                        }
                    }
                }
            }
        },
        |(), ()| (),
    );
}

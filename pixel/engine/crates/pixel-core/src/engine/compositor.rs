use crate::style::Color;
use crate::surfaces::Rect;
use crate::tree::Tree;

const DIVIDER_W: u32 = 6;
const DIVIDER_GRAB: f32 = 5.0;
const MIN_PANE: u32 = 160;


pub struct View {
    pub tree: Tree,
    pub clear_color: Color,
    pub origin_x: u32,
    pub size: (u32, u32),
    pub damage_parts: Vec<Rect>,
    pub scene: crate::scene::Scene,
    pub scene_size: (u32, u32),
}

impl View {
    fn new(window: (u32, u32)) -> Self {
        Self {
            tree: Tree::new((window.0 as f32, window.1 as f32)),
            clear_color: [0, 0, 0, 0],
            origin_x: 0,
            size: window,
            damage_parts: Vec::new(),
            scene: crate::scene::Scene::default(),
            scene_size: (0, 0),
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

    pub(crate) fn divider(&self) -> Option<crate::scene::Divider> {
        self.divider_x().map(|x| crate::scene::Divider { x, width: DIVIDER_W, engaged: self.divider_hover || self.divider_drag })
    }
}

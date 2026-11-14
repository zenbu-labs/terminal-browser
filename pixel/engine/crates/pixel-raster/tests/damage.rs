use pixel_core::fonts::FontRegistry;
use pixel_core::scene::{Damage, Frame, Item, Scene, ViewFrame};
use pixel_core::surfaces::{Rect, merge_damage};
use pixel_core::*;
use pixel_raster::{Raster, RasterOptions};

const CLEAR: Color = [12, 14, 18, 255];

fn fonts() -> FontRegistry {
    let face = |bytes: &[u8]| fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).unwrap();
    FontRegistry::new(
        face(include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf")),
        face(include_bytes!("../../../assets/fonts/InterVariable.ttf")),
    )
}

struct Screen {
    tree: Tree,
    fonts: FontRegistry,
    scene: Scene,
    drawn: Raster,
    size: (u32, u32),
    frames: usize,
    painted: u64,
    label: String,
}

impl Screen {
    fn new(size: (u32, u32), children: Vec<Desc>) -> Self {
        let mut tree = Tree::new((size.0 as f32, size.1 as f32));
        tree.reconcile(Desc { children, ..Desc::default() });
        let mut screen = Screen { tree, fonts: fonts(), scene: Scene::default(), drawn: Raster::new(), size, frames: 0, painted: 0, label: String::new() };
        screen.frame();
        screen
    }

    fn id(&self, key: &str) -> NodeId {
        self.tree.find(key).unwrap_or_else(|| panic!("no node {key}"))
    }

    fn frame(&mut self) -> Option<Vec<Rect>> {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        self.tree.flush_layout(&mut self.fonts, 16.0);
        while self.tree.rows_pending() {
            self.tree.catch_up_rows(&self.fonts, until);
            self.tree.flush_layout(&mut self.fonts, 16.0);
        }
        let (scene, changed) = record_changes(&mut self.tree, &self.fonts, &self.scene, self.frames == 0);
        self.scene = scene;
        self.frames += 1;
        let parts = changed.map(|changed| {
            let rects = changed.iter().map(|r| Rect::covering(r.outset(1.0)).clamped(self.size.0, self.size.1)).collect();
            merge_damage(rects)
        });
        let damage = match &parts {
            None => Damage::Whole,
            Some(parts) if parts.is_empty() => Damage::None,
            Some(parts) => Damage::Parts(parts),
        };
        self.painted += parts.as_ref().map_or(u64::from(self.size.0 * self.size.1), |p| p.iter().map(|r| r.area()).sum());
        let fresh_scene = record_scene(&self.tree, &self.fonts);
        if let Some(drift) = drift(&fresh_scene.root, &self.scene.root) {
            panic!("{}: frame {} kept a stale recording: {drift}", self.label, self.frames);
        }
        let drawn = render(&mut self.drawn, &self.fonts, &self.scene, self.size, damage).to_vec();
        let mut fresh = Raster::new();
        let expected = render(&mut fresh, &self.fonts, &fresh_scene, self.size, Damage::Whole);
        if drawn != expected {
            let wrong = drawn.chunks_exact(4).zip(expected.chunks_exact(4)).enumerate().filter(|(_, (a, b))| a != b);
            let (count, bounds) = wrong.fold((0, Rect::default()), |(n, b), (i, _)| {
                (n + 1, b.union(Rect { x: i as u32 % self.size.0, y: i as u32 / self.size.0, w: 1, h: 1 }))
            });
            explain(&self.scene.root, &drawn, &expected, self.size.0);
            panic!("{}: frame {} drew {count} pixels wrong within {bounds:?}, damage was {parts:?}", self.label, self.frames);
        }
        parts
    }
}

fn explain(root: &Item, drawn: &[u8], expected: &[u8], width: u32) {
    fn walk(item: &Item, x: f32, y: f32) {
        for op in item.ops.iter().chain(&item.inner).chain(&item.after) {
            if op.reach().is_some_and(|r| r.contains(x, y)) {
                eprintln!("node {} clips {} bounds {:?} op {op:?}", item.node, item.clips, item.bounds);
            }
        }
        for child in &item.children {
            walk(child, x, y);
        }
    }
    let wrong: Vec<(u32, u32)> = drawn
        .chunks_exact(4)
        .zip(expected.chunks_exact(4))
        .enumerate()
        .filter(|(_, (a, b))| a != b)
        .map(|(i, _)| (i as u32 % width, i as u32 / width))
        .collect();
    eprintln!("first wrong pixels: {:?}", &wrong[..wrong.len().min(20)]);
    walk(root, wrong[0].0 as f32 + 0.5, wrong[0].1 as f32 + 0.5);
}

fn render(raster: &mut Raster, fonts: &FontRegistry, scene: &Scene, size: (u32, u32), damage: Damage<'_>) -> Vec<u8> {
    let views = [ViewFrame { view: 0, origin_x: 0, size, clear: CLEAR, scene, damage }];
    let frame = Frame { window: size, fonts, views: &views, divider: None, overlay: &[], relayout: false };
    raster.render(&frame, RasterOptions::default()).canvas.pixels.clone()
}

fn drift(fresh: &Item, kept: &Item) -> Option<String> {
    if fresh == kept {
        return None;
    }
    if fresh.children.len() == kept.children.len() {
        for (a, b) in fresh.children.iter().zip(&kept.children) {
            if let Some(found) = drift(a, b) {
                return Some(found);
            }
        }
    }
    Some(format!(
        "node {} differs: fresh {:?} {:?} {:?} children {:?}, kept {:?} {:?} {:?} children {:?}",
        fresh.node,
        fresh.bounds,
        fresh.ops,
        fresh.inner,
        fresh.children.iter().map(|c| c.node).collect::<Vec<_>>(),
        kept.bounds,
        kept.ops,
        kept.inner,
        kept.children.iter().map(|c| c.node).collect::<Vec<_>>()
    ))
}

fn solid(color: Color) -> Option<Paint> {
    Some(Paint::Solid(color))
}

fn px(v: f32) -> Dimension {
    Dimension::Px(v)
}

fn text(key: &str, words: &str) -> Desc {
    Desc { key: Some(key.into()), text: Some(words.into()), style: Style { color: Some([220, 220, 220, 255]), ..Style::default() }, ..Desc::default() }
}

fn boxed(key: &str, style: Style, children: Vec<Desc>) -> Desc {
    Desc { key: Some(key.into()), style, children, ..Desc::default() }
}

#[test]
fn a_spinner_tick_damages_only_the_glyph() {
    let frames = ["⠋", "⠙", "⠹", "⠸"];
    let mut screen = Screen::new(
        (400, 200),
        vec![
            boxed("bar", Style { flex_direction: FlexDirection::Row, background: solid([30, 30, 40, 255]), padding: Edges::all(4.0), ..Style::default() }, vec![
                text("spin", frames[0]),
                text("label", " working on it"),
            ]),
            text("body", "a long body of text that stays the same the whole time"),
        ],
    );
    let spin = screen.id("spin");
    for tick in 1..12 {
        screen.tree.update(spin, Props { text: Some(frames[tick % 4].into()), style: Style { color: Some([220, 220, 220, 255]), ..Style::default() }, key: Some("spin".into()), ..Props::default() });
        let parts = screen.frame().expect("a spinner tick is not a whole repaint");
        let area: u64 = parts.iter().map(|r| r.area()).sum();
        assert!(area < 60 * 40, "tick {tick} painted {area}px: {parts:?}");
    }
}

#[test]
fn typing_at_the_end_of_a_line_damages_the_new_letters_not_the_line() {
    let mut screen = Screen::new(
        (600, 120),
        vec![Desc {
            key: Some("in".into()),
            style: Style { width: px(580.0), height: px(40.0), padding: Edges::all(4.0), background: solid([20, 20, 20, 255]), ..Style::default() },
            input: Some(InputProps { initial: "the quick brown fox jumps over".into(), caret_color: [255, 0, 0, 255], ..InputProps::default() }),
            ..Desc::default()
        }],
    );
    let id = screen.id("in");
    screen.tree.set_focus(Some(id));
    screen.tree.edit_input(id, |input| input.set_cursor(30, false));
    screen.frame();
    for letter in ["!", "?", "a", "b"] {
        screen.tree.edit_input(id, |input| input.insert(letter));
        let parts = screen.frame().expect("typing is not a whole repaint");
        let area: u64 = parts.iter().map(|r| r.area()).sum();
        assert!(area < 80 * 60, "typing {letter} painted {area}px: {parts:?}");
    }
}

#[test]
fn hover_repaints_only_the_nodes_the_pointer_crossed() {
    let row = |key: &str| boxed(key, Style { height: px(20.0), background: solid([30, 30, 30, 255]), hover_background: Some([90, 30, 30, 255]), ..Style::default() }, vec![text(&format!("{key}-label"), key)]);
    let mut screen = Screen::new((300, 200), (0..8).map(|i| row(&format!("row{i}"))).collect());
    for y in [5.0, 25.0, 45.0, 45.5, 150.0, 199.0] {
        screen.tree.set_cursor(Some((10.0, y)));
        if let Some(parts) = screen.frame() {
            let area: u64 = parts.iter().map(|r| r.area()).sum();
            assert!(area <= 300 * 50, "moving to {y} painted {area}px: {parts:?}");
        }
    }
    screen.tree.set_cursor(None);
    screen.frame();
}

#[test]
fn an_image_that_finishes_decoding_repaints_where_it_sits() {
    let dir = std::env::temp_dir().join("pixel-damage-image-test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tile.png");
    image::RgbaImage::from_pixel(4, 2, image::Rgba([0, 200, 0, 255])).save(&path).unwrap();
    let mut screen = Screen::new(
        (300, 120),
        vec![
            text("above", "an image below"),
            Desc {
                key: Some("img".into()),
                style: Style { width: px(40.0), ..Style::default() },
                image: Some(ImageProps { src: path.to_string_lossy().to_string(), equal_to: Vec::new(), glyph: None }),
                children: vec![Desc { style: Style { background: solid([50, 50, 50, 255]), ..Style::default() }, slot: Some(SlotKind::Placeholder), ..Desc::default() }],
                ..Desc::default()
            },
        ],
    );
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let img = screen.id("img");
    loop {
        let drained = pixel_core::image_cache::drain_completed();
        if drained.landed || drained.redraw {
            screen.tree.invalidate_images(drained.landed);
        }
        screen.frame();
        let rect = screen.tree.rect(img).unwrap();
        if pixel_core::image_cache::drawn_status(&path.to_string_lossy(), &[], rect.w as u32, rect.h as u32) == pixel_core::image_cache::ImageStatus::Ready {
            screen.frame();
            break;
        }
        assert!(std::time::Instant::now() < until, "the image never decoded");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[test]
fn scrolling_a_list_and_sticky_headers_match_a_full_repaint() {
    let rows = (0..40)
        .map(|i| {
            let mut row = boxed(&format!("row{i}"), Style { padding: Edges::all(2.0), background: solid([20 + i as u8 * 3, 30, 40, 255]), ..Style::default() }, vec![text(&format!("t{i}"), &format!("row {i} with some words"))]);
            if i % 10 == 0 {
                row.style.position = Position::Sticky;
                row.style.inset = Inset { top: Some(InsetValue::Px(0.0)), ..Inset::default() };
            }
            row
        })
        .collect();
    let mut screen = Screen::new(
        (300, 200),
        vec![boxed("list", Style { height: px(160.0), overflow: Overflow::Scroll, layout: Layout::List, ..Style::default() }, rows), text("footer", "footer")],
    );
    let list = screen.id("list");
    for position in [10.0, 13.0, 80.0, 400.0, 401.0, 2000.0, 0.0, 33.0] {
        screen.label = format!("scroll to {position}");
        screen.tree.scroll_state_mut(list).unwrap().position = position;
        screen.tree.invalidate(list, Invalidation::Place);
        screen.frame();
    }
}

#[test]
fn closing_a_modal_brings_the_caret_back() {
    let mut screen = Screen::new((300, 160), vec![editor(), boxed("overlay", Style { height: px(40.0), background: solid([60, 60, 90, 255]), ..Style::default() }, vec![])]);
    let (editor, overlay) = (screen.id("editor"), screen.id("overlay"));
    screen.tree.set_focus(Some(editor));
    screen.frame();
    let modal = |on: bool| Props { modal: on, key: Some("overlay".into()), style: Style { height: px(40.0), background: solid([60, 60, 90, 255]), ..Style::default() }, ..Props::default() };
    screen.tree.update(overlay, modal(true));
    screen.label = "open modal".into();
    screen.frame();
    screen.tree.remove(overlay);
    screen.label = "close modal".into();
    screen.frame();
}

#[test]
fn an_input_that_takes_focus_as_it_appears_hides_the_old_caret() {
    let mut screen = Screen::new((300, 160), vec![editor()]);
    let editor = screen.id("editor");
    screen.tree.set_focus(Some(editor));
    screen.frame();
    let palette = screen.tree.create(Props {
        key: Some("palette".into()),
        input: Some(InputProps { auto_focus: true, initial: "find".into(), ..InputProps::default() }),
        style: Style { width: px(200.0), height: px(30.0), ..Style::default() },
        ..Props::default()
    });
    screen.tree.append(screen.tree.root(), palette);
    screen.label = "palette opens".into();
    screen.frame();
    screen.tree.remove(palette);
    screen.tree.set_focus(Some(editor));
    screen.label = "palette closes".into();
    screen.frame();
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn color(&mut self) -> Color {
        let alpha = if self.chance(25) { 120 } else { 255 };
        [self.below(256) as u8, self.below(256) as u8, self.below(256) as u8, alpha]
    }

    fn words(&mut self) -> String {
        const WORDS: [&str; 10] = ["pixel", "damage", "a", "frame", "of", "text", "wraps", "here", "émoji 😀", "x"];
        (0..1 + self.below(8)).map(|_| WORDS[self.below(WORDS.len())]).collect::<Vec<_>>().join(" ")
    }
}

struct Model {
    rng: Rng,
    next_key: usize,
}

impl Model {
    fn key(&mut self) -> String {
        self.next_key += 1;
        format!("k{}", self.next_key)
    }

    fn node(&mut self, depth: usize, in_scroller: bool) -> Desc {
        let key = self.key();
        if depth > 2 || self.rng.chance(35) {
            let mut leaf = text(&key, &self.rng.words());
            leaf.style.wrap = self.rng.chance(50);
            leaf.style.color = Some(self.rng.color());
            if self.rng.chance(20) {
                leaf.style.hover_color = Some(self.rng.color());
            }
            return leaf;
        }
        let mut style = self.style();
        if in_scroller && self.rng.chance(20) {
            style.position = Position::Sticky;
            style.inset = Inset { top: Some(InsetValue::Px(0.0)), ..Inset::default() };
            style.background = solid(self.rng.color());
        }
        let scroller = style.overflow == Overflow::Scroll;
        let children = (0..self.rng.below(4)).map(|_| self.node(depth + 1, scroller)).collect();
        boxed(&key, style, children)
    }

    fn style(&mut self) -> Style {
        let rng = &mut self.rng;
        let mut style = Style {
            flex_direction: if rng.chance(50) { FlexDirection::Row } else { FlexDirection::Column },
            padding: Edges::all(rng.below(6) as f32),
            gap: rng.below(4) as f32,
            flex_shrink: 0.0,
            ..Style::default()
        };
        if rng.chance(60) {
            style.background = solid(rng.color());
        }
        if rng.chance(30) {
            let side = BorderSide { width: 1.0 + rng.below(3) as f32, color: rng.color() };
            style.border = Some(if rng.chance(50) {
                Border { top: Some(side), right: Some(side), bottom: Some(side), left: Some(side) }
            } else {
                Border { top: Some(side), bottom: Some(side), ..Border::default() }
            });
        }
        if rng.chance(30) {
            style.corner_radius = [rng.below(8) as f32; 4];
        }
        if rng.chance(30) {
            style.width = px(20.0 + rng.below(200) as f32);
        }
        if rng.chance(30) {
            style.height = px(10.0 + rng.below(120) as f32);
        }
        if rng.chance(20) {
            style.hover_background = Some(rng.color());
        }
        match rng.below(6) {
            0 => style.overflow = Overflow::Hidden,
            1 => {
                style.overflow = Overflow::Scroll;
                style.height = px(30.0 + rng.below(80) as f32);
            }
            _ => {}
        }
        style
    }

    fn mutate(&mut self, desc: &mut Desc) -> String {
        let count = count(desc);
        let index = 1 + self.rng.below(count.saturating_sub(1));
        let Some(target) = nth(desc, index) else { return "nothing".into() };
        let what = self.rng.below(9);
        match what {
            0 => target.style.background = if self.rng.chance(80) { solid(self.rng.color()) } else { None },
            1 => target.style.color = Some(self.rng.color()),
            2 if target.text.is_some() => {
                let mut words = target.text.take().unwrap_or_default();
                if self.rng.chance(50) && !words.is_empty() {
                    words.pop();
                } else {
                    words.push_str(&self.rng.words());
                }
                target.text = Some(words);
            }
            3 => target.style.width = if self.rng.chance(70) { px(10.0 + self.rng.below(240) as f32) } else { Dimension::Auto },
            4 if target.text.is_none() => {
                let at = self.rng.below(target.children.len() + 1);
                let scroller = target.style.overflow == Overflow::Scroll;
                let child = self.node(2, scroller);
                target.children.insert(at, child);
            }
            5 if !target.children.is_empty() => {
                let at = self.rng.below(target.children.len());
                target.children.remove(at);
            }
            6 if target.children.len() > 1 => {
                let from = self.rng.below(target.children.len());
                let child = target.children.remove(from);
                let to = self.rng.below(target.children.len() + 1);
                target.children.insert(to, child);
            }
            7 if target.text.is_none() => target.style = Style { overflow: target.style.overflow, height: target.style.height, ..self.style() },
            _ => target.style.corner_radius = [self.rng.below(10) as f32; 4],
        }
        format!("change {what} on node {index}")
    }
}

fn count(desc: &Desc) -> usize {
    1 + desc.children.iter().map(count).sum::<usize>()
}

fn nth(desc: &mut Desc, n: usize) -> Option<&mut Desc> {
    fn walk<'a>(desc: &'a mut Desc, n: &mut usize) -> Option<&'a mut Desc> {
        if *n == 0 {
            return Some(desc);
        }
        *n -= 1;
        for child in &mut desc.children {
            if let Some(found) = walk(child, n) {
                return Some(found);
            }
        }
        None
    }
    let mut n = n;
    walk(desc, &mut n)
}

fn editor() -> Desc {
    Desc {
        key: Some("editor".into()),
        style: Style { width: px(300.0), padding: Edges::all(4.0), background: solid([25, 25, 25, 255]), wrap: true, flex_shrink: 0.0, ..Style::default() },
        input: Some(InputProps { initial: "edit me".into(), caret_color: [250, 200, 0, 255], selection_color: [40, 80, 160, 255], active_line: Some([35, 35, 45, 255]), ..InputProps::default() }),
        ..Desc::default()
    }
}

#[test]
fn random_mutations_draw_the_same_pixels_as_a_full_repaint() {
    let size = (480, 360);
    for seed in std::env::var("DAMAGE_SEED").ok().and_then(|s| s.parse().ok()).map_or(1..=16u64, |s: u64| s..=s) {
        let mut model = Model { rng: Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15)), next_key: 0 };
        let mut desc = Desc {
            style: Style { flex_direction: FlexDirection::Column, ..Style::default() },
            children: std::iter::once(editor()).chain((0..4).map(|_| model.node(0, false))).collect(),
            ..Desc::default()
        };
        let mut screen = Screen::new(size, desc.children.clone());
        let editor = screen.id("editor");
        let mut total = 0u64;
        for step in 0..60 {
            let action = match model.rng.below(10) {
                0..=3 => {
                    let action = model.mutate(&mut desc);
                    screen.tree.reconcile(desc.clone());
                    action
                }
                4 => {
                    let point = (model.rng.below(size.0 as usize) as f32, model.rng.below(size.1 as usize) as f32);
                    screen.tree.set_cursor(if model.rng.chance(85) { Some(point) } else { None });
                    format!("hover {point:?}")
                }
                5 => {
                    let scrollers: Vec<NodeId> = (1..=model.next_key)
                        .filter_map(|k| screen.tree.find(&format!("k{k}")))
                        .filter(|&id| screen.tree.scroll_area(id).is_some())
                        .collect();
                    if let Some(&id) = scrollers.get(model.rng.below(scrollers.len())) {
                        let max = screen.tree.scroll_max(id);
                        screen.tree.scroll_state_mut(id).unwrap().position = (model.rng.below(100) as f32 / 100.0 * max).round();
                        screen.tree.invalidate(id, Invalidation::Place);
                    }
                    "scroll".into()
                }
                6 => {
                    screen.tree.set_focus(if model.rng.chance(80) { Some(editor) } else { None });
                    let len = screen.tree.input_text(editor).map_or(0, str::len);
                    let at = model.rng.below(len + 1);
                    let extend = model.rng.chance(30);
                    screen.tree.edit_input(editor, |input| input.set_cursor(at.min(input.text().len()), extend));
                    "caret".into()
                }
                7 => {
                    let words = model.rng.words();
                    screen.tree.edit_input(editor, |input| {
                        let end = input.text().len();
                        input.set_cursor(end, false);
                        input.insert(&words);
                    });
                    "type".into()
                }
                8 => {
                    let fonts = fonts();
                    let from = (model.rng.below(size.0 as usize) as f32, model.rng.below(size.1 as usize) as f32);
                    let to = (model.rng.below(size.0 as usize) as f32, model.rng.below(size.1 as usize) as f32);
                    screen.tree.doc_select_down(from, &fonts);
                    screen.tree.doc_select_drag(to, &fonts);
                    screen.tree.doc_select_up();
                    "select".into()
                }
                _ => {
                    screen.tree.doc_collapse();
                    "collapse".into()
                }
            };
            screen.label = format!("seed {seed} step {step} ({action})");
            screen.frame();
            total += 1;
        }
        assert!(total > 0);
    }
}

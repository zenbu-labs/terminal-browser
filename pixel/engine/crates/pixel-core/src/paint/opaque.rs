use crate::canvas::Canvas;
use crate::style::Overflow;
use crate::tree::{NodeId, PxRect, Tree};

pub struct Opaque {
    pub areas: Vec<crate::surfaces::OpaqueArea>,
    pub ui_over_surfaces: Vec<crate::surfaces::Rect>,
}

pub fn opaque_areas(tree: &Tree) -> Opaque {
    let mut areas: Vec<(Option<u32>, PxRect, bool)> = Vec::new();
    let mut ui_over_surfaces: Vec<PxRect> = Vec::new();
    collect_opaque_areas(tree, tree.root(), None, &mut areas, &mut ui_over_surfaces);
    Opaque {
        areas: areas
            .into_iter()
            .filter(|(surface, _, covered)| surface.is_none() || !covered)
            .filter_map(|(surface, area, _)| whole_pixels(area).map(|rect| crate::surfaces::OpaqueArea { surface, rect }))
            .collect(),
        ui_over_surfaces: ui_over_surfaces.into_iter().filter_map(whole_pixels).collect(),
    }
}

fn whole_pixels(area: PxRect) -> Option<crate::surfaces::Rect> {
    let x = area.x.ceil().max(0.0);
    let y = area.y.ceil().max(0.0);
    let right = (area.x + area.w).floor();
    let bottom = (area.y + area.h).floor();
    (right > x && bottom > y).then_some(crate::surfaces::Rect {
        x: x as u32,
        y: y as u32,
        w: (right - x) as u32,
        h: (bottom - y) as u32,
    })
}

fn without(rects: Vec<PxRect>, hole: PxRect) -> Vec<PxRect> {
    let mut out = Vec::new();
    for r in rects {
        let cut = r.intersect(hole);
        if cut.w <= 0.0 || cut.h <= 0.0 {
            out.push(r);
            continue;
        }
        if cut.y > r.y {
            out.push(PxRect { x: r.x, y: r.y, w: r.w, h: cut.y - r.y });
        }
        if cut.y + cut.h < r.y + r.h {
            out.push(PxRect { x: r.x, y: cut.y + cut.h, w: r.w, h: r.y + r.h - (cut.y + cut.h) });
        }
        if cut.x > r.x {
            out.push(PxRect { x: r.x, y: cut.y, w: cut.x - r.x, h: cut.h });
        }
        if cut.x + cut.w < r.x + r.w {
            out.push(PxRect { x: cut.x + cut.w, y: cut.y, w: r.x + r.w - (cut.x + cut.w), h: cut.h });
        }
    }
    out
}

fn collect_opaque_areas(tree: &Tree, id: NodeId, clip: Option<PxRect>, areas: &mut Vec<(Option<u32>, PxRect, bool)>, ui_over_surfaces: &mut Vec<PxRect>) {
    let Some(node) = tree.get(id) else { return };
    if node.hidden {
        return;
    }
    let rect = node.abs;
    let visible_background = match &node.style.background {
        Some(crate::style::Paint::Solid(color)) => color[3] > 0, 
        Some(crate::style::Paint::Gradient(_)) => true,
        None => false,
    };
    let content = visible_background
        || node.surface.is_some()
        || node.text.is_some()
        || !node.spans.is_empty()
        || node.image.is_some()
        || node.shape.is_some()
        || node.input.is_some();
    let mut painted: Vec<PxRect> = Vec::new();
    if content {
        painted.push(rect);
    } else if let Some(border) = node.style.border {
        let side = |s: Option<crate::style::BorderSide>| s.filter(|s| s.width > 0.0 && s.color[3] > 0).map(|s| s.width);
        if let Some(w) = side(border.top) {
            painted.push(PxRect { x: rect.x, y: rect.y, w: rect.w, h: w });
        }
        if let Some(w) = side(border.bottom) {
            painted.push(PxRect { x: rect.x, y: rect.y + rect.h - w, w: rect.w, h: w });
        }
        if let Some(w) = side(border.left) {
            painted.push(PxRect { x: rect.x, y: rect.y, w, h: rect.h });
        }
        if let Some(w) = side(border.right) {
            painted.push(PxRect { x: rect.x + rect.w - w, y: rect.y, w, h: rect.h });
        }
    }
    if let Some(clip) = clip {
        painted = painted.into_iter().map(|p| p.intersect(clip)).filter(|p| p.w > 0.0 && p.h > 0.0).collect();
    }
    for (surface, area, covered) in areas.iter_mut() {
        if surface.is_none() || *covered {
            continue;
        }
        for p in &painted {
            let cut = area.intersect(*p);
            if cut.w <= 0.0 || cut.h <= 0.0 {
                continue;
            }
            if node.surface.is_some() {
                *covered = true;
                break;
            }
            ui_over_surfaces.push(cut);
        }
    }
    if node.surface.is_none() && node.style.opaque {
        let mut area = rect;
        if let Some(clip) = clip {
            area = area.intersect(clip);
        }
        let mut pieces = vec![area];
        for (surface, taken, covered) in areas.iter() {
            if surface.is_some() && !covered {
                pieces = without(pieces, *taken);
            }
        }
        for piece in pieces {
            if piece.w > 0.0 && piece.h > 0.0 {
                areas.push((None, piece, false));
            }
        }
    }
    if let Some(surface) = node.surface
        && node.style.opaque
        && crate::surfaces::with(surface, |s| s.width > 0 && s.height > 0).unwrap_or(false)
    {
        let radius = node.style.corner_radius.iter().fold(1.0f32, |a, &c| a.max(c)).ceil();
        for mut area in opaque_bands(rect, radius) {
            if let Some(clip) = clip {
                area = area.intersect(clip);
            }
            if area.w > 0.0 && area.h > 0.0 {
                areas.push((Some(surface), area, false));
            }
        }
    }
    let child_clip = if node.style.overflow != Overflow::Visible {
        Some(clip.map_or(rect, |c| c.intersect(rect)))
    } else {
        clip
    };
    for &child in &node.children {
        let skipped = tree.get(child).is_some_and(|n| {
            (n.slot.is_some() && !n.slot_visible) || (n.mark.is_some() && !n.mark_visible)
        });
        if !skipped {
            collect_opaque_areas(tree, child, child_clip, areas, ui_over_surfaces);
        }
    }
}

fn opaque_bands(rect: PxRect, radius: f32) -> [PxRect; 3] {
    [
        PxRect { x: rect.x + radius, y: rect.y, w: rect.w - radius * 2.0, h: radius },
        PxRect { x: rect.x, y: rect.y + radius, w: rect.w, h: rect.h - radius * 2.0 },
        PxRect { x: rect.x + radius, y: rect.y + rect.h - radius, w: rect.w - radius * 2.0, h: radius },
    ]
}

pub(super) fn collect_surface_occluders(
    tree: &Tree,
    id: NodeId,
    clip: Option<PxRect>,
    canvas: &mut Canvas,
    out: &mut Vec<(NodeId, u32)>,
) {
    let Some(node) = tree.get(id) else {
        return;
    };
    if node.hidden {
        return;
    }
    let rect = node.abs;
    if let Some(surface) = node.surface
        && node.style.opaque
        && crate::surfaces::with(surface, |s| s.width > 0 && s.height > 0).unwrap_or(false)
    {
        let inset = node.style.corner_radius.iter().fold(1.0f32, |a, &r| a.max(r));
        let mut area = PxRect {
            x: rect.x + inset,
            y: rect.y + inset,
            w: rect.w - inset * 2.0,
            h: rect.h - inset * 2.0,
        };
        if let Some(clip) = clip {
            area = area.intersect(clip);
        }
        if area.w > 0.0 && area.h > 0.0 {
            let token = canvas.add_occluder(area.x, area.y, area.w, area.h);
            out.push((id, token));
        }
    }
    let child_clip = if node.style.overflow != Overflow::Visible {
        Some(clip.map_or(rect, |c| c.intersect(rect)))
    } else {
        clip
    };
    for &child in &node.children {
        let skipped = tree.get(child).is_some_and(|n| {
            (n.slot.is_some() && !n.slot_visible)
                || (n.mark.is_some() && !n.mark_visible)
                || n.shape.is_some()
        });
        if !skipped {
            collect_surface_occluders(tree, child, child_clip, canvas, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desc::Desc;
    use crate::style::{Border, BorderSide, Dimension, Inset, InsetValue, Overflow, Position, Style};

    fn declare_surface(id: u32, w: u32, h: u32) {
        let pixels = vec![0u8; (w * h * 4) as usize];
        crate::surfaces::write(id, w, h, None, &pixels, (w * 4) as usize);
    }

    static FONT_BYTES: &[u8] = include_bytes!("../../../../assets/fonts/JetBrainsMono-Regular.ttf");

    fn page(children: Vec<Desc>) -> Tree {
        let font = fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap();
        let mut tree = Tree::new((400.0, 300.0));
        tree.reconcile(Desc {
            style: Style {
                width: Dimension::Px(400.0),
                height: Dimension::Px(300.0),
                ..Style::default()
            },
            children,
            ..Desc::default()
        });
        tree.flush_layout(std::slice::from_ref(&font), 16.0);
        tree
    }

    fn opaque_page(surface: u32) -> Desc {
        Desc {
            style: Style {
                width: Dimension::Px(400.0),
                height: Dimension::Px(300.0),
                corner_radius: [10.0; 4],
                opaque: true,
                ..Style::default()
            },
            surface: Some(surface),
            ..Desc::default()
        }
    }

    fn bands_of(tree: &Tree, surface: u32) -> Vec<crate::surfaces::Rect> {
        opaque_areas(tree).areas.into_iter().filter(|a| a.surface == Some(surface)).map(|a| a.rect).collect()
    }

    #[test]
    fn a_rounded_opaque_surface_is_three_bands() {
        declare_surface(7, 400, 300);
        let tree = page(vec![opaque_page(7)]);
        let bands = bands_of(&tree, 7);
        assert_eq!(bands.len(), 3, "{bands:?}");
        assert_eq!(bands[1], crate::surfaces::Rect { x: 0, y: 10, w: 400, h: 280 });
        crate::surfaces::remove(7);
    }

    #[test]
    fn a_border_box_clipped_to_a_thin_strip_is_ui_over_only_that_strip() {
        declare_surface(8, 400, 300);
        let loading_bar = Desc {
            style: Style {
                position: Position::Absolute,
                inset: Inset { top: Some(InsetValue::Px(0.0)), left: Some(InsetValue::Px(0.0)), ..Inset::default() },
                width: Dimension::Px(200.0),
                height: Dimension::Px(3.0),
                overflow: Overflow::Hidden,
                ..Style::default()
            },
            children: vec![Desc {
                style: Style {
                    width: Dimension::Px(400.0),
                    height: Dimension::Px(40.0),
                    corner_radius: [8.0; 4],
                    border: Some(Border {
                        top: Some(BorderSide { width: 3.0, color: [0, 120, 255, 255] }),
                        right: Some(BorderSide { width: 3.0, color: [0, 120, 255, 255] }),
                        bottom: Some(BorderSide { width: 3.0, color: [0, 120, 255, 255] }),
                        left: Some(BorderSide { width: 3.0, color: [0, 120, 255, 255] }),
                    }),
                    ..Style::default()
                },
                ..Desc::default()
            }],
            ..Desc::default()
        };
        let tree = page(vec![opaque_page(8), loading_bar]);
        let opaque = opaque_areas(&tree);
        assert_eq!(bands_of(&tree, 8).len(), 3, "the bands all stay opaque: {:?}", opaque.areas);
        let strip = crate::surfaces::Rect { x: 10, y: 0, w: 190, h: 3 };
        assert!(opaque.ui_over_surfaces.contains(&strip), "{:?}", opaque.ui_over_surfaces);
        assert!(opaque.ui_over_surfaces.iter().all(|r| strip.contains(*r)), "only the strip is UI over the page: {:?}", opaque.ui_over_surfaces);
        crate::surfaces::remove(8);
    }

    #[test]
    fn a_surface_drawn_over_another_covers_it_even_without_a_background() {
        declare_surface(9, 400, 300);
        declare_surface(10, 400, 300);
        let mut upper = opaque_page(10);
        upper.style.position = Position::Absolute;
        upper.style.inset = Inset { top: Some(InsetValue::Px(0.0)), left: Some(InsetValue::Px(0.0)), ..Inset::default() };
        let tree = page(vec![opaque_page(9), upper]);
        assert!(bands_of(&tree, 9).is_empty(), "the lower surface is fully covered");
        assert_eq!(bands_of(&tree, 10).len(), 3);
        crate::surfaces::remove(9);
        crate::surfaces::remove(10);
    }

    #[test]
    fn a_plain_opaque_node_over_the_page_is_declared_only_where_it_leaves_the_page() {
        declare_surface(11, 400, 300);
        let card = Desc {
            style: Style {
                position: Position::Absolute,
                inset: Inset { top: Some(InsetValue::Px(0.0)), left: Some(InsetValue::Px(0.0)), ..Inset::default() },
                width: Dimension::Px(50.0),
                height: Dimension::Px(50.0),
                background: Some(crate::style::Paint::Solid([10, 10, 10, 255])),
                opaque: true,
                ..Style::default()
            },
            ..Desc::default()
        };
        let tree = page(vec![opaque_page(11), card]);
        let opaque = opaque_areas(&tree);
        let bands: Vec<_> = opaque.areas.iter().filter(|a| a.surface == Some(11)).collect();
        assert_eq!(bands.len(), 3, "the bands stay: {:?}", opaque.areas);
        let plain: Vec<_> = opaque.areas.iter().filter(|a| a.surface.is_none()).collect();
        assert_eq!(plain.len(), 1, "only the corner square the bands leave out is new: {:?}", opaque.areas);
        assert_eq!(plain[0].rect, crate::surfaces::Rect { x: 0, y: 0, w: 10, h: 10 });
        let over: u64 = opaque.ui_over_surfaces.iter().map(|r| r.area()).sum();
        assert_eq!(over, 50 * 50 - 10 * 10, "the rest of the card is UI over the page: {:?}", opaque.ui_over_surfaces);
        crate::surfaces::remove(11);
    }
}


use pixel_core::surfaces::Rect;

#[derive(Debug, Clone)]
pub(crate) struct Tile {
    pub id: u32,
    pub rect: Rect,
    pub sent: bool,
    pub dirty: bool,
}

pub(super) const FIRST_TILE_ID: u32 = 100_000;
pub(super) const TILE_Z: i32 = 1;
pub(super) const TILE_PX: u32 = 256;

pub(super) fn subtract(rects: &[Rect], hole: Rect) -> Vec<Rect> {
    let mut out = Vec::new();
    for &r in rects {
        let cut = intersect(r, hole);
        if cut.is_empty() {
            out.push(r);
            continue;
        }
        if cut.y > r.y {
            out.push(Rect { x: r.x, y: r.y, w: r.w, h: cut.y - r.y });
        }
        if cut.y + cut.h < r.y + r.h {
            out.push(Rect { x: r.x, y: cut.y + cut.h, w: r.w, h: r.y + r.h - (cut.y + cut.h) });
        }
        if cut.x > r.x {
            out.push(Rect { x: r.x, y: cut.y, w: cut.x - r.x, h: cut.h });
        }
        if cut.x + cut.w < r.x + r.w {
            out.push(Rect { x: cut.x + cut.w, y: cut.y, w: r.x + r.w - (cut.x + cut.w), h: cut.h });
        }
    }
    out
}

pub(super) fn tiles_for(frame: (u32, u32), opaque: &[Rect]) -> Vec<Tile> {
    let mut tiles = Vec::new();
    let mut y = 0;
    while y < frame.1 {
        let mut x = 0;
        while x < frame.0 {
            let mut pieces = vec![Rect { x, y, w: TILE_PX.min(frame.0 - x), h: TILE_PX.min(frame.1 - y) }];
            for &area in opaque {
                pieces = subtract(&pieces, area);
            }
            for rect in pieces {
                tiles.push(Tile { id: FIRST_TILE_ID + tiles.len() as u32, rect, sent: false, dirty: true });
            }
            x += TILE_PX;
        }
        y += TILE_PX;
    }
    tiles
}

pub(super) fn mark_dirty(tiles: &mut [Tile], damage: &[Rect]) {
    for tile in tiles {
        if damage.iter().any(|d| d.intersects(tile.rect)) {
            tile.dirty = true;
        }
    }
}

pub(super) fn mask_outside(pixels: &mut [u8], width: u32, height: u32, keep: &[Rect]) {
    let stride = width as usize * 4;
    for row in 0..height {
        let inside: Vec<(u32, u32)> = keep
            .iter()
            .filter(|z| row >= z.y && row < z.y + z.h)
            .map(|z| (z.x, z.x + z.w))
            .collect();
        let line = &mut pixels[row as usize * stride..(row as usize + 1) * stride];
        if inside.is_empty() {
            line.fill(0);
            continue;
        }
        let mut x = 0u32;
        let mut spans = inside.clone();
        spans.sort_unstable();
        for (start, end) in spans {
            if start > x {
                line[x as usize * 4..start.min(width) as usize * 4].fill(0);
            }
            x = x.max(end.min(width));
        }
        if x < width {
            line[x as usize * 4..].fill(0);
        }
    }
}

pub(super) fn intersect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.w).min(b.x + b.w);
    let bottom = (a.y + a.h).min(b.y + b.h);
    if right <= x || bottom <= y {
        return Rect::default();
    }
    Rect { x, y, w: right - x, h: bottom - y }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: u32, y: u32, w: u32, h: u32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn a_rounded_webview_below_a_toolbar_leaves_tiles_only_where_something_shows() {
        let frame = (2560u32, 1530u32);
        let opaque = [rect(19, 54, 2514, 14), rect(5, 68, 2542, 1442), rect(19, 1510, 2514, 14)];
        let tiles = tiles_for(frame, &opaque);
        for (a, ta) in tiles.iter().enumerate() {
            assert_eq!(ta.id, FIRST_TILE_ID + a as u32);
            assert!(!ta.rect.is_empty());
            assert!(ta.rect.w <= TILE_PX && ta.rect.h <= TILE_PX, "a tile never outgrows a cell: {:?}", ta.rect);
            assert!(opaque.iter().all(|o| !o.intersects(ta.rect)), "tile inside an opaque area: {:?}", ta.rect);
            for tb in &tiles[a + 1..] {
                assert!(!ta.rect.intersects(tb.rect), "tiles overlap: {:?} {:?}", ta.rect, tb.rect);
            }
        }
        let shown: u64 = tiles.iter().map(|t| t.rect.area()).sum();
        let opaque_area: u64 = opaque.iter().map(|o| o.area()).sum();
        assert_eq!(shown + opaque_area, u64::from(frame.0) * u64::from(frame.1), "tiles and opaque areas together cover the frame once");

        let strip = tiles_for((1000, 1000), &[rect(0, 40, 1000, 960)]);
        assert_eq!(strip.len(), 4, "{:?}", strip.iter().map(|t| t.rect).collect::<Vec<_>>());
        assert!(strip.iter().all(|t| t.rect.h == 40 && t.rect.w <= TILE_PX), "tiles over a thin strip are only as tall as the strip");
    }

    #[test]
    fn nothing_opaque_gives_a_full_grid() {
        let tiles = tiles_for((600, 300), &[]);
        assert_eq!(tiles.len(), 3 * 2);
        assert_eq!(tiles.iter().map(|t| t.rect.area()).sum::<u64>(), 600 * 300);
        assert_eq!(tiles[5].rect, rect(512, 256, 88, 44), "the last cell is clipped to the frame");
    }

    #[test]
    fn damage_dirties_only_the_tiles_it_touches() {
        let mut tiles = tiles_for((1000, 1000), &[rect(0, 40, 1000, 960)]);
        for tile in &mut tiles {
            tile.dirty = false;
        }
        mark_dirty(&mut tiles, &[rect(300, 500, 10, 10)]);
        assert!(tiles.iter().all(|t| !t.dirty), "damage inside the opaque area touches no tile");
        mark_dirty(&mut tiles, &[rect(250, 10, 20, 10)]);
        assert_eq!(tiles.iter().filter(|t| t.dirty).count(), 2, "damage across a cell edge dirties both tiles");
        assert!(tiles[0].dirty && tiles[1].dirty);
    }
}

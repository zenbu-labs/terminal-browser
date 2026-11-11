use super::transmit_strategy::Patch;
use pixel_core::surfaces::Rect;

pub(super) use pixel_core::surfaces::IMAGE_OVERHEAD_PX;

fn cheapest_pair(rects: &[Rect], cost: impl Fn(Rect, Rect) -> i64) -> Option<(i64, usize, usize)> {
    let mut best: Option<(i64, usize, usize)> = None;
    for i in 0..rects.len() {
        for j in i + 1..rects.len() {
            let c = cost(rects[i], rects[j]);
            if best.is_none_or(|(b, _, _)| c < b) {
                best = Some((c, i, j));
            }
        }
    }
    best
}

fn extra_pixels(a: Rect, b: Rect) -> i64 {
    a.union(b).area() as i64 - a.area() as i64 - b.area() as i64
}

pub(super) fn merge_rects(rects: &mut Vec<Rect>, max_extra: u64, cap: usize) {
    while let Some((extra, i, j)) = cheapest_pair(rects, extra_pixels) {
        if extra >= max_extra as i64 && rects.len() <= cap {
            return;
        }
        rects[i] = rects[i].union(rects[j]);
        rects.swap_remove(j);
    }
}

pub(super) struct Compaction {
    pub send: Vec<Patch>,
    pub retire: Vec<u32>,
    pub live: Vec<Patch>,
}

pub(super) fn compact(live: &[Patch], keep: usize, max_union: u64, budget: u64, opaque: &[Rect], next_z: &mut i32) -> Compaction {
    let mut live = live.to_vec();
    let mut send: Vec<Patch> = Vec::new();
    let mut retire: Vec<u32> = Vec::new();
    while live.len() > keep {
        let rects: Vec<Rect> = live.iter().map(|p| p.rect).collect();
        let Some((union_area, i, j)) = cheapest_pair(&rects, |a, b| {
            let union = a.union(b);
            if opaque.iter().any(|area| area.contains(union)) { union.area() as i64 } else { i64::MAX }
        }) else {
            break;
        };
        if union_area == i64::MAX {
            break;
        }
        let union = rects[i].union(rects[j]);
        let spent: u64 = send.iter().filter(|p| p.id != live[i].id).map(|p| p.rect.area()).sum();
        if union_area as u64 > max_union || spent + union.area() > budget {
            break;
        }
        let second = live.remove(j);
        let first = live.remove(i);
        retire.push(second.id);
        let covered: Vec<u32> = live.iter().filter(|p| union.contains(p.rect)).map(|p| p.id).collect();
        live.retain(|p| !covered.contains(&p.id));
        retire.extend(covered);
        let merged = Patch { id: first.id, rect: union, z: *next_z };
        *next_z += 1;
        live.push(merged);
        send.retain(|p| p.id != first.id && live.iter().any(|l| l.id == p.id));
        send.push(merged);
    }
    pixel_core::profiler::count("present.compactions", || send.len() as u64);
    Compaction { send, retire, live }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: u32, y: u32, w: u32, h: u32) -> Rect {
        Rect { x, y, w, h }
    }

    fn patch(id: u32, r: Rect) -> Patch {
        Patch { id, rect: r, z: 1 }
    }

    #[test]
    fn overlapping_and_cheaply_joined_rects_merge_and_distant_ones_stay() {
        let mut rects = vec![rect(0, 0, 10, 10), rect(5, 5, 10, 10), rect(16, 0, 10, 10), rect(500, 500, 10, 10)];
        merge_rects(&mut rects, IMAGE_OVERHEAD_PX, usize::MAX);
        rects.sort_by_key(|r| (r.x, r.y));
        assert_eq!(rects, vec![rect(0, 0, 26, 15), rect(500, 500, 10, 10)]);

        let mut runs = vec![rect(64, 0, 128, 64), rect(64, 64, 128, 64), rect(64, 128, 128, 40)];
        merge_rects(&mut runs, IMAGE_OVERHEAD_PX, usize::MAX);
        assert_eq!(runs, vec![rect(64, 0, 128, 168)], "stacked scan runs become one rect");
    }

    #[test]
    fn the_cap_forces_merges_past_the_overhead() {
        let mut rects: Vec<Rect> = (0..8).map(|i| rect(i * 400, i * 400, 10, 10)).collect();
        let mut untouched = rects.clone();
        merge_rects(&mut untouched, IMAGE_OVERHEAD_PX, usize::MAX);
        assert_eq!(untouched.len(), 8, "each merge would add far more than an image costs");
        merge_rects(&mut rects, IMAGE_OVERHEAD_PX, 3);
        assert_eq!(rects.len(), 3);
        for i in 0..8 {
            assert!(rects.iter().any(|r| r.contains(rect(i * 400, i * 400, 10, 10))));
        }
    }

    #[test]
    fn compaction_folds_the_closest_patches_and_retires_the_ones_it_covers() {
        let live = vec![
            patch(2, rect(0, 0, 10, 10)),
            patch(3, rect(12, 0, 10, 10)),
            patch(4, rect(5, 2, 2, 2)),
            patch(5, rect(900, 900, 10, 10)),
        ];
        let mut z = 7;
        let c = compact(&live, 2, 400 * 400, u64::MAX, &[rect(0, 0, 2000, 2000)], &mut z);
        assert_eq!(c.send.len(), 1, "two merges, one final image: {:?}", c.send);
        assert_eq!(c.send[0].rect, rect(0, 0, 22, 10));
        let mut retired = c.retire.clone();
        retired.sort_unstable();
        assert_eq!(retired.len(), 2, "the two folded ids are freed: {retired:?}");
        assert!(!retired.contains(&c.send[0].id) && !retired.contains(&5));
        assert_eq!(c.live.len(), 2);
        assert_eq!(z, 9);
    }

    #[test]
    fn compaction_respects_the_union_cap_and_the_budget() {
        let live = vec![patch(2, rect(0, 0, 300, 300)), patch(3, rect(400, 0, 300, 300)), patch(4, rect(0, 400, 300, 300))];
        let mut z = 1;
        let too_big = compact(&live, 1, 400 * 400, u64::MAX, &[rect(0, 0, 2000, 2000)], &mut z);
        assert!(too_big.send.is_empty(), "every union is over the cap");
        let over_budget = compact(&live, 1, u64::MAX, 100_000, &[rect(0, 0, 2000, 2000)], &mut z);
        assert!(over_budget.send.is_empty(), "the first union alone would spend more than the budget");
        let afford_one = compact(&live, 1, u64::MAX, 250_000, &[rect(0, 0, 2000, 2000)], &mut z);
        assert_eq!(afford_one.send.len(), 1, "one 700x300 union fits, the next would not");
    }

    #[test]
    fn compaction_never_folds_across_opaque_areas() {
        // two bands of a rounded webview; the corner squares between them are not opaque
        let bands = [rect(20, 0, 960, 20), rect(0, 20, 1000, 500)];
        let live = vec![patch(2, rect(30, 5, 10, 10)), patch(3, rect(30, 30, 10, 10)), patch(4, rect(60, 30, 10, 10))];
        let mut z = 1;
        let c = compact(&live, 1, u64::MAX, u64::MAX, &bands, &mut z);
        assert_eq!(c.send.len(), 1, "only the two patches sharing a band fold: {:?}", c.send);
        assert_eq!(c.send[0].rect, rect(30, 30, 40, 10));
        assert_eq!(c.live.len(), 2, "the top-band patch stays on its own");
    }

}

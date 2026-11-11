use super::merge::{self, IMAGE_OVERHEAD_PX};
use super::patched::Patched;
use super::tiles::intersect;
use pixel_core::surfaces::Rect;

pub(crate) const FIRST_PATCH_ID: u32 = 2;
pub(crate) const POOL: u32 = 96;
pub(super) const MAX_PATCHES: usize = 32;
pub(super) const FIRST_PATCH_Z: i32 = 2;
const MAX_Z: i32 = 1 << 29; // 
const PRESSURE_COMPACT_KEEP: usize = POOL as usize / 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Patch {
    pub id: u32,
    pub rect: Rect,
    pub z: i32,
}

pub(super) const TERMINAL_IMAGE_BUDGET_BYTES: u64 = 200 * 1024 * 1024;

fn image_bytes(rects: impl Iterator<Item = Rect>) -> u64 {
    rects.map(|rect| rect.area() * 4).sum()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Flatten {
    Resize,
    OpaqueShapeChanged,
    ImagesExceedTerminalBudget,
    OutOfPatchIds,
    OutOfLayers,
    Idle,
}

impl Flatten {
    pub(super) fn label(self) -> &'static str {
        match self {
            Flatten::Resize => "the window resized",
            Flatten::OpaqueShapeChanged => "the opaque areas changed shape",
            Flatten::ImagesExceedTerminalBudget => "the terminal would hold too many pixels",
            Flatten::OutOfPatchIds => "out of patch ids",
            Flatten::OutOfLayers => "out of layers",
            Flatten::Idle => "gone quiet",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TransmitStrategy {
    Flatten(Flatten),
    Skip,
    Patches { send: Vec<Patch>, retire: Vec<u32>, folded: usize },
}

pub(crate) fn choose_transmit_strategy(state: &Patched, frame: (u32, u32), damage: &[Rect]) -> TransmitStrategy {
    if state.base != Some(frame) { 
        return TransmitStrategy::Flatten(Flatten::Resize);
    }
    let mut rects: Vec<Rect> = damage
        .iter()
        .map(|r| r.clamped(frame.0, frame.1))
        .filter(|r| !r.is_empty())
        .collect();
    if rects.is_empty() {
        return TransmitStrategy::Skip;
    }
    merge::merge_rects(&mut rects, IMAGE_OVERHEAD_PX, MAX_PATCHES);
    let opaque = state.opaque_rects();
    let rects: Vec<Rect> = rects
        .iter()
        .flat_map(|r| opaque.iter().map(move |area| intersect(*r, *area)))
        .filter(|r| !r.is_empty())
        .collect();
    let frame_area = u64::from(frame.0) * u64::from(frame.1);
    if state.next_z.saturating_add(2 * rects.len() as i32) > MAX_Z {
        return TransmitStrategy::Flatten(Flatten::OutOfLayers);
    }

    let mut live = state.live.clone();
    let mut send: Vec<Patch> = Vec::new();
    let mut retire: Vec<u32> = Vec::new();
    let mut folded = 0usize;
    let mut z = state.next_z;
    for rect in rects {
        let mut reuse: Option<u32> = None;
        while let Some(at) = live.iter().position(|p| rect.contains(p.rect)) {
            let covered = live.remove(at);
            send.retain(|p| p.id != covered.id);
            match reuse {
                None => reuse = Some(covered.id),
                Some(_) => retire.push(covered.id),
            }
        }
        let free = |live: &[Patch], send: &[Patch]| {
            (FIRST_PATCH_ID..FIRST_PATCH_ID + POOL)
                .find(|id| !live.iter().any(|p| p.id == *id) && !send.iter().any(|p| p.id == *id))
        };
        let id = match reuse.or_else(|| free(&live, &send)) {
            Some(id) => id,
            None => {
                let mut fold = merge::compact(&live, PRESSURE_COMPACT_KEEP, frame_area / 4, frame_area / 2, &opaque, &mut z);
                let Some(id) = fold.retire.pop() else {
                    return TransmitStrategy::Flatten(Flatten::OutOfPatchIds);
                };
                folded += fold.send.len();
                live = fold.live;
                send.extend(fold.send);
                retire.extend(fold.retire);
                id
            }
        };
        send.push(Patch { id, rect, z });
        z += 1;
    }
    let base_bytes = frame_area * 4;
    let resident = base_bytes + image_bytes(live.iter().chain(send.iter()).map(|p| p.rect));
    if resident > TERMINAL_IMAGE_BUDGET_BYTES {
        return TransmitStrategy::Flatten(Flatten::ImagesExceedTerminalBudget);
    }
    TransmitStrategy::Patches { send, retire, folded }
}

#[derive(Debug, Default)]
pub(crate) struct Stats {
    since: Option<std::time::Instant>,
    frames: u64,
    flattens: u64,
    patches: u64,
    pixels: u64,
    full_pixels: u64,
    repaints: u64,
    surface_draws: u64,
}

const SUMMARY_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

impl Stats {
    pub(super) fn line(&self, live: usize, tiles: usize) -> String {
        format!(
            "patches {live}/{POOL}  tiles {tiles}  full frames {}  sent {:.1}% of whole frames over {} draws ({} ui, {} browser)",
            self.flattens,
            self.pixels as f64 * 100.0 / self.full_pixels.max(1) as f64,
            self.frames,
            self.repaints,
            self.surface_draws,
        )
    }

    // record what? 
    pub(crate) fn record(&mut self, strategy: &TransmitStrategy, frame: (u32, u32), ui: bool, browser: bool) {
        let now = std::time::Instant::now();
        let since = *self.since.get_or_insert(now);
        let full = u64::from(frame.0) * u64::from(frame.1);
        self.frames += 1;
        self.full_pixels += full;
        self.repaints += u64::from(ui);
        self.surface_draws += u64::from(browser);
        match strategy {
            TransmitStrategy::Flatten(_) => {
                self.flattens += 1;
                self.pixels += full;
            }
            TransmitStrategy::Patches { send, .. } => {
                self.patches += send.len() as u64;
                self.pixels += send.iter().map(|p| p.rect.area()).sum::<u64>();
            }
            TransmitStrategy::Skip => {}
        }
        if now.duration_since(since) >= SUMMARY_EVERY {
            pixel_core::logging::debug(
                "present",
                format!(
                    "{} frames: {} flattened, {} patches, sent {:.1}% of the pixels a full frame per draw would have",
                    self.frames,
                    self.flattens,
                    self.patches,
                    self.pixels as f64 * 100.0 / self.full_pixels.max(1) as f64
                ),
            );
            *self = Stats {
                since: Some(now),
                ..Stats::default()
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::patched::Patched;

    const FRAME: (u32, u32) = (640, 400);

    fn whole(frame: (u32, u32)) -> Vec<pixel_core::surfaces::OpaqueArea> {
        vec![pixel_core::surfaces::OpaqueArea { surface: Some(1), rect: Rect::sized(frame.0, frame.1) }]
    }

    fn ready() -> Patched {
        Patched {
            next_z: 1,
            base: Some(FRAME),
            opaque: whole(FRAME),
            last_flatten: Some(std::time::Instant::now()),
            ..Patched::default()
        }
    }

    fn rect(x: u32, y: u32, w: u32, h: u32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn a_patch_stack_past_the_terminal_budget_flattens() {
        let big = Rect { x: 0, y: 0, w: 4000, h: 3000 };
        let mut state = Patched {
            next_z: 1,
            base: Some((4000, 3000)),
            opaque: whole((4000, 3000)),
            last_flatten: Some(std::time::Instant::now()),
            ..Patched::default()
        };
        assert!(matches!(choose_transmit_strategy(&state, (4000, 3000), &[rect(0, 0, 10, 10)]), TransmitStrategy::Patches { .. }));
        state.live = (0..5).map(|i| Patch { id: FIRST_PATCH_ID + i, rect: big, z: 1 + i as i32 }).collect();
        assert_eq!(
            choose_transmit_strategy(&state, (4000, 3000), &[rect(0, 0, 10, 10)]),
            TransmitStrategy::Flatten(Flatten::ImagesExceedTerminalBudget)
        );
    }

    #[test]
    fn a_missing_or_resized_base_starts_over() {
        assert_eq!(choose_transmit_strategy(&Patched::default(), FRAME, &[rect(0, 0, 1, 1)]), TransmitStrategy::Flatten(Flatten::Resize));
        assert_eq!(choose_transmit_strategy(&ready(), (100, 100), &[rect(0, 0, 1, 1)]), TransmitStrategy::Flatten(Flatten::Resize));
    }

    #[test]
    fn damage_is_sent_at_exact_pixel_bounds() {
        let TransmitStrategy::Patches { send, retire, .. } = choose_transmit_strategy(&ready(), FRAME, &[rect(13, 27, 5, 5)]) else {
            panic!("expected patches");
        };
        assert!(retire.is_empty());
        assert_eq!(send, vec![Patch { id: 2, rect: rect(13, 27, 5, 5), z: 1 }]);
    }

    #[test]
    fn damage_next_to_a_live_patch_takes_its_own_id_rather_than_resending_the_old_one() {
        let mut state = ready();
        state.live = vec![Patch { id: 2, rect: rect(100, 100, 20, 10), z: 1 }];
        state.next_z = 2;
        let TransmitStrategy::Patches { send, retire, .. } = choose_transmit_strategy(&state, FRAME, &[rect(122, 100, 20, 10)]) else {
            panic!("expected patches");
        };
        assert!(retire.is_empty());
        assert_eq!(send, vec![Patch { id: 3, rect: rect(122, 100, 20, 10), z: 2 }]);
    }

    #[test]
    fn empty_or_off_frame_damage_skips_and_big_damage_is_still_a_patch() {
        assert_eq!(choose_transmit_strategy(&ready(), FRAME, &[]), TransmitStrategy::Skip);
        assert_eq!(choose_transmit_strategy(&ready(), FRAME, &[rect(700, 0, 5, 5)]), TransmitStrategy::Skip);
        assert!(matches!(choose_transmit_strategy(&ready(), FRAME, &[rect(0, 0, 640, 380)]), TransmitStrategy::Patches { .. }));
    }

    #[test]
    fn many_rects_merge_down_to_the_patch_cap() {
        let damage: Vec<Rect> = (0..8).map(|i| rect(i * 70, i * 40, 10, 20)).collect();
        let TransmitStrategy::Patches { send, .. } = choose_transmit_strategy(&ready(), FRAME, &damage) else {
            panic!("expected patches");
        };
        assert!(send.len() <= MAX_PATCHES);
        for r in &damage {
            assert!(send.iter().any(|p| p.rect.contains(*r)), "{r:?} not covered");
        }
        let ids: std::collections::HashSet<u32> = send.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), send.len(), "ids are distinct within a frame");
        let zs: Vec<i32> = send.iter().map(|p| p.z).collect();
        assert_eq!(zs, (1..=send.len() as i32).collect::<Vec<_>>());
    }

    #[test]
    fn a_patch_covering_live_ones_reuses_one_id_and_retires_the_rest() {
        let mut state = ready();
        state.live = vec![
            Patch { id: 2, rect: rect(10, 20, 10, 20), z: 1 },
            Patch { id: 3, rect: rect(30, 20, 10, 20), z: 2 },
            Patch { id: 4, rect: rect(300, 300, 10, 20), z: 3 },
        ];
        state.next_z = 4;
        let TransmitStrategy::Patches { send, retire, .. } = choose_transmit_strategy(&state, FRAME, &[rect(10, 20, 30, 20)]) else {
            panic!("expected patches");
        };
        assert_eq!(send, vec![Patch { id: 2, rect: rect(10, 20, 30, 20), z: 4 }]);
        assert_eq!(retire, vec![3]);
    }

    #[test]
    fn a_full_pool_folds_patches_together_instead_of_flattening() {
        let mut state = ready();
        state.live = (0..POOL)
            .map(|i| Patch { id: FIRST_PATCH_ID + i, rect: rect((i % 16) * 40, (i / 16) * 60, 10, 20), z: i as i32 + 1 })
            .collect();
        state.next_z = POOL as i32 + 1;
        let TransmitStrategy::Patches { send, retire, .. } = choose_transmit_strategy(&state, FRAME, &[rect(5, 350, 10, 20)]) else {
            panic!("expected patches");
        };
        assert!(!retire.is_empty(), "folding freed ids");
        let new = send.iter().find(|p| p.rect == rect(5, 350, 10, 20)).expect("the new change is sent");
        assert!(!retire.contains(&new.id));
        let ids: std::collections::HashSet<u32> = send.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), send.len(), "ids are distinct within a frame");
        assert!(send.iter().all(|p| p.z > POOL as i32), "merged images and the new patch land above every old one");
        let resent: u64 = send.iter().map(|p| p.rect.area()).sum();
        assert!(resent < u64::from(FRAME.0) * u64::from(FRAME.1) / 2, "far less than a frame went out");
    }

    #[test]
    fn a_full_pool_of_huge_patches_flattens_rather_than_resending_a_frame_in_pieces() {
        let mut state = ready();
        state.live = (0..POOL)
            .map(|i| Patch { id: FIRST_PATCH_ID + i, rect: rect(i % 20, i / 20, 620, 380), z: i as i32 + 1 })
            .collect();
        state.next_z = POOL as i32 + 1;
        assert_eq!(choose_transmit_strategy(&state, FRAME, &[rect(0, 0, 5, 5)]), TransmitStrategy::Flatten(Flatten::OutOfPatchIds));
    }
}

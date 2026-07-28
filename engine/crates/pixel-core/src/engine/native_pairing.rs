use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::hover::{HoverOracle, Verdict};
use crate::native::{NativeEvent, PHASE_BEGAN};

const PAIR_WINDOW: Duration = Duration::from_millis(250);
const HOLD_LIMIT: f32 = 120.0;
const STREAM_WINDOW: Duration = Duration::from_millis(200);

pub(super) struct NativePairing {
    held: VecDeque<(f32, f32)>,
    held_travel: f32,
    undecided_since: Option<Instant>,
    last_precise: Option<Instant>,
    ready: Vec<(f32, f32)>,
    zoom: f32,
}

impl NativePairing {
    pub fn new() -> Self {
        Self {
            held: VecDeque::new(),
            held_travel: 0.0,
            undecided_since: None,
            last_precise: None,
            ready: Vec::new(),
            zoom: 1.0,
        }
    }

    pub fn ingest(
        &mut self,
        events: Vec<NativeEvent>,
        scale: f32,
        now: Instant,
        hover: &mut HoverOracle,
        pane: (f32, f32),
        pad: (f32, f32),
    ) {
        for event in events {
            match event {
                NativeEvent::Cursor { point } => hover.note_cursor(scale_point(point, scale), now),
                NativeEvent::Window { rect } => {
                    hover.note_window(rect.map(|rect| scale_rect(rect, scale)));
                }
                NativeEvent::Zoom {
                    magnification,
                    point,
                } => {
                    if let Some(point) = point {
                        hover.note_cursor(scale_point(point, scale), now);
                    }
                    self.zoom *= 1.0 + magnification;
                }
                NativeEvent::Scroll {
                    delta_x,
                    delta_y,
                    precise,
                    phase,
                    point,
                    ..
                } => {
                    if let Some(point) = point {
                        hover.note_cursor(scale_point(point, scale), now);
                    }
                    if !precise {
                        continue;
                    }
                    self.last_precise = Some(now);
                    if phase & PHASE_BEGAN != 0 {
                        self.forget_held();
                        self.undecided_since = None;
                    }
                    let px = (delta_x * scale, delta_y * scale);
                    match hover.verdict(now, pane, pad) {
                        Verdict::Deliver => {
                            self.ready.extend(self.held.drain(..));
                            self.held_travel = 0.0;
                            self.undecided_since = None;
                            self.ready.push(px);
                        }
                        Verdict::Discard => self.forget_held(),
                        Verdict::Unknown => self.hold(px, now),
                    }
                }
            }
        }
        if let Some(since) = self.undecided_since
            && now.saturating_duration_since(since) > PAIR_WINDOW
        {
            self.undecided_since = None;
            hover.note_absent(now);
        }
    }

    pub fn on_wheel_tick(&mut self, local: (f32, f32), now: Instant, hover: &mut HoverOracle) -> bool {
        hover.note_tick(local, now);
        self.undecided_since = None;
        self.ready.extend(self.held.drain(..));
        self.held_travel = 0.0;
        self.last_precise
            .is_some_and(|at| now.saturating_duration_since(at) < STREAM_WINDOW)
    }

    pub fn take(&mut self) -> (f32, Vec<(f32, f32)>) {
        (
            std::mem::replace(&mut self.zoom, 1.0),
            std::mem::take(&mut self.ready),
        )
    }

    pub fn reset(&mut self) {
        self.forget_held();
        self.undecided_since = None;
        self.last_precise = None;
    }

    fn hold(&mut self, px: (f32, f32), now: Instant) {
        if self.undecided_since.is_none() {
            self.undecided_since = Some(now);
        }
        self.held.push_back(px);
        self.held_travel += px.0.abs() + px.1.abs();
        while self.held_travel > HOLD_LIMIT
            && let Some((dx, dy)) = self.held.pop_front()
        {
            self.held_travel -= dx.abs() + dy.abs();
        }
    }

    fn forget_held(&mut self) {
        self.held.clear();
        self.held_travel = 0.0;
    }
}

fn scale_point(point: (f32, f32), scale: f32) -> (f32, f32) {
    (point.0 * scale, point.1 * scale)
}

fn scale_rect(rect: (f32, f32, f32, f32), scale: f32) -> (f32, f32, f32, f32) {
    (
        rect.0 * scale,
        rect.1 * scale,
        rect.2 * scale,
        rect.3 * scale,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANE: (f32, f32) = (800.0, 600.0);
    const PAD: (f32, f32) = (16.0, 32.0);

    fn scroll(delta_y: f32, phase: u32) -> NativeEvent {
        NativeEvent::Scroll {
            delta_x: 0.0,
            delta_y,
            precise: true,
            phase,
            momentum: 0,
            point: None,
        }
    }

    fn at(delta_y: f32, phase: u32, point: (f32, f32)) -> NativeEvent {
        NativeEvent::Scroll {
            delta_x: 0.0,
            delta_y,
            precise: true,
            phase,
            momentum: 0,
            point: Some(point),
        }
    }

    fn located() -> (NativePairing, HoverOracle, Instant) {
        let mut hover = HoverOracle::new();
        let now = Instant::now();
        for _ in 0..3 {
            hover.note_cursor((500.0, 500.0), now);
            hover.note_local((400.0, 300.0), now);
        }
        assert!(hover.calibrated());
        (NativePairing::new(), hover, now)
    }

    #[test]
    fn located_pane_delivers_the_first_pixel_of_every_flick() {
        let (mut pairing, mut hover, now) = located();
        for flick in 0..4 {
            pairing.ingest(vec![at(3.0, PHASE_BEGAN, (500.0, 500.0))], 1.0, now, &mut hover, PANE, PAD);
            assert_eq!(pairing.take().1, vec![(0.0, 3.0)], "flick {flick} scrolled nothing");
        }
    }

    #[test]
    fn scrolling_away_from_the_pane_delivers_nothing() {
        let (mut pairing, mut hover, now) = located();
        pairing.ingest(
            vec![at(3.0, PHASE_BEGAN, (1400.0, 500.0)), at(9.0, 0, (1400.0, 500.0))],
            1.0,
            now,
            &mut hover,
            PANE,
            PAD,
        );
        assert_eq!(pairing.take().1, Vec::<(f32, f32)>::new());
    }

    #[test]
    fn a_tick_flushes_what_was_held_while_undecided() {
        let mut pairing = NativePairing::new();
        let mut hover = HoverOracle::new();
        let now = Instant::now();
        pairing.ingest(
            vec![scroll(3.0, PHASE_BEGAN), scroll(2.0, 0)],
            1.0,
            now,
            &mut hover,
            PANE,
            PAD,
        );
        assert_eq!(pairing.take().1, Vec::<(f32, f32)>::new(), "nothing proved hover yet");

        assert!(pairing.on_wheel_tick((400.0, 300.0), now, &mut hover));
        assert_eq!(pairing.take().1, vec![(0.0, 3.0), (0.0, 2.0)]);
    }

    #[test]
    fn a_proven_gesture_keeps_flowing_through_later_flicks() {
        let mut pairing = NativePairing::new();
        let mut hover = HoverOracle::new();
        let now = Instant::now();
        pairing.ingest(vec![at(1.0, PHASE_BEGAN, (500.0, 500.0))], 1.0, now, &mut hover, PANE, PAD);
        assert!(pairing.on_wheel_tick((400.0, 300.0), now, &mut hover));
        pairing.take();

        pairing.ingest(vec![at(2.0, PHASE_BEGAN, (500.0, 500.0))], 1.0, now, &mut hover, PANE, PAD);
        assert_eq!(pairing.take().1, vec![(0.0, 2.0)]);
    }

    #[test]
    fn moving_the_pointer_away_voids_the_latch() {
        let mut pairing = NativePairing::new();
        let mut hover = HoverOracle::new();
        let now = Instant::now();
        pairing.ingest(vec![at(1.0, PHASE_BEGAN, (500.0, 500.0))], 1.0, now, &mut hover, PANE, PAD);
        pairing.on_wheel_tick((400.0, 300.0), now, &mut hover);
        pairing.take();

        pairing.ingest(vec![at(2.0, PHASE_BEGAN, (1400.0, 900.0))], 1.0, now, &mut hover, PANE, PAD);
        assert_eq!(pairing.take().1, Vec::<(f32, f32)>::new());
    }

    #[test]
    fn undecided_scroll_is_capped_rather_than_unbounded() {
        let mut pairing = NativePairing::new();
        let mut hover = HoverOracle::new();
        let now = Instant::now();
        let deltas: Vec<_> = (0..200).map(|_| scroll(10.0, 0)).collect();
        pairing.ingest(deltas, 1.0, now, &mut hover, PANE, PAD);
        pairing.on_wheel_tick((400.0, 300.0), now, &mut hover);
        let total: f32 = pairing.take().1.iter().map(|(_, dy)| dy).sum();
        assert!(total <= HOLD_LIMIT, "flushed {total}px in one go");
    }

    #[test]
    fn an_unproven_gesture_stops_holding_after_the_window() {
        let mut pairing = NativePairing::new();
        let mut hover = HoverOracle::new();
        let start = Instant::now();
        pairing.ingest(vec![at(3.0, PHASE_BEGAN, (500.0, 500.0))], 1.0, start, &mut hover, PANE, PAD);
        let late = start + PAIR_WINDOW + Duration::from_millis(1);
        pairing.ingest(Vec::new(), 1.0, late, &mut hover, PANE, PAD);

        pairing.ingest(vec![at(2.0, 0, (500.0, 500.0))], 1.0, late, &mut hover, PANE, PAD);
        assert_eq!(pairing.take().1, Vec::<(f32, f32)>::new(), "absence was latched");
    }

    #[test]
    fn a_silent_helper_leaves_ticks_to_the_discrete_path() {
        let mut pairing = NativePairing::new();
        let mut hover = HoverOracle::new();
        let now = Instant::now();
        assert!(!pairing.on_wheel_tick((400.0, 300.0), now, &mut hover));
    }

    #[test]
    fn imprecise_deltas_never_engage_the_native_stream() {
        let mut pairing = NativePairing::new();
        let mut hover = HoverOracle::new();
        let now = Instant::now();
        pairing.ingest(
            vec![NativeEvent::Scroll {
                delta_x: 0.0,
                delta_y: 5.0,
                precise: false,
                phase: PHASE_BEGAN,
                momentum: 0,
                point: Some((500.0, 500.0)),
            }],
            1.0,
            now,
            &mut hover,
            PANE,
            PAD,
        );
        assert!(!pairing.on_wheel_tick((400.0, 300.0), now, &mut hover));
    }

    #[test]
    fn zoom_accumulates_multiplicatively_and_scale_applies_to_deltas() {
        let (mut pairing, mut hover, now) = located();
        pairing.ingest(
            vec![
                NativeEvent::Zoom {
                    magnification: 0.5,
                    point: None,
                },
                NativeEvent::Zoom {
                    magnification: 0.5,
                    point: None,
                },
                at(2.0, PHASE_BEGAN, (250.0, 250.0)),
            ],
            2.0,
            now,
            &mut hover,
            PANE,
            PAD,
        );
        let (zoom, scrolls) = pairing.take();
        assert_eq!(zoom, 2.25);
        assert_eq!(scrolls, vec![(0.0, 4.0)]);
        assert_eq!(pairing.take().0, 1.0);
    }
}

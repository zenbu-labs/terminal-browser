use std::time::{Duration, Instant};

use crate::logging;

const AGREEMENT: f32 = 4.0;
const SAMPLES_TO_TRUST: u32 = 3;
const CORRELATION_WINDOW: Duration = Duration::from_millis(60);
const SLOW_MOVE: f32 = 6.0;
const COVER_SLACK: f32 = 4.0;
const ABSENCE_TRUST: Duration = Duration::from_millis(1000);
const VERIFY_WINDOW: Duration = Duration::from_millis(2000);

pub(super) type Rect = (f32, f32, f32, f32);
pub(super) type Point = (f32, f32);

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Verdict {
    Deliver,
    Discard,
    Unknown,
}

#[derive(Clone, Copy)]
struct Sample {
    point: Point,
    at: Instant,
}

#[derive(Clone, Copy)]
struct Latch {
    hovered: bool,
    at_point: Point,
    at: Instant,
}

pub(super) struct HoverOracle {
    origin: Option<Point>,
    candidate: Option<(Point, u32)>,
    cursor: Option<Sample>,
    previous: Option<Sample>,
    window: Option<Rect>,
    latch: Option<Latch>,
    verify_until: Option<Instant>,
}

impl HoverOracle {
    pub fn new() -> Self {
        Self {
            origin: None,
            candidate: None,
            cursor: None,
            previous: None,
            window: None,
            latch: None,
            verify_until: None,
        }
    }

    pub fn calibrated(&self) -> bool {
        self.origin.is_some()
    }

    pub fn wants_cursor(&self, now: Instant) -> bool {
        !self.calibrated() || self.verify_until.is_some_and(|until| now < until)
    }

    pub fn note_cursor(&mut self, point: Point, now: Instant) {
        self.previous = self.cursor;
        self.cursor = Some(Sample { point, at: now });
    }

    pub fn note_window(&mut self, rect: Option<Rect>) {
        self.window = rect;
    }

    pub fn note_local(&mut self, local: Point, now: Instant) {
        let Some(cursor) = self.fresh_cursor(now) else {
            self.verify_until = Some(now + VERIFY_WINDOW);
            return;
        };
        self.latch = Some(Latch {
            hovered: true,
            at_point: cursor,
            at: now,
        });
        if !self.settled() {
            return;
        }
        self.offer((cursor.0 - local.0, cursor.1 - local.1));
    }

    pub fn note_tick(&mut self, local: Point, now: Instant) {
        let Some(cursor) = self.fresh_cursor(now) else {
            self.verify_until = Some(now + VERIFY_WINDOW);
            return;
        };
        self.latch = Some(Latch {
            hovered: true,
            at_point: cursor,
            at: now,
        });
        let origin = (cursor.0 - local.0, cursor.1 - local.1);
        if self.origin.is_some_and(|known| apart(known, origin) > AGREEMENT) {
            logging::info("engine", "native scroll pane moved, recalibrating");
            self.origin = None;
            self.candidate = None;
        }
        self.offer(origin);
    }

    pub fn note_absent(&mut self, now: Instant) {
        let Some(cursor) = self.fresh_cursor(now) else {
            return;
        };
        self.latch = Some(Latch {
            hovered: false,
            at_point: cursor,
            at: now,
        });
    }

    pub fn invalidate(&mut self) {
        self.origin = None;
        self.candidate = None;
        self.latch = None;
    }

    pub fn verdict(&self, now: Instant, pane: (f32, f32), pad: (f32, f32)) -> Verdict {
        let Some(cursor) = self.cursor.map(|sample| sample.point) else {
            return Verdict::Unknown;
        };
        if let Some(origin) = self.origin {
            let reach = (origin.0, origin.1, pane.0 + pad.0, pane.1 + pad.1);
            if !contains(reach, cursor) {
                return Verdict::Discard;
            }
            let pane_rect = (origin.0, origin.1, pane.0, pane.1);
            return match self.window {
                Some(window) if !covers(window, pane_rect) => Verdict::Discard,
                _ => Verdict::Deliver,
            };
        }
        let Some(latch) = self.latch else {
            return Verdict::Unknown;
        };
        if apart(latch.at_point, cursor) > 1.0 {
            return Verdict::Unknown;
        }
        match latch.hovered {
            true => Verdict::Deliver,
            false if now.saturating_duration_since(latch.at) < ABSENCE_TRUST => Verdict::Discard,
            false => Verdict::Unknown,
        }
    }

    fn fresh_cursor(&self, now: Instant) -> Option<Point> {
        let sample = self.cursor?;
        let skew = if sample.at > now {
            sample.at.saturating_duration_since(now)
        } else {
            now.saturating_duration_since(sample.at)
        };
        (skew <= CORRELATION_WINDOW).then_some(sample.point)
    }

    fn settled(&self) -> bool {
        match (self.cursor, self.previous) {
            (Some(cursor), Some(previous)) => apart(cursor.point, previous.point) <= SLOW_MOVE,
            _ => true,
        }
    }

    fn offer(&mut self, origin: Point) {
        self.candidate = match self.candidate {
            Some((seen, count)) if apart(seen, origin) <= AGREEMENT => {
                Some((midpoint(seen, origin), count + 1))
            }
            _ => Some((origin, 1)),
        };
        let Some((origin, count)) = self.candidate else {
            return;
        };
        if count < SAMPLES_TO_TRUST {
            return;
        }
        if self.origin.is_none() {
            logging::info(
                "engine",
                format!("native scroll located pane at {:.0},{:.0}", origin.0, origin.1),
            );
        }
        self.origin = Some(origin);
    }
}

fn apart(a: Point, b: Point) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn midpoint(a: Point, b: Point) -> Point {
    ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0)
}

fn contains(rect: Rect, point: Point) -> bool {
    point.0 >= rect.0 && point.0 < rect.0 + rect.2 && point.1 >= rect.1 && point.1 < rect.1 + rect.3
}

fn covers(outer: Rect, inner: Rect) -> bool {
    outer.0 <= inner.0 + COVER_SLACK
        && outer.1 <= inner.1 + COVER_SLACK
        && outer.0 + outer.2 >= inner.0 + inner.2 - COVER_SLACK
        && outer.1 + outer.3 >= inner.1 + inner.3 - COVER_SLACK
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANE: (f32, f32) = (800.0, 600.0);
    const PAD: (f32, f32) = (16.0, 32.0);

    fn calibrated() -> (HoverOracle, Instant) {
        let mut oracle = HoverOracle::new();
        let now = Instant::now();
        for _ in 0..SAMPLES_TO_TRUST {
            oracle.note_cursor((500.0, 500.0), now);
            oracle.note_local((400.0, 300.0), now);
        }
        assert!(oracle.calibrated());
        (oracle, now)
    }

    #[test]
    fn hovering_locates_the_pane_and_answers_geometrically() {
        let (mut oracle, now) = calibrated();
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Deliver);

        oracle.note_cursor((99.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Discard);

        oracle.note_cursor((899.0, 799.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Deliver);

        oracle.note_cursor((1000.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Discard);
    }

    #[test]
    fn one_sample_is_not_enough_to_trust_geometry() {
        let mut oracle = HoverOracle::new();
        let now = Instant::now();
        oracle.note_cursor((500.0, 500.0), now);
        oracle.note_local((400.0, 300.0), now);
        assert!(!oracle.calibrated());
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Deliver, "latched by the local report");

        oracle.note_cursor((900.0, 900.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Unknown, "latch is void once the cursor moves");
    }

    #[test]
    fn disagreeing_samples_restart_the_count() {
        let mut oracle = HoverOracle::new();
        let now = Instant::now();
        for offset in [0.0, 40.0, 0.0] {
            oracle.note_cursor((500.0 + offset, 500.0), now);
            oracle.note_local((400.0, 300.0), now);
        }
        assert!(!oracle.calibrated());
    }

    #[test]
    fn fast_motion_does_not_calibrate() {
        let mut oracle = HoverOracle::new();
        let now = Instant::now();
        for step in 0..6 {
            let x = 500.0 + step as f32 * 60.0;
            oracle.note_cursor((x, 500.0), now);
            oracle.note_local((x - 100.0, 300.0), now);
        }
        assert!(!oracle.calibrated());
    }

    #[test]
    fn stale_cursor_samples_are_not_paired() {
        let mut oracle = HoverOracle::new();
        let start = Instant::now();
        oracle.note_cursor((500.0, 500.0), start);
        let late = start + CORRELATION_WINDOW + Duration::from_millis(1);
        for _ in 0..SAMPLES_TO_TRUST {
            oracle.note_local((400.0, 300.0), late);
        }
        assert!(!oracle.calibrated());
    }

    #[test]
    fn a_tick_that_contradicts_geometry_recalibrates() {
        let (mut oracle, now) = calibrated();
        oracle.note_cursor((800.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Deliver, "stale rect still says yes");

        oracle.note_tick((400.0, 300.0), now);
        assert!(!oracle.calibrated(), "the tick disagreed, so the rect is dropped");
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Deliver, "but the tick proved hover");

        for _ in 0..SAMPLES_TO_TRUST {
            oracle.note_cursor((800.0, 500.0), now);
            oracle.note_local((400.0, 300.0), now);
        }
        oracle.note_cursor((401.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Deliver, "relocated to 400,200");
        oracle.note_cursor((399.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Discard);
    }

    #[test]
    fn a_window_on_top_of_the_pane_blocks_delivery() {
        let (mut oracle, now) = calibrated();
        oracle.note_window(Some((100.0, 200.0, 800.0, 600.0)));
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Deliver, "that window is our terminal");

        oracle.note_window(Some((300.0, 300.0, 200.0, 200.0)));
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Discard, "something smaller is on top");

        oracle.note_window(None);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Deliver, "no answer does not gate");
    }

    #[test]
    fn absence_latches_so_the_next_gesture_answers_at_once() {
        let mut oracle = HoverOracle::new();
        let now = Instant::now();
        oracle.note_cursor((500.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Unknown);

        oracle.note_absent(now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Discard);

        oracle.note_cursor((501.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Discard, "a pixel of jitter is not a move");

        oracle.note_cursor((540.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Unknown, "moved, so ask again");
    }

    #[test]
    fn a_window_that_moved_relocates_from_pointer_reports_alone() {
        let (mut oracle, now) = calibrated();
        for _ in 0..SAMPLES_TO_TRUST + 1 {
            oracle.note_cursor((800.0, 500.0), now);
            oracle.note_local((400.0, 300.0), now);
        }
        oracle.note_cursor((401.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Deliver);
        oracle.note_cursor((399.0, 500.0), now);
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Discard);
    }

    #[test]
    fn the_cursor_stream_is_wanted_while_uncalibrated_or_being_pointed_at() {
        let oracle = HoverOracle::new();
        let now = Instant::now();
        assert!(oracle.wants_cursor(now), "nothing known yet");

        let (mut oracle, now) = calibrated();
        assert!(!oracle.wants_cursor(now), "located, so stop paying for it");

        oracle.note_local((400.0, 300.0), now + CORRELATION_WINDOW * 2);
        assert!(oracle.wants_cursor(now + CORRELATION_WINDOW * 2));
        assert!(!oracle.wants_cursor(now + VERIFY_WINDOW * 2), "interest expires");
    }

    #[test]
    fn resizing_forgets_the_rect() {
        let (mut oracle, now) = calibrated();
        oracle.invalidate();
        assert!(!oracle.calibrated());
        assert_eq!(oracle.verdict(now, PANE, PAD), Verdict::Unknown);
    }
}

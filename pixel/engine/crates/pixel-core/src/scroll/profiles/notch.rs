use super::super::{ScrollProfile, ScrollState};

#[derive(Debug, Clone, Copy)]
pub struct Notch {
    pub rows: f32,
    pub tau: f32,
}

impl ScrollProfile for Notch {
    fn land(&self, state: &mut ScrollState, max: f32) {
        state.position = state.target.min(max.max(state.position));
    }

    fn tick(&self, state: &mut ScrollState, delta: f32, max: f32) {
        state.target = (state.target + delta * (self.rows - 1.0)).clamp(0.0, max);
    }

    fn step(&self, state: &mut ScrollState, dt: f32, _max: f32) {
        state.velocity = 0.0;
        if self.tau <= 0.0 {
            state.position = state.target;
        } else {
            state.chase(self.tau, dt);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scroll::settle;

    const NOTCH: Notch = Notch {
        rows: 1.0,
        tau: 0.03,
    };

    #[test]
    fn a_notch_lands_the_step_in_flight() {
        let mut state = ScrollState::default();
        state.tick(&NOTCH, 20.0, 1000.0);
        state.step(&NOTCH, 1.0 / 60.0, 1000.0);
        assert!(state.position > 0.0 && state.position < 20.0);
        state.tick(&NOTCH, 20.0, 1000.0);
        assert_eq!(state.position, 20.0);
        assert_eq!(state.target, 40.0);
    }

    #[test]
    fn stops_within_one_notch_of_the_wheel() {
        let mut state = ScrollState::default();
        for _ in 0..30 {
            state.tick(&NOTCH, 20.0, 10_000.0);
            state.step(&NOTCH, 1.0 / 120.0, 10_000.0);
            assert!(state.target - state.position <= 20.0);
        }
        settle(&mut state, &NOTCH, 10_000.0);
        assert_eq!(state.position, 600.0);
    }

    #[test]
    fn reversing_turns_around_at_once() {
        let mut state = ScrollState::default();
        state.tick(&NOTCH, 20.0, 1000.0);
        state.tick(&NOTCH, 20.0, 1000.0);
        state.tick(&NOTCH, -20.0, 1000.0);
        assert_eq!(state.position, 40.0);
        assert_eq!(state.target, 20.0);
    }

    #[test]
    fn zero_tau_jumps_like_codex() {
        let instant = Notch {
            rows: 1.0,
            tau: 0.0,
        };
        let mut state = ScrollState::default();
        state.tick(&instant, 20.0, 1000.0);
        assert!(state.step(&instant, 1.0 / 60.0, 1000.0));
        assert!(state.settled());
        assert_eq!(state.position, 20.0);
    }
}

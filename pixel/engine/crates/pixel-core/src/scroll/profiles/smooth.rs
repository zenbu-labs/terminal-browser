use super::super::{ScrollProfile, ScrollState};

const CATCH_IDLE: f32 = 0.06;

#[derive(Debug, Clone, Copy)]
pub struct Smooth {
    pub tau: f32,
    pub brake: f32,
}

impl ScrollProfile for Smooth {
    fn step(&self, state: &mut ScrollState, dt: f32, _max: f32) {
        state.velocity = 0.0;
        let tau = if state.idle() > CATCH_IDLE {
            self.brake
        } else {
            self.tau
        };
        state.chase(tau, dt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scroll::settle;

    #[test]
    fn eases_over_multiple_frames_then_settles_exactly() {
        let smooth = Smooth {
            tau: 0.08,
            brake: 0.025,
        };
        let mut state = ScrollState::default();
        state.tick(&smooth, 100.0, 500.0);
        assert!(!state.settled());
        let mut last = 0.0;
        let mut steps = 0;
        while !state.settled() {
            state.step(&smooth, 1.0 / 60.0, 500.0);
            assert!(state.position > last && state.position <= 100.0);
            last = state.position;
            steps += 1;
            assert!(steps < 1000);
        }
        assert_eq!(state.position, 100.0);
        assert!(steps > 3, "eased over {steps} frames");
    }

    #[test]
    fn brakes_once_the_stream_goes_quiet() {
        let plain = Smooth {
            tau: 0.08,
            brake: 0.08,
        };
        let braked = Smooth {
            tau: 0.08,
            brake: 0.02,
        };
        let mut a = ScrollState::default();
        let mut b = ScrollState::default();
        a.tick(&plain, 300.0, 1000.0);
        b.tick(&braked, 300.0, 1000.0);
        let plain_steps = settle(&mut a, &plain, 1000.0);
        let braked_steps = settle(&mut b, &braked, 1000.0);
        assert!(
            braked_steps < plain_steps,
            "braked settled in {braked_steps} steps vs {plain_steps}"
        );
        assert_eq!(b.position, 300.0, "braking changes speed, not distance");
    }
}

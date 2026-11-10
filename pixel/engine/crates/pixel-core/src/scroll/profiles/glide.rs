use super::super::{ScrollProfile, ScrollState};

#[derive(Debug, Clone, Copy)]
pub struct Glide {
    pub tau: f32,
    pub friction: f32,
    pub gain: f32,
}

impl ScrollProfile for Glide {
    fn tick(&self, state: &mut ScrollState, delta: f32, _max: f32) {
        if delta * state.velocity < 0.0 {
            state.velocity = 0.0;
        }
        state.velocity += delta * self.gain / self.friction;
    }

    fn step(&self, state: &mut ScrollState, dt: f32, max: f32) {
        let coasted = state.target + state.velocity * dt;
        state.target = coasted.clamp(0.0, max.max(state.target));
        if state.target != coasted {
            state.velocity = 0.0;
        } else {
            state.velocity *= (-dt / self.friction).exp();
            if state.velocity.abs() < 1.0 {
                state.velocity = 0.0;
            }
        }
        state.chase(self.tau, dt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scroll::settle;

    const GLIDE: Glide = Glide {
        tau: 0.07,
        friction: 0.20,
        gain: 1.0,
    };

    #[test]
    fn coasts_past_the_direct_delta() {
        let mut state = ScrollState::default();
        state.tick(&GLIDE, 20.0, 1000.0);
        settle(&mut state, &GLIDE, 1000.0);
        // gain 1.0 coasts roughly one extra tick beyond the direct distance
        assert!(
            state.position > 30.0 && state.position < 50.0,
            "coasted to {}",
            state.position
        );
    }

    #[test]
    fn coast_stops_dead_at_the_edge() {
        let mut state = ScrollState::default();
        state.tick(&GLIDE, 20.0, 25.0);
        settle(&mut state, &GLIDE, 25.0);
        assert_eq!(state.position, 25.0);
    }

    #[test]
    fn counter_tick_kills_the_coast_instead_of_fighting_it() {
        let mut state = ScrollState::default();
        state.tick(&GLIDE, 100.0, 1000.0);
        for _ in 0..3 {
            state.step(&GLIDE, 1.0 / 60.0, 1000.0);
        }
        state.tick(&GLIDE, -20.0, 1000.0);
        settle(&mut state, &GLIDE, 1000.0);
        assert!(
            state.position < 100.0,
            "coast survived the catch: {}",
            state.position
        );
    }
}

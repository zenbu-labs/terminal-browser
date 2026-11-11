use super::super::{ScrollProfile, ScrollState};

#[derive(Debug, Clone, Copy)]
pub struct Step {
    pub per_tick: f32,
}

impl ScrollProfile for Step {
    fn tick(&self, state: &mut ScrollState, delta: f32, max: f32) {
        state.target = (state.target + delta * (self.per_tick - 1.0)).clamp(0.0, max);
    }

    fn step(&self, state: &mut ScrollState, _dt: f32, max: f32) {
        state.position = state.target.clamp(0.0, max.max(state.target));
        state.velocity = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tick_jumps_without_easing() {
        let step = Step { per_tick: 3.0 };
        let mut state = ScrollState::default();
        state.tick(&step, 20.0, 1000.0);
        assert!(state.step(&step, 1.0 / 60.0, 1000.0));
        assert_eq!(state.position, 60.0);
        assert!(state.settled());
    }
}

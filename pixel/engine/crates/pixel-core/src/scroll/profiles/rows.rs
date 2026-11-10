use super::super::{ScrollProfile, ScrollState};

#[derive(Debug, Clone, Copy)]
pub struct Rows {
    pub per_tick: f32,
}

impl ScrollProfile for Rows {
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
    fn a_tick_jumps_whole_rows_without_easing() {
        let rows = Rows { per_tick: 3.0 };
        let mut state = ScrollState::default();
        state.tick(&rows, 20.0, 1000.0);
        assert!(state.step(&rows, 1.0 / 60.0, 1000.0));
        assert_eq!(state.position, 60.0);
        assert!(state.settled());
    }
}

pub mod profiles;

pub trait ScrollProfile: std::fmt::Debug + Sync {
    fn tick(&self, _state: &mut ScrollState, _delta: f32, _max: f32) {}
    fn step(&self, state: &mut ScrollState, dt: f32, max: f32);
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ScrollState {
    pub position: f32,
    pub target: f32,
    pub velocity: f32,
    idle: f32,
    wheel: bool,
    segment: Segment,
}

/// One in-flight wheel run: a hermite segment from `from` to `to`, entered at
/// velocity `v0`, `t` seconds into its `dur` second flight.
#[derive(Debug, Clone, Copy, Default)]
struct Segment {
    from: f32,
    to: f32,
    v0: f32,
    dur: f32,
    t: f32,
}

impl ScrollState {
    pub fn tick<P: ScrollProfile + ?Sized>(&mut self, profile: &P, delta: f32, max: f32) {
        self.idle = 0.0;
        self.wheel = false;
        self.target = (self.target + delta).clamp(0.0, max);
        profile.tick(self, delta, max);
    }

    /// A tick known to be a discrete wheel detent; the node keeps stepping with
    /// the wheel profile until another driver takes over.
    pub fn tick_wheel<P: ScrollProfile + ?Sized>(&mut self, profile: &P, delta: f32, max: f32) {
        self.tick(profile, delta, max);
        self.wheel = true;
    }

    pub fn is_wheel(&self) -> bool {
        self.wheel
    }

    pub fn set_target(&mut self, pos: f32) {
        self.target = pos.max(0.0);
        self.velocity = 0.0;
        self.wheel = false;
    }

    pub fn settled(&self) -> bool {
        self.position == self.target && self.velocity == 0.0
    }

    pub fn step<P: ScrollProfile + ?Sized>(&mut self, profile: &P, dt: f32, max: f32) -> bool {
        let before = self.position;
        self.idle += dt;
        profile.step(self, dt, max);
        self.position != before
    }

    pub fn idle(&self) -> f32 {
        self.idle
    }

    pub fn chase(&mut self, tau: f32, dt: f32) {
        let gap = self.target - self.position;
        self.position = if gap.abs() < 0.5 {
            self.target
        } else {
            self.position + gap * (1.0 - (-dt / tau).exp())
        };
    }
}

#[cfg(test)]
pub(crate) fn settle(state: &mut ScrollState, profile: &dyn ScrollProfile, max: f32) -> usize {
    let mut steps = 0;
    while !state.settled() {
        state.step(profile, 1.0 / 60.0, max);
        steps += 1;
        assert!(steps < 1000, "never settled");
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::profiles::Smooth;
    use super::*;

    #[test]
    fn ticks_clamp_but_follow_targets_may_lead_content_growth() {
        let smooth = Smooth {
            tau: 0.08,
            brake: 0.025,
        };
        let mut state = ScrollState::default();
        state.tick(&smooth, 300.0, 200.0);
        settle(&mut state, &smooth, 200.0);
        assert_eq!(state.position, 200.0);

        state.set_target(230.0);
        settle(&mut state, &smooth, 200.0);
        assert_eq!(state.position, 230.0, "follow may outrun a stale max");
    }
}

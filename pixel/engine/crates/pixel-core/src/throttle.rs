use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
#[cfg(target_os = "macos")]
use std::thread;
use std::time::Duration;

pub struct CpuThrottle {
    inner: Arc<Inner>,
}

const MAX_THREADS: usize = 8;
const RUN_QUANTUM: Duration = Duration::from_millis(4);
const IDLE_POLL: Duration = Duration::from_millis(30);

struct Inner {
    rate_x100: AtomicU32,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    threads: [AtomicU32; MAX_THREADS],
    shutdown: AtomicBool,
}

impl CpuThrottle {
    pub fn new() -> Self {
        let inner = Arc::new(Inner {
            rate_x100: AtomicU32::new(100),
            threads: Default::default(),
            shutdown: AtomicBool::new(false),
        });
        #[cfg(target_os = "macos")]
        {
            let controller = inner.clone();
            thread::Builder::new()
                .name("cpu-throttle".into())
                .spawn(move || run_controller(&controller))
                .ok();
        }
        Self { inner }
    }

    pub fn register_current_thread(&self) {
        #[cfg(target_os = "macos")]
        {
            let port = current_thread_port();
            for slot in &self.inner.threads {
                let existing = slot.load(Ordering::Acquire);
                if existing == port {
                    return;
                }
                if existing == 0
                    && slot
                        .compare_exchange(0, port, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                {
                    return;
                }
            }
        }
    }

    pub fn set_rate(&self, rate: f32) {
        let clamped = rate.clamp(1.0, 50.0);
        self.inner
            .rate_x100
            .store((clamped * 100.0) as u32, Ordering::Release);
    }

    pub fn rate(&self) -> f32 {
        self.inner.rate_x100.load(Ordering::Acquire) as f32 / 100.0
    }

    pub fn supported() -> bool {
        cfg!(target_os = "macos")
    }
}

impl Default for CpuThrottle {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CpuThrottle {
    fn drop(&mut self) {
        self.inner.shutdown.store(true, Ordering::Release);
    }
}

pub(crate) fn sleep_until(at: std::time::Instant) {
    use std::time::{Duration, Instant};
    loop {
        let Some(left) = at.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()) else {
            return;
        };
        if left > Duration::from_millis(2) {
            std::thread::sleep(left - Duration::from_millis(2));
        } else if left > Duration::from_micros(500) {
            std::thread::sleep(Duration::from_micros(100));
        } else {
            std::hint::spin_loop();
        }
    }
}

pub(crate) fn prefer_current_thread() {
    #[cfg(target_os = "macos")]
    #[allow(unsafe_code)]
    {
        const QOS_CLASS_USER_INTERACTIVE: u32 = 0x21;
        unsafe extern "C" {
            fn pthread_set_qos_class_self_np(class: u32, relative_priority: i32) -> i32;
        }
        unsafe { pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0) };
        #[repr(C)]
        struct TimeConstraint {
            period: u32,
            computation: u32,
            constraint: u32,
            preemptible: i32,
        }
        const THREAD_TIME_CONSTRAINT_POLICY: i32 = 2;
        unsafe extern "C" {
            fn mach_timebase_info(info: *mut [u32; 2]) -> i32;
            fn mach_thread_self() -> u32;
            fn thread_policy_set(thread: u32, flavor: i32, info: *mut TimeConstraint, count: u32) -> i32;
        }
        let mut timebase = [0u32; 2];
        if unsafe { mach_timebase_info(&mut timebase) } != 0 || timebase[0] == 0 {
            return;
        }
        let ticks = |ns: u64| (ns * u64::from(timebase[1]) / u64::from(timebase[0])) as u32;
        let mut policy = TimeConstraint { period: ticks(8_333_333), computation: ticks(4_000_000), constraint: ticks(8_000_000), preemptible: 1 };
        unsafe { thread_policy_set(mach_thread_self(), THREAD_TIME_CONSTRAINT_POLICY, &mut policy, 4) };
    }
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn current_thread_port() -> u32 {
    unsafe extern "C" {
        fn pthread_self() -> usize;
        fn pthread_mach_thread_np(thread: usize) -> u32;
    }
    unsafe { pthread_mach_thread_np(pthread_self()) }
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn run_controller(inner: &Inner) {
    unsafe extern "C" {
        fn thread_suspend(thread: u32) -> i32;
        fn thread_resume(thread: u32) -> i32;
    }
    let ports = |inner: &Inner| {
        let mut out = [0u32; MAX_THREADS];
        for (i, slot) in inner.threads.iter().enumerate() {
            out[i] = slot.load(Ordering::Acquire);
        }
        out
    };
    loop {
        if inner.shutdown.load(Ordering::Acquire) {
            return;
        }
        let rate = inner.rate_x100.load(Ordering::Acquire) as f32 / 100.0;
        if rate <= 1.01 {
            thread::sleep(IDLE_POLL);
            continue;
        }
        thread::sleep(RUN_QUANTUM);
        let snapshot = ports(inner);
        for &port in snapshot.iter().filter(|&&p| p != 0) {
            unsafe {
                thread_suspend(port);
            }
        }
        let paused = RUN_QUANTUM.mul_f32(rate - 1.0);
        thread::sleep(paused.min(Duration::from_millis(500)));
        for &port in snapshot.iter().filter(|&&p| p != 0) {
            unsafe {
                thread_resume(port);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Instant;

    #[test]
    fn rate_clamps_and_a_thread_registers_once() {
        let throttle = CpuThrottle::new();
        if CpuThrottle::supported() {
            throttle.register_current_thread();
            throttle.register_current_thread();
            let registered = throttle
                .inner
                .threads
                .iter()
                .filter(|slot| slot.load(Ordering::Acquire) != 0)
                .count();
            assert_eq!(registered, 1);
        }

        let idle = CpuThrottle::new();
        assert_eq!(idle.rate(), 1.0);
        idle.set_rate(0.25);
        assert_eq!(idle.rate(), 1.0);
        idle.set_rate(8.0);
        assert_eq!(idle.rate(), 8.0);
        idle.set_rate(99.0);
        assert_eq!(idle.rate(), 50.0);
    }

    #[test]
    #[ignore = "measures CPU share over 350 ms of wall clock, which a busy machine can flip"]
    fn throttled_thread_gets_less_cpu_per_wall_second() {
        if !CpuThrottle::supported() {
            return;
        }
        let throttle = CpuThrottle::new();
        let spin = |ms: u64| {
            let start = Instant::now();
            let mut iterations = 0u64;
            while start.elapsed() < Duration::from_millis(ms) {
                for _ in 0..1000 {
                    iterations = std::hint::black_box(iterations.wrapping_add(1));
                }
            }
            iterations
        };
        let (baseline, throttled) = thread::scope(|scope| {
            let worker = scope.spawn(|| {
                throttle.register_current_thread();
                let baseline = spin(120);
                thread::sleep(Duration::from_millis(80));
                let throttled = spin(120);
                (baseline, throttled)
            });
            thread::sleep(Duration::from_millis(150));
            throttle.set_rate(8.0);
            worker.join().unwrap()
        });
        throttle.set_rate(1.0);
        assert!(
            throttled < baseline / 2,
            "8x throttle should at least halve throughput: {throttled} vs {baseline}"
        );
        assert_eq!(throttle.rate(), 1.0);
    }
}

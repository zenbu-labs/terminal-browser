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

    /// most of that window at 8x.
    #[test]
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

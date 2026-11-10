use std::cell::RefCell;
use std::io;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

thread_local! {
    static ACTIVE: RefCell<Option<Recording>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpanRecord {
    pub name: &'static str,
    pub start_ms: f64,
    pub dur_ms: f64,
    pub depth: u32,
    pub view: u32,
    pub arg: Option<u64>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CounterRecord {
    pub name: &'static str,
    pub at_ms: f64,
    pub value: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarkRecord {
    pub name: &'static str,
    pub label: String,
    pub start_ms: f64,
    pub dur_ms: f64,
    pub view: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProfileData {
    pub epoch_ms: f64,
    pub spans: Vec<SpanRecord>,
    pub counters: Vec<CounterRecord>,
    pub marks: Vec<MarkRecord>,
}

struct Recording {
    started: Instant,
    epoch_ms: f64,
    depth: u32,
    view: u32,
    spans: Vec<SpanRecord>,
    counters: Vec<CounterRecord>,
    marks: Vec<MarkRecord>,
}

pub fn is_recording() -> bool {
    ACTIVE.with(|active| active.borrow().is_some())
}

pub fn start() {
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    ACTIVE.with(|active| {
        *active.borrow_mut() = Some(Recording {
            started: Instant::now(),
            epoch_ms,
            depth: 0,
            view: 0,
            spans: Vec::new(),
            counters: Vec::new(),
            marks: Vec::new(),
        });
    });
}

pub fn stop() -> Option<ProfileData> {
    ACTIVE
        .with(|active| active.borrow_mut().take())
        .map(|r| ProfileData {
            epoch_ms: r.epoch_ms,
            spans: r.spans,
            counters: r.counters,
            marks: r.marks,
        })
}

pub fn set_view(view: u32) {
    ACTIVE.with(|active| {
        if let Some(recording) = active.borrow_mut().as_mut() {
            recording.view = view;
        }
    });
}

pub fn span<T>(name: &'static str, work: impl FnOnce() -> T) -> T {
    span_full(name, None, None, work)
}

pub fn span_arg<T>(name: &'static str, arg: Option<u64>, work: impl FnOnce() -> T) -> T {
    span_full(name, arg, None, work)
}

pub fn span_labeled<T>(
    name: &'static str,
    label: impl FnOnce() -> String,
    work: impl FnOnce() -> T,
) -> T {
    let label = is_recording().then(label);
    span_full(name, None, label, work)
}

fn span_full<T>(
    name: &'static str,
    arg: Option<u64>,
    label: Option<String>,
    work: impl FnOnce() -> T,
) -> T {
    let begin = ACTIVE.with(|active| {
        active.borrow_mut().as_mut().map(|r| {
            r.depth += 1;
            (r.started.elapsed().as_secs_f64() * 1000.0, r.depth - 1)
        })
    });
    let result = work();
    if let Some((start_ms, depth)) = begin {
        ACTIVE.with(|active| {
            if let Some(r) = active.borrow_mut().as_mut() {
                let dur_ms = r.started.elapsed().as_secs_f64() * 1000.0 - start_ms;
                r.depth = r.depth.saturating_sub(1);
                let view = r.view;
                r.spans.push(SpanRecord {
                    name,
                    start_ms,
                    dur_ms,
                    depth,
                    view,
                    arg,
                    label,
                });
            }
        });
    }
    result
}

pub fn ms_of(at: Instant) -> Option<f64> {
    ACTIVE.with(|active| {
        active
            .borrow()
            .as_ref()
            .map(|r| at.saturating_duration_since(r.started).as_secs_f64() * 1000.0)
    })
}

pub fn emit_span(
    name: &'static str,
    start_ms: f64,
    dur_ms: f64,
    depth: u32,
    arg: Option<u64>,
    label: Option<String>,
) {
    ACTIVE.with(|active| {
        if let Some(r) = active.borrow_mut().as_mut() {
            let view = r.view;
            r.spans.push(SpanRecord {
                name,
                start_ms,
                dur_ms,
                depth,
                view,
                arg,
                label,
            });
        }
    });
}

pub fn cpu_us() -> Option<(u64, u64)> {
    if !is_recording() {
        return None;
    }
    #[cfg(unix)]
    {
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        #[allow(unsafe_code, clippy::undocumented_unsafe_blocks)]
        let usage = unsafe {
            libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts);
            let mut usage: libc::rusage = std::mem::zeroed();
            libc::getrusage(libc::RUSAGE_SELF, &mut usage);
            usage
        };
        let thread = ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1000;
        let us = |t: libc::timeval| t.tv_sec as u64 * 1_000_000 + t.tv_usec as u64;
        Some((thread, us(usage.ru_utime) + us(usage.ru_stime)))
    }
    #[cfg(not(unix))]
    {
        Some((0, 0))
    }
}

pub fn count(name: &'static str, value: impl FnOnce() -> u64) {
    ACTIVE.with(|active| {
        if let Some(r) = active.borrow_mut().as_mut() {
            let at_ms = r.started.elapsed().as_secs_f64() * 1000.0;
            let value = value();
            r.counters.push(CounterRecord { name, at_ms, value });
        }
    });
}

pub fn mark(name: &'static str, view: u32, label: impl FnOnce() -> String) {
    ACTIVE.with(|active| {
        if let Some(r) = active.borrow_mut().as_mut() {
            let start_ms = r.started.elapsed().as_secs_f64() * 1000.0;
            r.marks.push(MarkRecord {
                name,
                label: label(),
                start_ms,
                dur_ms: 0.0,
                view,
            });
        }
    });
}

pub fn mark_or_extend(name: &'static str, view: u32, label: impl FnOnce() -> String, gap_ms: f64) {
    ACTIVE.with(|active| {
        if let Some(r) = active.borrow_mut().as_mut() {
            let now_ms = r.started.elapsed().as_secs_f64() * 1000.0;
            if let Some(last) = r.marks.last_mut()
                && last.name == name
                && last.view == view
                && now_ms - (last.start_ms + last.dur_ms) < gap_ms
            {
                last.dur_ms = now_ms - last.start_ms;
                last.label = label();
                return;
            }
            r.marks.push(MarkRecord {
                name,
                label: label(),
                start_ms: now_ms,
                dur_ms: 0.0,
                view,
            });
        }
    });
}

pub fn now_ms() -> Option<f64> {
    ACTIVE.with(|active| {
        active
            .borrow()
            .as_ref()
            .map(|r| r.started.elapsed().as_secs_f64() * 1000.0)
    })
}

pub fn emit(name: &'static str, start_ms: f64, dur_ms: f64, arg: Option<u64>) {
    ACTIVE.with(|active| {
        if let Some(r) = active.borrow_mut().as_mut() {
            let (depth, view) = (r.depth, r.view);
            r.spans.push(SpanRecord {
                name,
                start_ms,
                dur_ms,
                depth,
                view,
                arg,
                label: None,
            });
        }
    });
}

pub fn write_report(data: &ProfileData) -> io::Result<std::path::PathBuf> {
    let dir = std::env::var("TERMINAL_BROWSER_PROFILE_DIR").unwrap_or_else(|_| "profiles".to_string());
    std::fs::create_dir_all(&dir)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs();
    let path = std::path::PathBuf::from(format!("{dir}/profile-{stamp}.json"));
    std::fs::write(&path, report_json(data))?;
    Ok(path)
}

fn report_json(data: &ProfileData) -> String {
    let mut stats: Vec<(&str, u64, f64, f64)> = Vec::new();
    for span in &data.spans {
        match stats.iter_mut().find(|(n, ..)| *n == span.name) {
            Some((_, count, total, max)) => {
                *count += 1;
                *total += span.dur_ms;
                *max = max.max(span.dur_ms);
            }
            None => stats.push((span.name, 1, span.dur_ms, span.dur_ms)),
        }
    }
    let mut out = format!(
        "{{\n  \"epoch_ms\": {:.3},\n  \"summary\": {{",
        data.epoch_ms
    );
    for (i, (name, count, total, max)) in stats.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "\n    \"{name}\": {{\"count\": {count}, \"total_ms\": {total:.3}, \"mean_ms\": {:.3}, \"max_ms\": {max:.3}}}",
            total / *count as f64
        ));
    }
    out.push_str("\n  },\n  \"spans\": [\n");
    for (i, s) in data.spans.iter().enumerate() {
        out.push_str(&format!(
            "    {{\"name\": \"{}\", \"start_ms\": {:.3}, \"dur_ms\": {:.3}, \"depth\": {}, \"view\": {}{}{}}}{}\n",
            s.name,
            s.start_ms,
            s.dur_ms,
            s.depth,
            s.view,
            s.arg.map_or(String::new(), |a| format!(", \"arg\": {a}")),
            s.label.as_deref().map_or(String::new(), |l| format!(
                ", \"label\": \"{}\"",
                l.replace('\\', "\\\\").replace('"', "\\\"")
            )),
            if i + 1 == data.spans.len() { "" } else { "," }
        ));
    }
    out.push_str("  ]\n}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_nest_while_recording_and_still_run_outside_one() {
        start();
        span("outer", || {
            span("inner", || {
                std::thread::sleep(std::time::Duration::from_millis(1))
            });
        });
        count("items", || 3);
        let data = stop().unwrap();
        assert!(!is_recording());
        assert_eq!(data.spans.len(), 2);
        let inner = &data.spans[0];
        let outer = &data.spans[1];
        assert_eq!((inner.name, inner.depth), ("inner", 1));
        assert_eq!((outer.name, outer.depth), ("outer", 0));
        assert!(outer.dur_ms >= inner.dur_ms);
        assert!(outer.start_ms <= inner.start_ms);
        assert_eq!(data.counters[0].name, "items");
        assert!(data.epoch_ms > 0.0);
        assert_eq!(span("idle", || 7), 7);
    }

    #[test]
    fn report_json_summarizes_by_name() {
        start();
        span("work", || {});
        span("work", || {});
        let data = stop().unwrap();
        let json = report_json(&data);
        assert!(json.contains("\"work\": {\"count\": 2"));
        assert!(json.contains("\"spans\": ["));
    }
}

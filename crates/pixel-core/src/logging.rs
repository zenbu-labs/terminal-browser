use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const CAPACITY: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogEntry {
    pub seq: u64,
    pub epoch_ms: f64,
    pub level: LogLevel,
    pub target: &'static str,
    pub message: String,
}

struct LogStore {
    next_seq: u64,
    entries: VecDeque<LogEntry>,
}

static LOGS: Mutex<LogStore> = Mutex::new(LogStore {
    next_seq: 0,
    entries: VecDeque::new(),
});

pub fn log(level: LogLevel, target: &'static str, message: impl Into<String>) {
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    let Ok(mut store) = LOGS.lock() else {
        return;
    };
    let seq = store.next_seq;
    store.next_seq += 1;
    if store.entries.len() >= CAPACITY {
        store.entries.pop_front();
    }
    store.entries.push_back(LogEntry {
        seq,
        epoch_ms,
        level,
        target,
        message: message.into(),
    });
}

pub fn debug(target: &'static str, message: impl Into<String>) {
    log(LogLevel::Debug, target, message);
}

pub fn info(target: &'static str, message: impl Into<String>) {
    log(LogLevel::Info, target, message);
}

pub fn warn(target: &'static str, message: impl Into<String>) {
    log(LogLevel::Warn, target, message);
}

pub fn error(target: &'static str, message: impl Into<String>) {
    log(LogLevel::Error, target, message);
}

/// Entries with seq >= `after`, so callers pass the last seen seq + 1
/// (or 0 for the full backlog that is still in the ring).
pub fn entries_after(after: u64) -> Vec<LogEntry> {
    let Ok(store) = LOGS.lock() else {
        return Vec::new();
    };
    store
        .entries
        .iter()
        .filter(|e| e.seq >= after)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_entries_are_sequenced_and_drainable() {
        info("test-a", "first");
        warn("test-a", "second");
        let all = entries_after(0);
        let ours: Vec<_> = all.iter().filter(|e| e.target == "test-a").collect();
        assert!(ours.len() >= 2);
        assert!(ours[0].seq < ours[1].seq);
        let after = entries_after(ours[1].seq + 1);
        assert!(after.iter().all(|e| e.target != "test-a"));
    }
}

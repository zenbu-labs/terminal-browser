use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const CAPACITY: usize = 4000;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

const TO_MEMORY: u8 = 1;
const TO_FILE: u8 = 2;

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

struct LogFile {
    path: PathBuf,
    file: std::fs::File,
    bytes: u64,
}

static SINKS: AtomicU8 = AtomicU8::new(0);

static LOGS: Mutex<LogStore> = Mutex::new(LogStore {
    next_seq: 0,
    entries: VecDeque::new(),
});

static FILE: Mutex<Option<LogFile>> = Mutex::new(None);

pub fn log(level: LogLevel, target: &'static str, message: impl Into<String>) {
    let sinks = SINKS.load(Ordering::Relaxed);
    if sinks == 0 {
        return;
    }
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    let message = message.into();
    if sinks & TO_FILE != 0 && level != LogLevel::Debug {
        append_to_file(&entry_json(epoch_ms, level, target, &message));
    }
    if sinks & TO_MEMORY != 0 {
        append_to_memory(epoch_ms, level, target, message);
    }
}

pub fn keep_in_memory(on: bool) {
    set_sink(TO_MEMORY, on);
    if !on && let Ok(mut store) = LOGS.lock() {
        store.entries.clear();
    }
}

pub fn write_to_file(path: Option<PathBuf>) {
    let opened = path.and_then(|path| LogFile::open(path).ok());
    set_sink(TO_FILE, opened.is_some());
    if let Ok(mut file) = FILE.lock() {
        *file = opened;
    }
}

fn set_sink(sink: u8, on: bool) {
    if on {
        SINKS.fetch_or(sink, Ordering::Relaxed);
    } else {
        SINKS.fetch_and(!sink, Ordering::Relaxed);
    }
}

fn append_to_memory(epoch_ms: f64, level: LogLevel, target: &'static str, message: String) {
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
        message,
    });
}

impl LogFile {
    fn open(path: PathBuf) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        let bytes = file.metadata().map_or(0, |m| m.len());
        Ok(Self { path, file, bytes })
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        let mut aside = self.path.clone().into_os_string();
        aside.push(".1");
        std::fs::rename(&self.path, aside)?;
        *self = Self::open(self.path.clone())?;
        Ok(())
    }
}

fn append_to_file(line: &str) {
    let Ok(mut slot) = FILE.lock() else {
        return;
    };
    let Some(file) = slot.as_mut() else {
        return;
    };
    if file.bytes + line.len() as u64 > MAX_FILE_BYTES && file.rotate().is_err() {
        return;
    }
    if file.file.write_all(line.as_bytes()).is_ok() {
        file.bytes += line.len() as u64;
    }
}

fn entry_json(epoch_ms: f64, level: LogLevel, target: &str, message: &str) -> String {
    let mut line = serde_json::json!({
        "t": epoch_ms,
        "level": level.as_str(),
        "target": target,
        "message": message,
    })
    .to_string();
    line.push('\n');
    line
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

pub fn entries_after(after: u64) -> Vec<LogEntry> {
    let Ok(store) = LOGS.lock() else {
        return Vec::new();
    };
    let fresh = store.entries.iter().rev().take_while(|e| e.seq >= after).count();
    store.entries.range(store.entries.len() - fresh..).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test because the sinks are process-wide: run in parallel, the file half would
    // push the memory half's entries out of the ring.
    #[test]
    fn sinks_are_off_by_default_bounded_in_memory_and_rotate_on_disk() {
        info("test-off", "dropped");
        assert!(entries_after(0).iter().all(|e| e.target != "test-off"));
        keep_in_memory(true);
        info("test-a", "first");
        warn("test-a", "second");
        let all = entries_after(0);
        let ours: Vec<_> = all.iter().filter(|e| e.target == "test-a").collect();
        assert!(ours.len() >= 2);
        assert!(ours[0].seq < ours[1].seq);
        let after = entries_after(ours[1].seq + 1);
        assert!(after.iter().all(|e| e.target != "test-a"));
        keep_in_memory(false);
        assert!(entries_after(0).is_empty());

        let dir = std::env::temp_dir().join(format!("pixel-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("engine.jsonl");
        write_to_file(Some(path.clone()));
        let line = "x".repeat(1024);
        for _ in 0..(MAX_FILE_BYTES / 1024 + 8) {
            info("test-file", line.clone());
        }
        write_to_file(None);
        let mut aside = path.clone().into_os_string();
        aside.push(".1");
        let current = std::fs::metadata(&path).unwrap().len();
        let previous = std::fs::metadata(&aside).unwrap().len();
        assert!(current <= MAX_FILE_BYTES && previous <= MAX_FILE_BYTES);
        assert!(previous > current);
        info("test-file", "after closing");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), current);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

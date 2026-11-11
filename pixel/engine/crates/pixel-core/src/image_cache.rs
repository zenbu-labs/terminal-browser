use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageStatus {
    Pending,
    Ready,
    Failed,
}

enum State {
    Pending { queued: Instant, seq: u64 },
    Ready(Arc<tiny_skia::Pixmap>),
    Failed,
}

type ScaledKey = (u32, u32, [u32; 4]);

struct Entry {
    dims: Option<(u32, u32)>,
    state: State,
    scaled: HashMap<ScaledKey, Arc<tiny_skia::Pixmap>>,
    last_use: u64,
}

type WakerFn = Box<dyn Fn() + Send>;

enum Job {
    Decode {
        src: String,
        queued: Instant,
        seq: u64,
    },
    Clipboard {
        queued: Instant,
        seq: u64,
        clipboard: Option<Arc<dyn crate::backend::SystemClipboard>>,
    },
    Bytes {
        data: Vec<u8>,
        ext: &'static str,
        source: crate::clipboard_image::PasteSource,
        queued: Instant,
        seq: u64,
    },
}

struct DecodeResult {
    src: String,
    pixmap: Option<tiny_skia::Pixmap>,
    queued: Instant,
    started: Instant,
    finished: Instant,
    attempts: u32,
    seq: u64,
}

enum Done {
    Pixels(DecodeResult),
    Clipboard {
        seq: u64,
        queued: Instant,
        pasted: Option<crate::clipboard_image::PastedImage>,
        has_pixels: bool,
    },
    Encoded {
        src: String,
        seq: u64,
        started: Instant,
        finished: Instant,
    },
}

struct Cache {
    entries: HashMap<String, Entry>,
    tick: u64,
    bytes: usize,
    next_seq: u64,
    jobs: Option<Sender<Job>>,
    results: Option<Receiver<Done>>,
    waker: Arc<Mutex<Option<WakerFn>>>,
}

const BUDGET_BYTES: usize = 256 * 1024 * 1024;

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(Cache {
        entries: HashMap::new(),
        tick: 0,
        bytes: 0,
        next_seq: 0,
        jobs: None,
        results: None,
        waker: Arc::new(Mutex::new(None)),
    });
}

fn basename(src: &str) -> &str {
    src.rsplit('/').next().unwrap_or(src)
}

fn premultiply(img: &image::RgbaImage) -> Option<tiny_skia::Pixmap> {
    let (w, h) = img.dimensions();
    let mut pixmap = tiny_skia::Pixmap::new(w, h)?;
    for (dst, src) in pixmap.pixels_mut().iter_mut().zip(img.pixels()) {
        let [r, g, b, a] = src.0;
        *dst = tiny_skia::ColorU8::from_rgba(r, g, b, a).premultiply();
    }
    Some(pixmap)
}

fn decode(src: &str) -> Option<tiny_skia::Pixmap> {
    let img = image::ImageReader::open(src)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?
        .into_rgba8();
    premultiply(&img)
}

fn sniff_dims(src: &str) -> Option<(u32, u32)> {
    image::ImageReader::open(src)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

const RETRY_DELAYS: [Duration; 3] = if cfg!(test) {
    [
        Duration::from_millis(1),
        Duration::from_millis(3),
        Duration::from_millis(9),
    ]
} else {
    [
        Duration::from_millis(100),
        Duration::from_millis(300),
        Duration::from_millis(900),
    ]
};

fn decode_with_retries(src: &str) -> (Option<tiny_skia::Pixmap>, u32) {
    let mut attempts = 0;
    for delay in RETRY_DELAYS {
        attempts += 1;
        if let Some(pixmap) = decode(src) {
            return (Some(pixmap), attempts);
        }
        std::thread::sleep(delay);
    }
    (decode(src), attempts + 1)
}

fn decode_worker(jobs: Receiver<Job>, results: Sender<Done>, waker: Arc<Mutex<Option<WakerFn>>>) {
    let wake = |waker: &Arc<Mutex<Option<WakerFn>>>| {
        if let Some(wake) = waker.lock().unwrap().as_ref() {
            wake();
        }
    };
    let send = |done: Done| results.send(done).is_ok();
    for job in jobs {
        match job {
            Job::Decode { src, queued, seq } => {
                let started = Instant::now();
                let (pixmap, attempts) = decode_with_retries(&src);
                let sent = send(Done::Pixels(DecodeResult {
                    src,
                    pixmap,
                    queued,
                    started,
                    finished: Instant::now(),
                    attempts,
                    seq,
                }));
                if !sent {
                    return;
                }
                wake(&waker);
            }
            Job::Clipboard { queued, seq, clipboard } => {
                use crate::clipboard_image::WorkerPaste;
                let started = Instant::now();
                let read = clipboard.and_then(|clipboard| crate::clipboard_image::read_for_worker(clipboard.as_ref()));
                let pasted = match &read {
                    Some(WorkerPaste::File(pasted)) => Some(pasted.clone()),
                    Some(WorkerPaste::Bitmap { pasted, .. }) => Some(pasted.clone()),
                    None => None,
                };
                let clipboard = Done::Clipboard {
                    seq,
                    queued,
                    pasted,
                    has_pixels: matches!(&read, Some(WorkerPaste::Bitmap { .. })),
                };
                if !send(clipboard) {
                    return;
                }
                if let Some(WorkerPaste::Bitmap { pasted, rgba }) = read {
                    let pixmap = premultiply(&rgba);
                    let sent = send(Done::Pixels(DecodeResult {
                        src: pasted.path.clone(),
                        pixmap,
                        queued,
                        started,
                        finished: Instant::now(),
                        attempts: 1,
                        seq,
                    }));
                    if !sent {
                        return;
                    }
                    wake(&waker);
                    let enc_started = Instant::now();
                    let _ = rgba.save(&pasted.path);
                    let sent = send(Done::Encoded {
                        src: pasted.path,
                        seq,
                        started: enc_started,
                        finished: Instant::now(),
                    });
                    if !sent {
                        return;
                    }
                }
                wake(&waker);
            }
            Job::Bytes {
                data,
                ext,
                source,
                queued,
                seq,
            } => {
                let started = Instant::now();
                let rgba = image::load_from_memory(&data).ok().map(|i| i.into_rgba8());
                let enc_started = Instant::now();
                let pasted = rgba.as_ref().map(|rgba| {
                    let (width, height) = rgba.dimensions();
                    // todo: review me harder
                    let keep_original = matches!(ext, "png" | "jpg");
                    let path =
                        crate::clipboard_image::temp_path(if keep_original { ext } else { "png" });
                    if keep_original {
                        let _ = std::fs::write(&path, &data);
                    } else {
                        let _ = rgba.save(&path);
                    }
                    crate::clipboard_image::PastedImage {
                        path: path.to_string_lossy().into_owned(),
                        width,
                        height,
                        source,
                    }
                });
                let enc_finished = Instant::now();
                let clipboard = Done::Clipboard {
                    seq,
                    queued,
                    pasted: pasted.clone(),
                    has_pixels: pasted.is_some(),
                };
                if !send(clipboard) {
                    return;
                }
                if let (Some(rgba), Some(pasted)) = (rgba, pasted) {
                    let pixmap = premultiply(&rgba);
                    let sent = send(Done::Pixels(DecodeResult {
                        src: pasted.path.clone(),
                        pixmap,
                        queued,
                        started,
                        finished: Instant::now(),
                        attempts: 1,
                        seq,
                    }));
                    if !sent {
                        return;
                    }
                    wake(&waker);
                    let sent = send(Done::Encoded {
                        src: pasted.path,
                        seq,
                        started: enc_started,
                        finished: enc_finished,
                    });
                    if !sent {
                        return;
                    }
                }
                wake(&waker);
            }
        }
    }
}

fn jobs_sender(cache: &mut Cache) -> &Sender<Job> {
    if cache.jobs.is_none() {
        let (jobs_tx, jobs_rx) = channel();
        let (results_tx, results_rx) = channel();
        let waker = cache.waker.clone();
        std::thread::Builder::new()
            .name("pixel-image-decode".into())
            .spawn(move || decode_worker(jobs_rx, results_tx, waker))
            .expect("spawn image decode worker");
        cache.jobs = Some(jobs_tx);
        cache.results = Some(results_rx);
    }
    cache.jobs.as_ref().expect("jobs sender just created")
}

fn ensure(cache: &mut Cache, src: &str, equal_to: &[String]) {
    cache.tick += 1;
    let tick = cache.tick;
    if let Some(entry) = cache.entries.get_mut(src) {
        entry.last_use = tick;
        return;
    }
    for alias in equal_to {
        let Some(entry) = cache.entries.get(alias.as_str()) else {
            continue;
        };
        let State::Ready(pixmap) = &entry.state else {
            continue;
        };
        let seeded = Entry {
            dims: entry.dims,
            state: State::Ready(Arc::clone(pixmap)),
            scaled: entry.scaled.clone(),
            last_use: tick,
        };
        cache.bytes += entry_bytes(&seeded);
        cache.entries.insert(src.to_string(), seeded);
        evict_over_budget(cache, src);
        return;
    }
    let dims = crate::profiler::span_labeled(
        "image.sniff",
        || basename(src).to_string(),
        || sniff_dims(src),
    );
    let queued = Instant::now();
    cache.next_seq += 1;
    let seq = cache.next_seq;
    let _ = jobs_sender(cache).send(Job::Decode {
        src: src.to_string(),
        queued,
        seq,
    });
    cache.entries.insert(
        src.to_string(),
        Entry {
            dims,
            state: State::Pending { queued, seq },
            scaled: HashMap::new(),
            last_use: tick,
        },
    );
}

pub(crate) fn queue_clipboard_read(clipboard: Option<Arc<dyn crate::backend::SystemClipboard>>) -> u64 {
    CACHE.with_borrow_mut(|cache| {
        cache.next_seq += 1;
        let seq = cache.next_seq;
        let _ = jobs_sender(cache).send(Job::Clipboard {
            queued: Instant::now(),
            seq,
            clipboard,
        });
        seq
    })
}

pub(crate) fn queue_pasted_bytes(
    data: Vec<u8>,
    ext: &'static str,
    source: crate::clipboard_image::PasteSource,
) -> u64 {
    CACHE.with_borrow_mut(|cache| {
        cache.next_seq += 1;
        let seq = cache.next_seq;
        let _ = jobs_sender(cache).send(Job::Bytes {
            data,
            ext,
            source,
            queued: Instant::now(),
            seq,
        });
        seq
    })
}

fn entry_bytes(entry: &Entry) -> usize {
    let full = match &entry.state {
        State::Ready(pixmap) => pixmap.data().len(),
        _ => 0,
    };
    full + entry.scaled.values().map(|p| p.data().len()).sum::<usize>()
}

fn evict_over_budget(cache: &mut Cache, keep: &str) {
    while cache.bytes > BUDGET_BYTES {
        let Some(key) = cache
            .entries
            .iter()
            .filter(|(k, e)| k.as_str() != keep && matches!(e.state, State::Ready(_)))
            .min_by_key(|(_, e)| e.last_use)
            .map(|(k, _)| k.clone())
        else {
            return;
        };
        if let Some(entry) = cache.entries.remove(&key) {
            cache.bytes -= entry_bytes(&entry);
        }
    }
}

pub fn status(src: &str, equal_to: &[String]) -> ImageStatus {
    CACHE.with_borrow_mut(|cache| {
        ensure(cache, src, equal_to);
        match cache.entries[src].state {
            State::Pending { .. } => ImageStatus::Pending,
            State::Ready(_) => ImageStatus::Ready,
            State::Failed => ImageStatus::Failed,
        }
    })
}

pub(crate) fn image_size(src: &str, equal_to: &[String]) -> Option<(u32, u32)> {
    CACHE.with_borrow_mut(|cache| {
        ensure(cache, src, equal_to);
        cache.entries[src].dims
    })
}

#[cfg(test)]
fn with_image<R>(src: &str, f: impl FnOnce(tiny_skia::PixmapRef<'_>) -> R) -> Option<R> {
    CACHE.with_borrow_mut(|cache| {
        ensure(cache, src, &[]);
        match &cache.entries[src].state {
            State::Ready(pixmap) => Some(f((**pixmap).as_ref())),
            _ => None,
        }
    })
}

fn make_scaled(
    full: tiny_skia::PixmapRef<'_>,
    w: u32,
    h: u32,
    radius: [f32; 4],
) -> Option<tiny_skia::Pixmap> {
    let mut out = tiny_skia::Pixmap::new(w, h)?;
    let path = crate::shape::rounded_rect_path(0.0, 0.0, w as f32, h as f32, radius)?;
    let to_rect = tiny_skia::Transform::from_row(
        w as f32 / full.width() as f32,
        0.0,
        0.0,
        h as f32 / full.height() as f32,
        0.0,
        0.0,
    );
    let mut paint = tiny_skia::Paint {
        shader: tiny_skia::Pattern::new(
            full,
            tiny_skia::SpreadMode::Pad,
            tiny_skia::FilterQuality::Bilinear,
            1.0,
            to_rect,
        ),
        ..tiny_skia::Paint::default()
    };
    paint.anti_alias = true;
    out.as_mut().fill_path(
        &path,
        &paint,
        tiny_skia::FillRule::Winding,
        tiny_skia::Transform::identity(),
        None,
    );
    Some(out)
}

pub fn scaled_rgba(src: &str, equal_to: &[String], w: u32, h: u32) -> Option<Vec<u8>> {
    with_scaled_image(src, w, h, [0.0; 4], equal_to, |pixmap| pixmap.data().to_vec())
}

pub fn with_scaled_image<R>(
    src: &str,
    w: u32,
    h: u32,
    radius: [f32; 4],
    equal_to: &[String],
    f: impl FnOnce(tiny_skia::PixmapRef<'_>) -> R,
) -> Option<R> {
    if w == 0 || h == 0 {
        return None;
    }
    CACHE.with_borrow_mut(|cache| {
        ensure(cache, src, equal_to);
        let key = (w, h, radius.map(f32::to_bits));
        let entry = cache.entries.get(src)?;
        if !matches!(entry.state, State::Ready(_)) {
            return None;
        }
        if !entry.scaled.contains_key(&key) {
            let scaled = {
                let State::Ready(full) = &entry.state else {
                    return None;
                };
                crate::profiler::span_labeled(
                    "image.scale",
                    || format!("{} → {w}×{h}", basename(src)),
                    || make_scaled((**full).as_ref(), w, h, radius),
                )?
            };
            cache.bytes += scaled.data().len();
            cache
                .entries
                .get_mut(src)?
                .scaled
                .insert(key, Arc::new(scaled));
            evict_over_budget(cache, src);
        }
        let entry = cache.entries.get(src)?;
        Some(f((*entry.scaled[&key]).as_ref()))
    })
}

#[cfg(test)]
pub(crate) fn insert_decoded(src: String, img: &image::RgbaImage) {
    let Some(pixmap) = crate::profiler::span_labeled(
        "image.premultiply",
        || basename(&src).to_string(),
        || premultiply(img),
    ) else {
        return;
    };
    CACHE.with_borrow_mut(|cache| {
        cache.tick += 1;
        let tick = cache.tick;
        if let Some(old) = cache.entries.remove(&src) {
            cache.bytes -= entry_bytes(&old);
        }
        cache.bytes += pixmap.data().len();
        cache.entries.insert(
            src.clone(),
            Entry {
                dims: Some((pixmap.width(), pixmap.height())),
                state: State::Ready(Arc::new(pixmap)),
                scaled: HashMap::new(),
                last_use: tick,
            },
        );
        evict_over_budget(cache, &src);
    });
}

pub fn set_waker(wake: impl Fn() + Send + 'static) {
    CACHE.with_borrow_mut(|cache| {
        *cache.waker.lock().unwrap() = Some(Box::new(wake));
    });
}

#[derive(Default)]
pub struct Drained {
    pub landed: bool,
    // queued pastes
    pub pastes: Vec<(u64, Option<crate::clipboard_image::PastedImage>)>,
}

pub fn drain_completed() -> Drained {
    CACHE.with_borrow_mut(|cache| {
        let mut drained = Drained::default();
        let completed: Vec<Done> = match &cache.results {
            Some(results) => results.try_iter().collect(),
            None => return drained,
        };
        for done in completed {
            match done {
                Done::Pixels(result) => {
                    let src = result.src.clone();
                    let Some(entry) = cache.entries.get_mut(&src) else {
                        continue;
                    };
                    if matches!(entry.state, State::Ready(_)) {
                        continue;
                    }
                    drained.landed = true;
                    emit_lifecycle(&result);
                    match result.pixmap {
                        Some(pixmap) => {
                            entry.dims = Some((pixmap.width(), pixmap.height()));
                            cache.bytes += pixmap.data().len();
                            entry.state = State::Ready(Arc::new(pixmap));
                            evict_over_budget(cache, &src);
                        }
                        None => entry.state = State::Failed,
                    }
                }
                Done::Clipboard {
                    seq,
                    queued,
                    pasted,
                    has_pixels,
                } => {
                    if has_pixels && let Some(pasted) = &pasted {
                        cache.tick += 1;
                        let tick = cache.tick;
                        cache.entries.insert(
                            pasted.path.clone(),
                            Entry {
                                dims: Some((pasted.width, pasted.height)),
                                state: State::Pending { queued, seq },
                                scaled: HashMap::new(),
                                last_use: tick,
                            },
                        );
                    }
                    drained.pastes.push((seq, pasted));
                }
                Done::Encoded {
                    src,
                    seq,
                    started,
                    finished,
                } => {
                    if let Some(start_ms) = crate::profiler::ms_of(started) {
                        let dur =
                            finished.saturating_duration_since(started).as_secs_f64() * 1000.0;
                        crate::profiler::emit_span(
                            "image.encode",
                            start_ms,
                            dur,
                            1,
                            Some(seq),
                            Some(basename(&src).to_string()),
                        );
                    }
                }
            }
        }
        drained
    })
}

fn emit_lifecycle(result: &DecodeResult) {
    let Some(now) = crate::profiler::now_ms() else {
        return;
    };
    let queued = crate::profiler::ms_of(result.queued).unwrap_or(0.0);
    let started = crate::profiler::ms_of(result.started).unwrap_or(0.0);
    let decode_ms = result
        .finished
        .saturating_duration_since(result.started)
        .as_secs_f64()
        * 1000.0;
    let name = basename(&result.src);
    let outcome = match &result.pixmap {
        Some(p) => format!("{}×{}", p.width(), p.height()),
        None => "failed".to_string(),
    };
    let tries = if result.attempts > 1 {
        format!(", {} tries", result.attempts)
    } else {
        String::new()
    };
    crate::profiler::emit_span(
        "image.wait",
        queued,
        now - queued,
        0,
        Some(result.seq),
        Some(format!("{name} ({outcome}{tries})")),
    );
    crate::profiler::emit_span(
        "image.decode",
        started,
        decode_ms,
        1,
        Some(result.seq),
        Some(name.to_string()),
    );
}

pub(crate) fn emit_pending_waits() {
    CACHE.with_borrow(|cache| {
        let Some(now) = crate::profiler::now_ms() else {
            return;
        };
        for (src, entry) in &cache.entries {
            if let State::Pending { queued, seq } = entry.state {
                let start = crate::profiler::ms_of(queued).unwrap_or(0.0);
                crate::profiler::emit_span(
                    "image.wait",
                    start,
                    now - start,
                    0,
                    Some(seq),
                    Some(format!("{} (still decoding)", basename(src))),
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker(w: u32, h: u32) -> image::RgbaImage {
        image::RgbaImage::from_fn(w, h, |x, y| {
            if (x + y) % 2 == 0 {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 255, 128])
            }
        })
    }

    fn drain_until_landed() {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if drain_completed().landed {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "decode never completed"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn temp_png(name: &str, img: &image::RgbaImage) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pixel-image-cache-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        img.save(&path).unwrap();
        path
    }

    #[test]
    fn size_is_known_before_the_async_decode_lands_and_survives_deletion() {
        let path = temp_png("checker.png", &checker(4, 2));
        let src = path.to_string_lossy().to_string();
        assert_eq!(image_size(&src, &[]), Some((4, 2)));
        assert_eq!(status(&src, &[]), ImageStatus::Pending);
        assert!(with_image(&src, |_| ()).is_none());
        drain_until_landed();
        assert_eq!(status(&src, &[]), ImageStatus::Ready);
        let alpha_seen = with_image(&src, |p| p.pixels().iter().any(|px| px.alpha() < 255));
        assert_eq!(alpha_seen, Some(true));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(image_size(&src, &[]), Some((4, 2)), "still cached after the file is gone");
        assert_eq!(status(&src, &[]), ImageStatus::Ready);
    }

    #[test]
    fn missing_file_fails_after_retries() {
        let src = "/nonexistent/nope.png";
        assert_eq!(image_size(src, &[]), None);
        assert_eq!(status(src, &[]), ImageStatus::Pending);
        drain_until_landed();
        assert_eq!(status(src, &[]), ImageStatus::Failed);
        assert_eq!(image_size(src, &[]), None);
    }

    #[test]
    fn drain_emits_lifecycle_spans_while_recording() {
        let path = temp_png("profiled.png", &checker(5, 4));
        let src = path.to_string_lossy().to_string();
        let wait_span = |data: &crate::profiler::ProfileData| {
            data.spans
                .iter()
                .find(|s| s.name == "image.wait")
                .cloned()
                .expect("wait span")
        };

        crate::profiler::start();
        assert_eq!(status(&src, &[]), ImageStatus::Pending);
        emit_pending_waits();
        let in_flight = crate::profiler::stop().unwrap();
        assert!(in_flight.spans.iter().any(|s| s.name == "image.sniff"));
        let wait = wait_span(&in_flight);
        assert!(
            wait.label.as_deref().unwrap().contains("still decoding"),
            "{:?}",
            wait.label
        );

        crate::profiler::start();
        drain_until_landed();
        emit_pending_waits();
        let landed = crate::profiler::stop().unwrap();
        std::fs::remove_file(&path).unwrap();
        let wait = wait_span(&landed);
        let label = wait.label.as_deref().expect("wait label");
        assert!(label.contains("profiled.png") && label.contains("5×4"), "{label}");
        let decode = landed
            .spans
            .iter()
            .find(|s| s.name == "image.decode")
            .expect("decode span");
        assert_eq!(decode.arg, wait.arg);
        assert!(wait.dur_ms >= decode.dur_ms);
        assert!(
            !landed.spans.iter().any(|s| {
                s.label.as_deref().is_some_and(|l| l.contains("still decoding"))
            }),
            "the image landed, so nothing is still decoding"
        );
    }

    #[test]
    fn scaled_variants_serve_at_the_requested_size() {
        let img = image::RgbaImage::from_pixel(8, 4, image::Rgba([10, 220, 30, 255]));
        insert_decoded("mem://scaled".into(), &img);
        let size = with_scaled_image("mem://scaled", 4, 2, [0.0; 4], &[], |p| {
            (p.width(), p.height(), p.pixels()[0].green())
        });
        assert_eq!(size, Some((4, 2, 220)));
        // Radius is baked into the variant's corner alpha.
        let corner = with_scaled_image("mem://scaled", 8, 8, [4.0; 4], &[], |p| p.pixels()[0].alpha());
        assert_eq!(corner, Some(0));
        assert!(with_scaled_image("mem://scaled", 0, 2, [0.0; 4], &[], |_| ()).is_none());
        assert!(with_scaled_image("mem://missing-entirely", 4, 2, [0.0; 4], &[], |_| ()).is_none());
    }

    #[test]
    fn confirmed_equal_srcs_share_pixels_without_a_decode() {
        let img = checker(6, 2);
        insert_decoded("mem://original".into(), &img);
        // The aliased src has no file behind it, so Ready pixels prove the
        // entry was seeded from the alias rather than decoded.
        let aliases = vec!["mem://original".to_string()];
        let src = "/nonexistent/persisted.png";
        assert_eq!(status(src, &aliases), ImageStatus::Ready);
        assert_eq!(image_size(src, &aliases), Some((6, 2)));
        let scaled = with_scaled_image(src, 3, 1, [0.0; 4], &aliases, |p| (p.width(), p.height()));
        assert_eq!(scaled, Some((3, 1)));
        // Unknown aliases fall through to the ordinary pending path.
        let missing = vec!["mem://never-existed".to_string()];
        assert_eq!(status("/nonexistent/other.png", &missing), ImageStatus::Pending);
    }

}

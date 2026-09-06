use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use pixel_core::surfaces::Rect;


pub struct Config {
    pub queue_frames: usize,
    pub key_interval: Duration,
    pub writer_delay: Option<Duration>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            queue_frames: 8,
            key_interval: Duration::from_secs(1),
            writer_delay: None,
        }
    }
}

#[derive(Clone, Copy)]
pub struct FrameMeta {
    pub t_us: u64,
    offset: u64,
    len: u32,
    rect: Rect,
    pub width: u32,
    pub height: u32,
    pub key: bool,
    pub drops_before: u32,
}

const IDX_RECORD_BYTES: usize = 52;

struct QueuedFrame {
    t_us: u64,
    rect: Rect,
    width: u32,
    height: u32,
    key: bool,
    drops_before: u32,
    payload: Vec<u8>,
}

#[derive(Default)]
struct BufferPool(Mutex<Vec<Vec<u8>>>);

impl BufferPool {
    fn take(&self) -> Vec<u8> {
        let mut buffers = self.0.lock().unwrap_or_else(|error| error.into_inner());
        buffers.pop().unwrap_or_default()
    }

    fn put(&self, mut buffer: Vec<u8>) {
        buffer.clear();
        let mut buffers = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if buffers.len() < 16 {
            buffers.push(buffer);
        }
    }
}

pub struct Recorder {
    t0: Instant,
    tx: SyncSender<QueuedFrame>,
    writer: JoinHandle<io::Result<(Vec<FrameMeta>, File)>>,
    pool: Arc<BufferPool>,
    key_interval_us: u64,
    next_key_us: u64,
    dims: (u32, u32),
    damage_owed: Rect,
    key_owed: bool,
    drops_pending: u32,
    submitted: u64,
    drops: u64,
}

impl Recorder {
    pub fn new(dir: &Path, config: Config) -> io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let open = |name: &str| {
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(true)
                .open(dir.join(name))
        };
        let seg = open("frames.seg")?;
        let idx = open("frames.idx")?;
        let (tx, rx) = sync_channel(config.queue_frames);
        let pool = Arc::new(BufferPool::default());
        let writer_pool = pool.clone();
        let delay = config.writer_delay;
        let writer = std::thread::spawn(move || write_frames(rx, seg, idx, writer_pool, delay));
        Ok(Self {
            t0: Instant::now(),
            tx,
            writer,
            pool,
            key_interval_us: config.key_interval.as_micros() as u64,
            next_key_us: 0,
            dims: (0, 0),
            damage_owed: Rect::default(),
            key_owed: false,
            drops_pending: 0,
            submitted: 0,
            drops: 0,
        })
    }

    pub fn capture(
        &mut self,
        pixels: &[u8],
        stride: usize,
        width: u32,
        height: u32,
        damage: Option<Rect>,
    ) -> bool {
        self.submitted += 1;
        let t_us = self.t0.elapsed().as_micros() as u64;
        let key = self.key_owed
            || self.dims != (width, height)
            || damage.is_none()
            || t_us >= self.next_key_us;
        let rect = if key {
            Rect::sized(width, height)
        } else {
            damage
                .unwrap_or_default()
                .union(self.damage_owed)
                .clamped(width, height)
        };
        let mut payload = self.pool.take();
        let row_bytes = rect.w as usize * 4;
        payload.reserve(row_bytes * rect.h as usize);
        for row in rect.y..rect.y + rect.h {
            let start = row as usize * stride + rect.x as usize * 4;
            payload.extend_from_slice(&pixels[start..start + row_bytes]);
        }
        let frame = QueuedFrame {
            t_us,
            rect,
            width,
            height,
            key,
            drops_before: self.drops_pending,
            payload,
        };
        match self.tx.try_send(frame) {
            Ok(()) => {
                self.damage_owed = Rect::default();
                self.key_owed = false;
                self.drops_pending = 0;
                self.dims = (width, height);
                if key {
                    self.next_key_us = t_us.saturating_add(self.key_interval_us);
                }
                true
            }
            Err(TrySendError::Full(frame)) | Err(TrySendError::Disconnected(frame)) => {
                self.drops += 1;
                self.drops_pending = self.drops_pending.saturating_add(1);
                if frame.key {
                    self.key_owed = true;
                } else {
                    self.damage_owed = self.damage_owed.union(frame.rect);
                }
                self.pool.put(frame.payload);
                false
            }
        }
    }

    pub fn finish(self) -> io::Result<Segment> {
        let Recorder {
            t0, tx, writer, drops, ..
        } = self;
        let duration_us = t0.elapsed().as_micros() as u64;
        drop(tx);
        let (metas, seg) = writer
            .join()
            .map_err(|_| io::Error::other("capture writer panicked"))??;
        Ok(Segment::new(metas, seg, drops, duration_us))
    }
}

fn write_frames(
    rx: Receiver<QueuedFrame>,
    seg: File,
    idx: File,
    pool: Arc<BufferPool>,
    delay: Option<Duration>,
) -> io::Result<(Vec<FrameMeta>, File)> {
    let mut seg_out = BufWriter::with_capacity(1 << 20, seg);
    let mut idx_out = BufWriter::new(idx);
    let mut compressed = Vec::new();
    let mut offset = 0u64;
    let mut metas: Vec<FrameMeta> = Vec::new();
    while let Ok(frame) = rx.recv() {
        if let Some(delay) = delay {
            std::thread::sleep(delay);
        }
        compressed.resize(
            lz4_flex::block::get_maximum_output_size(frame.payload.len()),
            0,
        );
        let len = lz4_flex::block::compress_into(&frame.payload, &mut compressed)
            .map_err(io::Error::other)?;
        seg_out.write_all(&compressed[..len])?;
        let meta = FrameMeta {
            t_us: frame.t_us,
            offset,
            len: len as u32,
            rect: frame.rect,
            width: frame.width,
            height: frame.height,
            key: frame.key,
            drops_before: frame.drops_before,
        };
        write_idx_record(&mut idx_out, &meta)?;
        offset += len as u64;
        metas.push(meta);
        pool.put(frame.payload);
    }
    idx_out.flush()?;
    let seg = seg_out
        .into_inner()
        .map_err(io::IntoInnerError::into_error)?;
    Ok((metas, seg))
}

fn write_idx_record(out: &mut impl Write, meta: &FrameMeta) -> io::Result<()> {
    out.write_all(&meta.t_us.to_le_bytes())?;
    out.write_all(&meta.offset.to_le_bytes())?;
    let words = [
        meta.len,
        meta.rect.x,
        meta.rect.y,
        meta.rect.w,
        meta.rect.h,
        meta.width,
        meta.height,
        u32::from(meta.key),
        meta.drops_before,
    ];
    for word in words {
        out.write_all(&word.to_le_bytes())?;
    }
    Ok(())
}

pub fn read_idx(path: &Path) -> io::Result<Vec<FrameMeta>> {
    let mut bytes = Vec::new();
    File::open(path)?.read_to_end(&mut bytes)?;
    if bytes.len() % IDX_RECORD_BYTES != 0 {
        return Err(io::Error::other("truncated capture index"));
    }
    Ok(bytes
        .chunks_exact(IDX_RECORD_BYTES)
        .map(|record| {
            let u64_at = |at: usize| u64::from_le_bytes(record[at..at + 8].try_into().unwrap());
            let u32_at = |at: usize| u32::from_le_bytes(record[at..at + 4].try_into().unwrap());
            FrameMeta {
                t_us: u64_at(0),
                offset: u64_at(8),
                len: u32_at(16),
                rect: Rect {
                    x: u32_at(20),
                    y: u32_at(24),
                    w: u32_at(28),
                    h: u32_at(32),
                },
                width: u32_at(36),
                height: u32_at(40),
                key: u32_at(44) != 0,
                drops_before: u32_at(48),
            }
        })
        .collect())
}

const SNAPSHOT_STRIDE: usize = 16;
const SNAPSHOT_BUDGET_BYTES: usize = 256 << 20;

struct Snapshot {
    canvas: Vec<u8>,
    dims: (u32, u32),
    used: u64,
}

pub struct Segment {
    metas: Vec<FrameMeta>,
    seg: File,
    pub drops: u64,
    pub duration_us: u64,
    canvas: Vec<u8>,
    dims: (u32, u32),
    cached: Option<usize>,
    compressed: Vec<u8>,
    rows: Vec<u8>,
    snapshots: std::collections::BTreeMap<usize, Snapshot>,
    snapshot_bytes: usize,
    clock: u64,
}

#[cfg(unix)]
fn read_exact_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt as _;
    file.read_exact_at(buf, offset)
}

#[cfg(windows)]
fn read_exact_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt as _;
    let mut done = 0;
    while done < buf.len() {
        match file.seek_read(&mut buf[done..], offset + done as u64)? {
            0 => return Err(io::ErrorKind::UnexpectedEof.into()),
            read => done += read,
        }
    }
    Ok(())
}

impl Segment {
    fn new(metas: Vec<FrameMeta>, seg: File, drops: u64, duration_us: u64) -> Segment {
        Segment {
            metas,
            seg,
            drops,
            duration_us,
            canvas: Vec::new(),
            dims: (0, 0),
            cached: None,
            compressed: Vec::new(),
            rows: Vec::new(),
            snapshots: std::collections::BTreeMap::new(),
            snapshot_bytes: 0,
            clock: 0,
        }
    }

    pub fn open(dir: &Path) -> io::Result<Segment> {
        let metas = read_idx(&dir.join("frames.idx"))?;
        let seg = File::open(dir.join("frames.seg"))?;
        let drops = metas.iter().map(|meta| u64::from(meta.drops_before)).sum();
        let duration_us = metas.last().map_or(0, |meta| meta.t_us);
        Ok(Segment::new(metas, seg, drops, duration_us))
    }

    pub fn metas(&self) -> &[FrameMeta] {
        &self.metas
    }

    pub fn frame(&mut self, index: usize) -> io::Result<(&[u8], u32, u32)> {
        if index >= self.metas.len() {
            return Err(io::Error::other("frame index out of range"));
        }
        self.clock += 1;
        if self.cached != Some(index) {
            let start = self.replay_start(index)?;
            let scrubbing = start + SNAPSHOT_STRIDE <= index;
            for at in start..=index {
                if let Err(error) = self.apply(at) {
                    self.cached = None;
                    return Err(error);
                }
                if scrubbing {
                    self.remember(at);
                }
            }
            self.cached = Some(index);
        }
        Ok((&self.canvas, self.dims.0, self.dims.1))
    }

    fn replay_start(&mut self, index: usize) -> io::Result<usize> {
        let key = self.metas[..=index]
            .iter()
            .rposition(|meta| meta.key)
            .ok_or_else(|| io::Error::other("no keyframe before frame"))?;
        let cached = self
            .cached
            .filter(|&cached| cached <= index)
            .map(|cached| cached + 1)
            .unwrap_or(0);
        let snapshot = self
            .snapshots
            .range(..=index)
            .next_back()
            .map(|(&at, _)| at + 1)
            .unwrap_or(0);
        if cached >= key.max(snapshot) {
            return Ok(cached);
        }
        if snapshot > key {
            let at = snapshot - 1;
            let stored = self.snapshots.get_mut(&at).expect("snapshot exists");
            stored.used = self.clock;
            self.canvas.clear();
            self.canvas.extend_from_slice(&stored.canvas);
            self.dims = stored.dims;
            return Ok(snapshot);
        }
        Ok(key)
    }

    fn remember(&mut self, index: usize) {
        if index % SNAPSHOT_STRIDE != 0 || self.snapshots.contains_key(&index) {
            return;
        }
        self.snapshot_bytes += self.canvas.len();
        self.snapshots.insert(
            index,
            Snapshot {
                canvas: self.canvas.clone(),
                dims: self.dims,
                used: self.clock,
            },
        );
        while self.snapshot_bytes > SNAPSHOT_BUDGET_BYTES && self.snapshots.len() > 1 {
            let stale = self
                .snapshots
                .iter()
                .min_by_key(|(_, snapshot)| snapshot.used)
                .map(|(&at, _)| at)
                .expect("snapshots not empty");
            if let Some(removed) = self.snapshots.remove(&stale) {
                self.snapshot_bytes -= removed.canvas.len();
            }
        }
    }

    fn apply(&mut self, index: usize) -> io::Result<()> {
        let meta = self.metas[index];
        if meta.key {
            self.dims = (meta.width, meta.height);
            self.canvas.clear();
            self.canvas
                .resize(meta.width as usize * meta.height as usize * 4, 0);
        }
        let expected = meta.rect.w as usize * meta.rect.h as usize * 4;
        if expected == 0 {
            return Ok(());
        }
        self.compressed.resize(meta.len as usize, 0);
        read_exact_at(&self.seg, &mut self.compressed, meta.offset)?;
        self.rows.resize(expected, 0);
        let written = lz4_flex::block::decompress_into(&self.compressed, &mut self.rows)
            .map_err(io::Error::other)?;
        if written != expected {
            return Err(io::Error::other("frame payload size mismatch"));
        }
        let row_bytes = meta.rect.w as usize * 4;
        let stride = self.dims.0 as usize * 4;
        for row in 0..meta.rect.h as usize {
            let dst = (meta.rect.y as usize + row) * stride + meta.rect.x as usize * 4;
            self.canvas[dst..dst + row_bytes]
                .copy_from_slice(&self.rows[row * row_bytes..][..row_bytes]);
        }
        Ok(())
    }
}

pub struct CaptureStats {
    pub frames: u64,
    pub drops: u64,
    pub duration_us: u64,
}

enum Slot {
    Active(u32, Recorder),
    Stopped(Segment),
}

#[derive(Default)]
struct Inner {
    next_id: u32,
    by_surface: HashMap<u32, u32>,
    slots: HashMap<u32, Slot>,
}

#[derive(Default)]
pub struct Registry {
    active: AtomicU32,
    inner: Mutex<Inner>,
}

impl Registry {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn start(&self, surface: u32, dir: &Path) -> io::Result<u32> {
        let mut inner = self.lock();
        if inner.by_surface.contains_key(&surface) {
            return Err(io::Error::other("surface is already being captured"));
        }
        let recorder = Recorder::new(dir, Config::default())?;
        inner.next_id += 1;
        let id = inner.next_id;
        inner.by_surface.insert(surface, id);
        inner.slots.insert(id, Slot::Active(surface, recorder));

        self.active.fetch_add(1, Ordering::Relaxed);
        Ok(id)
    }

    #[cfg_attr(windows, allow(dead_code))]
    pub fn wants(&self, surface: u32) -> bool {
        self.active.load(Ordering::Relaxed) > 0
            && self.lock().by_surface.contains_key(&surface)
    }

    pub fn capture(
        &self,
        surface: u32,
        pixels: &[u8],
        stride: usize,
        width: u32,
        height: u32,
        damage: Option<Rect>,
    ) {
        if self.active.load(Ordering::Relaxed) == 0 {
            return;
        }
        let mut inner = self.lock();
        let Some(&id) = inner.by_surface.get(&surface) else {
            return;
        };
        if let Some(Slot::Active(_, recorder)) = inner.slots.get_mut(&id) {
            recorder.capture(pixels, stride, width, height, damage);
        }
    }

    pub fn stop(&self, id: u32) -> io::Result<CaptureStats> {
        let mut inner = self.lock();
        match inner.slots.remove(&id) {
            Some(Slot::Active(surface, recorder)) => {
                inner.by_surface.remove(&surface);
                self.active.fetch_sub(1, Ordering::Relaxed);
                drop(inner);
                let segment = recorder.finish()?;
                let stats = CaptureStats {
                    frames: segment.metas.len() as u64,
                    drops: segment.drops,
                    duration_us: segment.duration_us,
                };
                self.lock().slots.insert(id, Slot::Stopped(segment));
                Ok(stats)
            }
            Some(slot @ Slot::Stopped(_)) => {
                inner.slots.insert(id, slot);
                Err(io::Error::other("capture is already stopped"))
            }
            None => Err(io::Error::other("unknown capture")),
        }
    }

    pub fn with_segment<T>(
        &self,
        id: u32,
        read: impl FnOnce(&mut Segment) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut inner = self.lock();
        match inner.slots.get_mut(&id) {
            Some(Slot::Stopped(segment)) => read(segment),
            Some(Slot::Active(..)) => Err(io::Error::other("capture is still running")),
            None => Err(io::Error::other("unknown capture")),
        }
    }

    pub fn release(&self, id: u32) {
        let mut inner = self.lock();
        if let Some(Slot::Active(surface, _)) = inner.slots.remove(&id) {
            inner.by_surface.remove(&surface);
            self.active.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
    }

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pixel-capture-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn fill(canvas: &mut [u8], stride: usize, rect: Rect, rng: &mut Lcg) {
        for row in rect.y..rect.y + rect.h {
            for col in rect.x..rect.x + rect.w {
                let at = row as usize * stride + col as usize * 4;
                canvas[at..at + 4].copy_from_slice(&rng.next().to_le_bytes());
            }
        }
    }

    fn tight(canvas: &[u8], stride: usize, width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(width as usize * height as usize * 4);
        for row in 0..height as usize {
            out.extend_from_slice(&canvas[row * stride..][..width as usize * 4]);
        }
        out
    }

    fn random_rect(rng: &mut Lcg, width: u32, height: u32) -> Rect {
        let x = rng.next() % width;
        let y = rng.next() % height;
        Rect {
            x,
            y,
            w: 1 + rng.next() % (width - x),
            h: 1 + rng.next() % (height - y),
        }
    }

    #[test]
    fn every_frame_reconstructs_byte_identical() {
        let dir = test_dir("exact");
        let mut recorder = Recorder::new(
            &dir,
            Config {
                queue_frames: 128,
                ..Config::default()
            },
        )
        .expect("recorder starts");
        let mut rng = Lcg(7);
        let mut snapshots: Vec<(Vec<u8>, u32, u32)> = Vec::new();

        let stride = 64 * 4 + 16;
        let mut canvas = vec![0u8; stride * 48];
        for frame in 0..30 {
            let damage = if frame % 10 == 0 {
                None
            } else {
                Some(random_rect(&mut rng, 64, 48))
            };
            fill(&mut canvas, stride, damage.unwrap_or(Rect::sized(64, 48)), &mut rng);
            assert!(recorder.capture(&canvas, stride, 64, 48, damage));
            snapshots.push((tight(&canvas, stride, 64, 48), 64, 48));
        }

        let stride = 80 * 4;
        let mut canvas = vec![0u8; stride * 40];
        for _ in 0..10 {
            let damage = Some(random_rect(&mut rng, 80, 40));
            fill(&mut canvas, stride, damage.unwrap(), &mut rng);
            assert!(recorder.capture(&canvas, stride, 80, 40, damage));
            snapshots.push((tight(&canvas, stride, 80, 40), 80, 40));
        }

        assert_eq!(recorder.submitted, snapshots.len() as u64);
        let mut segment = recorder.finish().expect("writer finishes");
        assert_eq!(segment.drops, 0);
        assert_eq!(segment.metas().len(), snapshots.len());
        assert!(segment.metas()[0].key);
        assert!(segment.metas()[30].key, "resize forces a keyframe");

        let mut order: Vec<usize> = (0..snapshots.len()).rev().chain(0..snapshots.len()).collect();
        let mut jumps = Lcg(99);
        order.extend((0..80).map(|_| jumps.next() as usize % snapshots.len()));
        for at in order {
            let (pixels, width, height) = segment.frame(at).expect("frame decodes");
            let (expected, expected_w, expected_h) = &snapshots[at];
            assert_eq!((width, height), (*expected_w, *expected_h), "frame {at} dims");
            assert!(pixels == expected.as_slice(), "frame {at} pixels differ");
        }
    }

    #[test]
    fn saturation_drops_are_explicit_and_reconstruction_survives() {
        let dir = test_dir("drops");
        let mut recorder = Recorder::new(
            &dir,
            Config {
                queue_frames: 1,
                writer_delay: Some(Duration::from_millis(3)),
                ..Config::default()
            },
        )
        .expect("recorder starts");
        let mut rng = Lcg(11);
        let mut snapshots: Vec<Vec<u8>> = Vec::new();

        let stride = 32 * 4;
        let mut canvas = vec![0u8; stride * 24];
        for _ in 0..60 {
            let damage = Some(random_rect(&mut rng, 32, 24));
            fill(&mut canvas, stride, damage.unwrap(), &mut rng);
            if recorder.capture(&canvas, stride, 32, 24, damage) {
                snapshots.push(canvas.clone());
            }
        }

        let submitted = recorder.submitted;
        let mut segment = recorder.finish().expect("writer finishes");
        assert!(segment.drops > 0, "test needs saturation to mean anything");
        assert_eq!(
            submitted,
            segment.metas().len() as u64 + segment.drops,
            "every submitted frame is recorded or an explicit drop"
        );
        assert_eq!(segment.metas().len(), snapshots.len());

        for at in 0..snapshots.len() {
            let (pixels, ..) = segment.frame(at).expect("frame decodes");
            assert!(
                pixels == snapshots[at].as_slice(),
                "frame {at} must fold dropped damage forward"
            );
        }

        let counted: u64 = segment
            .metas()
            .iter()
            .map(|meta| u64::from(meta.drops_before))
            .sum();
        assert!(counted <= segment.drops);
    }

    #[test]
    fn backward_scrub_stays_cheap_via_snapshots() {
        let dir = test_dir("scrub");
        let mut recorder = Recorder::new(
            &dir,
            Config {
                queue_frames: 512,
                ..Config::default()
            },
        )
        .expect("recorder starts");
        let (width, height) = (1600u32, 1200u32);
        let stride = width as usize * 4;
        let mut rng = Lcg(3);
        let mut canvas = vec![0u8; stride * height as usize];
        fill(&mut canvas, stride, Rect::sized(width, height), &mut rng);
        recorder.capture(&canvas, stride, width, height, None);
        for _ in 0..299 {
            let damage = Rect {
                x: rng.next() % (width - 64),
                y: rng.next() % (height - 64),
                w: 64,
                h: 64,
            };
            fill(&mut canvas, stride, damage, &mut rng);
            assert!(recorder.capture(&canvas, stride, width, height, Some(damage)));
        }
        let mut segment = recorder.finish().expect("writer finishes");
        segment.frame(299).expect("prime the tail");
        let start = Instant::now();
        for at in (150..299).rev() {
            segment.frame(at).expect("backward step");
        }
        let took = start.elapsed();
        assert!(
            took < Duration::from_secs(2),
            "149 backward steps took {took:?}"
        );
    }

    #[test]
    fn index_file_round_trips() {
        let dir = test_dir("idx");
        let mut recorder = Recorder::new(&dir, Config::default()).expect("recorder starts");
        let stride = 16 * 4;
        let canvas = vec![9u8; stride * 16];
        for _ in 0..5 {
            recorder.capture(&canvas, stride, 16, 16, Some(Rect::sized(4, 4)));
        }
        let segment = recorder.finish().expect("writer finishes");
        let metas = read_idx(&dir.join("frames.idx")).expect("index reads");
        assert_eq!(metas.len(), segment.metas().len());
        for (a, b) in metas.iter().zip(segment.metas()) {
            assert_eq!(a.t_us, b.t_us);
            assert_eq!(a.offset, b.offset);
            assert_eq!(a.len, b.len);
            assert_eq!(a.rect, b.rect);
            assert_eq!((a.width, a.height), (b.width, b.height));
            assert_eq!(a.key, b.key);
            assert_eq!(a.drops_before, b.drops_before);
        }
    }

    #[test]
    fn zero_key_interval_makes_every_frame_a_keyframe() {
        let dir = test_dir("keys");
        let mut recorder = Recorder::new(
            &dir,
            Config {
                key_interval: Duration::ZERO,
                ..Config::default()
            },
        )
        .expect("recorder starts");
        let stride = 8 * 4;
        let canvas = vec![3u8; stride * 8];
        for _ in 0..4 {
            recorder.capture(&canvas, stride, 8, 8, Some(Rect::sized(2, 2)));
        }
        let segment = recorder.finish().expect("writer finishes");
        assert!(segment.metas().iter().all(|meta| meta.key));
    }
}

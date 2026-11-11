use std::io;
use std::time::{Duration, Instant};

use pixel_raster::Canvas;

mod herdr;
mod host;
mod kitty;
pub mod native;
mod payload;
mod present;
mod shm_pool;
#[cfg(test)]
mod transport_tests;
mod wrapper;

pub use herdr::HerdrTarget;
pub use kitty::kitty_transmit;
pub use wrapper::Wrapper;

use kitty::Placement;
use payload::Payloads;
use present::{Identity, Presenter};

pub trait Tty {
    fn output(&self) -> io::Result<Output>;
    fn read_reply(
        &mut self,
        timeout_ms: u64,
        keep_input: bool,
        find: &mut dyn FnMut(&[u8]) -> Option<std::ops::Range<usize>>,
    ) -> io::Result<bool>;
    fn host_send(&mut self, message: serde_json::Value) -> io::Result<()>;
    fn host(&self) -> Option<Host>;
    fn wrapper(&self) -> Wrapper;
    fn cell(&self) -> Option<(u32, u32)>;
    fn screen(&self) -> Option<Screen>;
}

pub trait Vars {
    fn var(&self, key: &str) -> Option<String>;
}

#[derive(Debug, Clone)]
pub struct Host {
    pub embedded: bool,
    pub closed: bool,
    pub transport: Option<String>,
    pub image_id: Option<u32>,
    pub target: Option<HerdrTarget>,
}

#[derive(Debug, Clone, Copy)]
pub struct Screen {
    pub cols: u32,
    pub rows: u32,
    pub cell: Option<(u32, u32)>,
}

pub struct Output {
    out: Box<dyn io::Write + Send>,
    tty: Option<std::fs::File>,
}

impl Output {
    pub fn new(out: Box<dyn io::Write + Send>, tty: Option<std::fs::File>) -> Self {
        Self { out, tty }
    }

    fn out(&mut self) -> &mut dyn io::Write {
        &mut self.out
    }
}

pub struct Kitty {
    io: Output,
    hosted: bool,
    embedded: bool,
    last_frame_size: Option<(u32, u32)>,
    cell: Option<(u32, u32)>,
    screen: Option<Screen>,
    cell_change: Option<(u32, u32)>,
    transport: FrameTransport,
    transport_retry: TransportRetry,
    herdr: Option<herdr::Herdr>,
    herdr_target: Option<HerdrTarget>,
    herdr_retry: Option<(Instant, Duration)>,
    frame_files: Vec<FrameFile>,
    frame_seq: u64,
    payloads: Payloads,
    wrapper: Wrapper,
    image_id: u32,
    placeholders: Option<(u32, u32)>,
    placed_grid: Option<(u32, u32)>,
    identity: Identity,
    present: Presenter,
    patches: present::Patched,
    animation: present::Animation,
    highlight_transmits: bool,
    present_at: Option<Instant>,
    ready_at: Option<Instant>,
    shm_pool: Option<shm_pool::ShmPool>,
    overlay: present::Overlay,
    flashes: present::Flashes,
    terminal_id: u64,
    native: native::NativeInput,
}

fn ask<T>(
    tty: &mut dyn Tty,
    timeout_ms: u64,
    keep_input: bool,
    parse: impl Fn(&[u8]) -> Option<(T, std::ops::Range<usize>)>,
) -> io::Result<Option<T>> {
    let mut found = None;
    tty.read_reply(timeout_ms, keep_input, &mut |buf| {
        let (value, range) = parse(buf)?;
        found = Some(value);
        Some(range)
    })?;
    Ok(found)
}

impl Kitty {
    pub fn new(tty: &mut dyn Tty, env: &dyn Vars) -> io::Result<Self> {
        let host = tty.host();
        let target = match &host {
            Some(host) => host.target.clone(),
            None => HerdrTarget::from_env(env),
        };
        let mut kitty = Self::blank(tty.output()?, tty.wrapper(), target);
        kitty.cell = tty.cell();
        kitty.connect_herdr();
        match host {
            Some(Host { embedded: true, transport, image_id, .. }) => {
                kitty.hosted = true;
                kitty.embedded = true;
                kitty.transport = match transport.as_deref() {
                    Some("file") => FrameTransport::File,
                    Some("shm") | Some("shared") => FrameTransport::Shared,
                    Some("host") => FrameTransport::Host,
                    _ => FrameTransport::Inline,
                };
                kitty.image_id = image_id.unwrap_or_else(|| frame_image_id(true));
            }
            Some(_) => {
                kitty.hosted = true;
                if kitty.herdr.is_none() {
                    return Err(io::Error::other("host did not accept the frame stream"));
                }
            }
            None => {
                if kitty.herdr.is_none() && kitty.herdr_target.is_some() {
                    kitty.herdr_retry = Some((Instant::now() + HERDR_RETRY_MIN, HERDR_RETRY_MIN));
                }
                kitty.transport = kitty.probe_transport(tty, env)?;
                kitty.identity = kitty.probe_identity(tty, env)?;
                kitty.present = kitty.choose_present(tty, env)?;
            }
        }
        Ok(kitty)
    }

    fn blank(io: Output, wrapper: Wrapper, herdr_target: Option<HerdrTarget>) -> Self {
        Self {
            io,
            hosted: false,
            embedded: false,
            last_frame_size: None,
            cell: None,
            screen: None,
            cell_change: None,
            transport: FrameTransport::Inline,
            transport_retry: TransportRetry::Settled,
            herdr: None,
            herdr_target,
            herdr_retry: None,
            frame_files: Vec::new(),
            frame_seq: 0,
            payloads: Payloads::default(),
            wrapper,
            image_id: frame_image_id(wrapper.relayed()),
            placeholders: None,
            placed_grid: None,
            identity: Identity::Unknown,
            present: Presenter::Full,
            patches: present::Patched::default(),
            animation: present::Animation::default(),
            highlight_transmits: false,
            present_at: None,
            ready_at: None,
            shm_pool: None,
            overlay: present::Overlay::default(),
            flashes: present::Flashes::default(),
            terminal_id: NEXT_TERMINAL_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            native: native::NativeInput::default(),
        }
    }

    pub fn sync(&mut self, tty: &dyn Tty) {
        self.cell = tty.cell();
        self.screen = tty.screen();
    }

    pub fn take_cell_change(&mut self) -> Option<(u32, u32)> {
        self.cell_change.take()
    }

    pub fn relay_cell(&self) -> Option<(u32, u32)> {
        self.herdr.as_ref().map(herdr::Herdr::cell)
    }

    pub fn window_changed(&mut self) {
        if self.hosted {
            self.placeholders = None;
        }
    }

    pub fn native_active(&self) -> bool {
        self.native.active()
    }

    pub fn native(&mut self) -> &mut native::NativeInput {
        &mut self.native
    }

    pub fn pointer_shape<'a>(&self, shape: &'a str) -> &'a str {
        if cfg!(target_os = "macos") && self.identity.is_ghostty() {
            nearest_shape_ghostty_macos_draws(shape)
        } else {
            shape
        }
    }

    pub fn close(&mut self) {
        if self.embedded {
            if self.transport == FrameTransport::Host {
                self.payloads.remove_all();
                return;
            }
            let _ = self.io.out().write_all(&crate::kitty::kitty_delete_one(self.image_id));
            let _ = self.io.out().flush();
            return;
        }
        self.payloads.remove_all();
        let delete = crate::kitty::kitty_delete(self.image_id, self.wrapper);
        let _ = self.io.out().write_all(&delete);
        let _ = self.io.out().flush();
    }

    fn probe_transport(&mut self, tty: &mut dyn Tty, env: &dyn Vars) -> io::Result<FrameTransport> {
        if let Some(forced) = env
            .var("TERMINAL_BROWSER_FRAMES")
            .and_then(|value| match value.trim() {
                "file" => Some(FrameTransport::File),
                "shared" | "shm" => Some(FrameTransport::Shared),
                "inline" => Some(FrameTransport::Inline),
                _ => None,
            })
        {
            pixel_core::logging::info("terminal", format!("frame transport forced to {forced:?}"));
            return Ok(forced);
        }
        let probe = self.probe_frames(tty)?;
        if probe == FrameProbe::Unanswered && self.wrapper.relayed() && !present::over_ssh(env) {
            self.transport_retry = TransportRetry::Ready;
        }
        if let FrameProbe::Accepted(transport) = probe {
            return Ok(transport);
        }
        // bad
        pixel_core::logging::warn(
            "terminal",
            if self.wrapper.relayed() {
                "no answer about file or shared memory frames under tmux, sending pixels inline — \
                 check `tmux show -p allow-passthrough`, or set TERMINAL_BROWSER_FRAMES=file"
            } else {
                "terminal takes neither file nor shared memory frames, sending pixels inline"
            },
        );
        Ok(FrameTransport::Inline)
    }

    fn probe_frames(&mut self, tty: &mut dyn Tty) -> io::Result<FrameProbe> {
        let shared = self.probe_shared_memory(tty)?;
        if shared == Some(true) {
            pixel_core::logging::info("terminal", "frames go through shared memory");
            return Ok(FrameProbe::Accepted(FrameTransport::Shared));
        }
        let file = self.probe_frame_file(tty)?;
        if file == Some(true) {
            pixel_core::logging::info("terminal", "frames go through a file the terminal re-reads");
            return Ok(FrameProbe::Accepted(FrameTransport::File));
        }
        if shared.is_none() && file.is_none() {
            return Ok(FrameProbe::Unanswered);
        }
        Ok(FrameProbe::Refused)
    }

    pub fn retry_frame_transport(&mut self, tty: &mut dyn Tty, client_present: bool) -> io::Result<()> {
        let due = match self.transport_retry {
            TransportRetry::Settled => false,
            TransportRetry::Ready => true,
            TransportRetry::NotBefore(at) => client_present || Instant::now() >= at,
        };
        if !due {
            return Ok(());
        }
        self.transport_retry = match self.probe_frames(tty)? {
            FrameProbe::Accepted(transport) => {
                self.transport = transport;
                TransportRetry::Settled
            }
            FrameProbe::Unanswered if !client_present => {
                TransportRetry::NotBefore(Instant::now() + TRANSPORT_RETRY_GAP)
            }
            FrameProbe::Unanswered | FrameProbe::Refused => TransportRetry::Settled,
        };
        Ok(())
    }

    fn probe_frame_file(&mut self, tty: &mut dyn Tty) -> io::Result<Option<bool>> {
        let path = self.frame_path(FRAME_SLOTS, 0);
        if std::fs::write(&path, [0u8, 0, 0, 255]).is_err() {
            return Ok(Some(false));
        }
        let name = path.to_string_lossy().into_owned();
        self.io.out().write_all(&crate::kitty::kitty_query_medium(
            FILE_PROBE_ID,
            &name,
            crate::kitty::Medium::File,
            1,
            1,
            self.wrapper,
        ))?;
        self.io.out().flush()?;
        let reply = ask(tty, FRAME_PROBE_TIMEOUT_MS, true, |buf| {
            parse_probe_reply(buf, b"Gi=300;")
        })?;
        let _ = std::fs::remove_file(&path);
        Ok(reply)
    }

    fn probe_shared_memory(&mut self, tty: &mut dyn Tty) -> io::Result<Option<bool>> {
        let name = self.shm_probe_name();
        if write_shm(&name, &[0, 0, 0, 255]).is_err() {
            return Ok(Some(false));
        }
        self.io.out().write_all(&crate::kitty::kitty_query_medium(
            SHM_PROBE_ID,
            &name,
            crate::kitty::Medium::Shared,
            1,
            1,
            self.wrapper,
        ))?;
        self.io.out().flush()?;
        let reply = ask(tty, FRAME_PROBE_TIMEOUT_MS, true, |buf| {
            parse_probe_reply(buf, b"Gi=299;")
        })?;
        let _ = rustix::shm::unlink(&name);
        Ok(reply)
    }


    fn frame_path(&self, slot: u64, generation: u64) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "terminal-browser-{}-{}-{generation}-{slot}.rgba",
            std::process::id(),
            self.terminal_id
        ))
    }

    fn write_frame_file(&mut self, data: &[u8]) -> io::Result<String> {
        if self
            .frame_files
            .first()
            .is_none_or(|file| file.len != data.len())
        {
            self.frame_files.clear();
            let generation = self.frame_seq;
            for slot in 0..FRAME_SLOTS {
                self.frame_files
                    .push(FrameFile::create(self.frame_path(slot, generation), data.len())?);
            }
        }
        let index = (self.frame_seq % FRAME_SLOTS) as usize;
        self.frame_seq += 1;
        let file = &mut self.frame_files[index];
        file.write(data);
        Ok(file.path.to_string_lossy().into_owned())
    }

    fn connect_herdr(&mut self) {
        self.herdr = self
            .herdr_target
            .as_ref()
            .and_then(|target| crate::herdr::Herdr::open(target, self.terminal_id));
        if let Some(cell) = self.herdr.as_ref().map(crate::herdr::Herdr::cell) {
            self.cell = Some(cell);
            self.cell_change = Some(cell);
        }
    }

    pub fn present_at(&mut self, at: Option<Instant>) {
        self.present_at = at;
    }

    pub fn take_ready_at(&mut self) -> Option<Instant> {
        self.ready_at.take()
    }

    pub fn set_highlight_transmits(&mut self, on: bool) {
        self.highlight_transmits = on;
    }

    pub fn holds_a_frame(&self) -> bool {
        self.patches.holds_a_frame()
    }

    pub fn draws_layers(&self) -> bool {
        self.draws_locally() && self.present == Presenter::Patched && self.patch_medium().is_some()
    }

    pub fn draws_locally(&self) -> bool {
        !self.hosted && self.herdr.is_none() && self.herdr_target.is_none()
    }

    pub fn draw(&mut self, tty: &mut dyn Tty, frame: pixel_raster::PixelFrame<'_>) -> io::Result<usize> {
        let canvas = frame.canvas;
        if self.hosted {
            if tty.host().is_some_and(|host| host.closed) {
                return Ok(0);
            }
            if self.embedded {
                return self.draw_embedded(tty, canvas);
            }
            let herdr = self
                .herdr
                .as_mut()
                .ok_or_else(|| io::Error::other("host frame stream is gone"))?;
            return herdr.present(canvas);
        }
        if self.herdr.is_none()
            && let Some((at, backoff)) = self.herdr_retry
            && Instant::now() >= at
        {
            self.connect_herdr();
            match self.herdr {
                Some(_) => self.herdr_retry = None,
                None => {
                    let backoff = (backoff * 2).min(HERDR_RETRY_MAX);
                    self.herdr_retry = Some((Instant::now() + backoff, backoff));
                }
            }
        }
        if let Some(herdr) = self.herdr.as_mut() {
            match herdr.present(canvas) {
                Ok(written) => return Ok(written),
                Err(err) => {
                    pixel_core::logging::warn(
                        "herdr",
                        format!("{err}, drawing it ourselves until herdr is back"),
                    );
                    self.herdr = None;
                    self.herdr_retry = Some((Instant::now() + HERDR_RETRY_MIN, HERDR_RETRY_MIN));
                    self.last_frame_size = None;
                    self.placeholders = None;
                }
            }
        }
        let mut out = Vec::new();
        let drawn = match self.present {
            Presenter::Full => {
                let pixels = present::straight_pixels(canvas, frame.premultiplied);
                self.draw_full(canvas, &pixels, &[], &mut out)
            }
            Presenter::Patched => self.draw_patched(frame, &mut out),
            Presenter::Animation => self.draw_animation(frame, &mut out),
        };
        self.write_synchronized(&out)?;
        drawn
    }

    fn cell(&self) -> (u32, u32) {
        let (cw, ch) = self.cell.unwrap_or(DEFAULT_CELL);
        (cw.max(1), ch.max(1))
    }

    fn draw_embedded(&mut self, tty: &mut dyn Tty, canvas: &Canvas) -> io::Result<usize> {
        if self.transport == FrameTransport::Host {
            return self.hand_frame_to_host(tty, canvas);
        }
        let shrank = self
            .last_frame_size
            .is_some_and(|(w, h)| canvas.width < w || canvas.height < h);
        self.last_frame_size = Some((canvas.width, canvas.height));
        let (cols, rows) = self.grid_for(canvas);
        let placement = Placement::Cells { cols, rows };
        let grid_changed = self.placed_grid.is_some_and(|grid| grid != (cols, rows));
        let mut frame = Vec::new();
        if shrank || grid_changed {
            frame.extend_from_slice(&crate::kitty::kitty_delete_one(self.image_id));
        }
        let transmit = self.transmit(canvas, placement);
        match self.hand_off_frame(&canvas.pixels)? {
            Some((medium, name)) => {
                frame.extend_from_slice(&crate::kitty::kitty_transmit_named(transmit, &name, medium, Wrapper::None));
            }
            None => frame.extend_from_slice(&crate::kitty::kitty_transmit_placed(transmit, &canvas.pixels, Wrapper::None)),
        }
        self.write_frame_gated(&frame)?;
        self.placed_grid = Some((cols, rows));
        if self.placeholders != Some((cols, rows)) {
            self.placeholders = Some((cols, rows));
            tty.host_send(crate::host::placed(self.image_id, cols, rows, self.cell))?;
        }
        Ok(frame.len())
    }

    fn hand_frame_to_host(&mut self, tty: &mut dyn Tty, canvas: &Canvas) -> io::Result<usize> {
        let (cols, rows) = self.grid_for(canvas);
        let generation = self.frame_seq;
        self.frame_seq += 1;
        let shm = self.hand_off_shm(&canvas.pixels)?;
        tty.host_send(crate::host::frame(crate::host::HostFrame {
            shm: &shm,
            width: canvas.width,
            height: canvas.height,
            generation,
            cols,
            rows,
            cell: self.cell,
        }))?;
        Ok(canvas.pixels.len())
    }

   
    fn wait_for_quiet_tty(&self) -> Option<()> {
        let config = gate_config();
        let mut unread = unread_output_of(&self.io)?;
        let start = Instant::now();
        let mut quiet_since: Option<Instant> = None;
        loop {
            let now = Instant::now();
            if unread == 0 {
                match quiet_since {
                    None => quiet_since = Some(now),
                    Some(since) if now.duration_since(since) >= config.quiet => return Some(()),
                    Some(_) => {}
                }
            } else {
                quiet_since = None;
            }
            if now.duration_since(start) >= config.timeout {
                return Some(());
            }
            std::thread::sleep(EMBED_GATE_TICK);
            unread = unread_output_of(&self.io)?;
        }
    }

    fn write_frame_gated(&mut self, frame: &[u8]) -> io::Result<()> {
        if self.wait_for_quiet_tty().is_none() {
            self.io.out().write_all(frame)?;
            return self.io.out().flush();
        }
        let start = Instant::now();
        loop {
            if unread_output_of(&self.io).is_some_and(|n| n > 0) {
            } else {
                match self.io.out().write(frame) {
                    Ok(n) if n == frame.len() => break,
                    Ok(n) => {
                        pixel_core::logging::warn("embed", "the tty queue filled mid-write; a frame may have torn");
                        self.write_rest_soon(&frame[n..])?;
                        break;
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e),
                }
            }
            if start.elapsed() >= gate_config().timeout {
                pixel_core::logging::warn("embed", "the tty never went quiet; wrote into a busy tty, a frame may have torn");
                self.write_rest_soon(frame)?;
                break;
            }
            if self.wait_for_quiet_tty().is_none() {
                break;
            }
        }
        self.io.out().flush()
    }

    fn write_rest_soon(&mut self, mut rest: &[u8]) -> io::Result<()> {
        while !rest.is_empty() {
            match self.io.out().write(rest) {
                Ok(n) => rest = &rest[n..],
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_micros(50)),
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    fn grid_for(&self, canvas: &Canvas) -> (u32, u32) {
        let (cw, ch) = self
            .cell
            .or_else(|| self.screen.and_then(|screen| screen.cell))
            .unwrap_or(DEFAULT_CELL);
        (
            canvas.width.div_ceil(cw).max(1),
            canvas.height.div_ceil(ch).max(1),
        )
    }

    pub fn frames_are_inline(&self) -> bool {
        self.transport == FrameTransport::Inline
    }
}

const SHM_PROBE_ID: u32 = 299;
const FILE_PROBE_ID: u32 = 300;
const FRAME_PROBE_TIMEOUT_MS: u64 = 300;
const TRANSPORT_RETRY_GAP: Duration = Duration::from_secs(1);

const FRAME_SLOTS: u64 = 8;
pub const DEFAULT_CELL: (u32, u32) = (16, 34);

const EMBED_GATE_TICK: Duration = Duration::from_micros(20);

struct GateConfig {
    quiet: Duration,
    timeout: Duration,
}

fn gate_config() -> &'static GateConfig {
    static CONFIG: std::sync::OnceLock<GateConfig> = std::sync::OnceLock::new();
    CONFIG.get_or_init(|| {
        let millis = |name: &str, default: u64| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .map_or(Duration::from_millis(default), Duration::from_millis)
        };
        GateConfig {
            quiet: millis("EMBED_GATE_QUIET_MS", 20),
            timeout: millis("EMBED_GATE_TIMEOUT_MS", 400),
        }
    })
}

#[allow(unsafe_code)]
fn unread_output_of(output: &Output) -> Option<usize> {
    use rustix::fd::AsRawFd as _;
    let fd = output.tty.as_ref()?.as_raw_fd();
    let mut count: libc::c_int = 0;
    // SAFETY: TIOCOUTQ stores one c_int through the pointer; the fd is open and ours.
    let rc = unsafe { libc::ioctl(fd, libc::TIOCOUTQ, &mut count) };
    (rc == 0).then(|| count.max(0) as usize)
}

const HERDR_RETRY_MIN: Duration = Duration::from_secs(1);
const HERDR_RETRY_MAX: Duration = Duration::from_secs(10);


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameTransport {
    File,
    Shared,
    Inline,
    Host,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameProbe {
    Accepted(FrameTransport),
    Refused,
    Unanswered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransportRetry {
    Settled,
    Ready,
    NotBefore(Instant),
}

static NEXT_TERMINAL_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);


fn frame_image_id(relayed: bool) -> u32 {
    if !relayed {
        return 1;
    }
    match std::process::id() & 0xff_ffff {
        0 | SHM_PROBE_ID => SHM_PROBE_ID + 1,
        id => id,
    }
}



// tmux with extended-keys on re-encodes the reply's closing ESC \ as an alt+\ key
const PROBE_REPLY_ENDS: [&[u8]; 3] = [b"\x1b\\", b"\x1b[27;3;92~", b"\x1b[92;3u"];

fn parse_probe_reply(buf: &[u8], needle: &[u8]) -> Option<(bool, std::ops::Range<usize>)> {
    let at = buf.windows(needle.len()).position(|w| w == needle)?;
    let start = buf[..at].iter().rposition(|&b| b == 0x1b)?;
    let body = &buf[at + needle.len()..];
    let end = PROBE_REPLY_ENDS
        .iter()
        .filter_map(|close| {
            let pos = body.windows(close.len()).position(|w| w == *close)?;
            Some(pos + close.len())
        })
        .min()?;
    Some((body.starts_with(b"OK"), start..at + needle.len() + end))
}

#[allow(unsafe_code)]
pub(crate) struct FrameFile {
    path: std::path::PathBuf,
    map: std::ptr::NonNull<u8>,
    len: usize,
}

// SAFETY: the mapping is owned by this value alone, so moving it to another thread is fine.
#[allow(unsafe_code)]
unsafe impl Send for FrameFile {}

#[allow(unsafe_code, clippy::undocumented_unsafe_blocks)]
impl FrameFile {
    pub(crate) fn create(path: std::path::PathBuf, len: usize) -> io::Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::remove_file(&path);
        let file = std::fs::File::options()
            .mode(0o600)
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        rustix::fs::ftruncate(&file, len as u64)?;
        let map = unsafe {
            rustix::mm::mmap(
                std::ptr::null_mut(),
                len,
                rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE,
                rustix::mm::MapFlags::SHARED,
                &file,
                0,
            )?
        };
        let map = std::ptr::NonNull::new(map.cast::<u8>())
            .ok_or_else(|| io::Error::other("frame file mapped to nothing"))?;
        unsafe { std::ptr::write_bytes(map.as_ptr(), 0, len) };
        Ok(Self { path, map, len })
    }

    pub(crate) fn write(&mut self, data: &[u8]) {
        unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), self.map.as_ptr(), self.len) };
    }

    pub(crate) fn write_bgra(&mut self, data: &[u8]) {
        use rayon::prelude::*;
        let len = self.len.min(data.len());
        let target = unsafe { std::slice::from_raw_parts_mut(self.map.as_ptr(), len) };
        target
            .par_chunks_mut(1 << 16)
            .zip(data[..len].par_chunks(1 << 16))
            .for_each(|(target, source)| {
                for (t, s) in target.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
                    t[0] = s[2];
                    t[1] = s[1];
                    t[2] = s[0];
                    t[3] = s[3];
                }
            });
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[allow(unsafe_code, clippy::undocumented_unsafe_blocks)]
impl Drop for FrameFile {
    fn drop(&mut self) {
        unsafe {
            let _ = rustix::mm::munmap(self.map.as_ptr().cast(), self.len);
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) fn write_shm(name: &str, data: &[u8]) -> io::Result<()> {
    let fd = open_shm(name, data.len())?;
    fill_shm(&fd, data.len(), |out| out.copy_from_slice(data))
}


fn open_shm(name: &str, len: usize) -> io::Result<rustix::fd::OwnedFd> {
    let fd = rustix::shm::open(
        name,
        rustix::shm::OFlags::CREATE | rustix::shm::OFlags::EXCL | rustix::shm::OFlags::RDWR,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )?;
    rustix::fs::ftruncate(&fd, len as u64)?;
    Ok(fd)
}

#[allow(unsafe_code)]
fn fill_shm(fd: &rustix::fd::OwnedFd, len: usize, fill: impl FnOnce(&mut [u8])) -> io::Result<()> {
    unsafe {
        let ptr = rustix::mm::mmap(
            std::ptr::null_mut(),
            len,
            rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE,
            rustix::mm::MapFlags::SHARED,
            fd,
            0,
        )?;
        fill(std::slice::from_raw_parts_mut(ptr.cast::<u8>(), len));
        rustix::mm::munmap(ptr, len)?;
    }
    Ok(())
}

fn nearest_shape_ghostty_macos_draws(shape: &str) -> &str {
    match shape {
        "nw-resize" | "ne-resize" => "n-resize",
        "sw-resize" | "se-resize" => "s-resize",
        "nwse-resize" | "nesw-resize" => "ns-resize",
        _ => shape,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_replies_span_only_the_reply() {
        for reply in [
            b"\x1b_Gi=299;OK\x1b\\".as_slice(),
            b"\x1b[27;3;95~Gi=299;OK\x1b[27;3;92~".as_slice(),
            b"\x1b[95;3uGi=299;OK\x1b[92;3u".as_slice(),
        ] {
            for end in 0..reply.len() {
                assert!(parse_probe_reply(&reply[..end], b"Gi=299;").is_none());
            }
            let mut input = [b"before".as_slice(), reply, b"after"].concat();
            let (answer, range) = parse_probe_reply(&input, b"Gi=299;").unwrap();
            assert!(answer);
            input.drain(range);
            assert_eq!(input, b"beforeafter");
        }
    }

    #[test]
    fn parses_probe_replies() {
        let parse = |buf: &[u8]| parse_probe_reply(buf, b"Gi=299;").map(|(answer, _)| answer);
        assert_eq!(parse(b"\x1b_Gi=299;OK\x1b\\"), Some(true));
        assert_eq!(
            parse(b"noise\x1b_Gi=299;ENOENT:not found\x1b\\"),
            Some(false)
        );
        assert_eq!(parse(b"\x1b_Gi=299;O"), None, "partial");
        assert_eq!(parse(b"\x1b[?1016;1$y"), None);
        assert_eq!(
            parse(b"\x1b[27;3;95~Gi=299;OK\x1b[27;3;92~"),
            Some(true),
            "reply re-encoded by tmux extended-keys"
        );
    }

    #[test]
    fn a_frame_file_is_rewritten_in_place_and_removed_on_drop() {
        let path = std::env::temp_dir().join(format!("tb-frametest-{}.rgba", std::process::id()));
        let first: Vec<u8> = (0..4096).map(|i| (i % 251) as u8).collect();
        let second: Vec<u8> = (0..4096).map(|i| (i % 97) as u8).collect();

        let mut file = FrameFile::create(path.clone(), first.len()).unwrap();
        file.write(&first);
        assert_eq!(std::fs::read(&path).unwrap(), first);

        // the same mapping serves every frame, which is the whole point of using a file
        file.write(&second);
        assert_eq!(std::fs::read(&path).unwrap(), second);

        drop(file);
        assert!(!path.exists(), "the frame file outlived the terminal");
    }

    #[test]
    fn diagonal_resize_shapes_fall_back_to_vertical_for_ghostty_macos() {
        assert_eq!(nearest_shape_ghostty_macos_draws("se-resize"), "s-resize");
        assert_eq!(nearest_shape_ghostty_macos_draws("nw-resize"), "n-resize");
        assert_eq!(nearest_shape_ghostty_macos_draws("nwse-resize"), "ns-resize");
        assert_eq!(nearest_shape_ghostty_macos_draws("nesw-resize"), "ns-resize");
        assert_eq!(nearest_shape_ghostty_macos_draws("ew-resize"), "ew-resize");
        assert_eq!(nearest_shape_ghostty_macos_draws("pointer"), "pointer");
    }
}

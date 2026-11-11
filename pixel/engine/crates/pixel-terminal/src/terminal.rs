use std::io;
use std::time::{Duration, Instant};

use rustix::termios::{self, OptionalActions, Termios};

pub use pixel_core::backend::HostColors;
pub use pixel_core::{Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind};
pub(crate) use pixel_kitty::DEFAULT_CELL;
use pixel_kitty::{HerdrTarget, Wrapper};

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    HostClosed,
    Handoff(Handoff),
    Wheel {
        x: u32,
        y: u32,
        delta_x: f32,
        delta_y: f32,
        mods: Mods,
    },
    Key(KeyEvent),
    Mouse(Mouse),
    Paste(String),
    Focus(bool),
    Visible(bool),
    WindowSize(WindowSize),
    CellSize((u32, u32)),
    ClipboardData {
        items: Vec<(String, Vec<u8>)>,
        ok: bool,
    },
    ColorSchemeChanged,
    Colors(HostColors),
    Devtools,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Handoff {
    Adopt { tty: String },
    Rejoin { socket: String },
}

#[derive(Debug, Clone)]
pub enum Retarget {
    Tty {
        path: String,
        wrapper: Wrapper,
    },
    Host {
        socket: String,
        pane: String,
        name: String,
    },
}

fn set_color(colors: &mut HostColors, slot: ColorSlot, rgba: [u8; 4]) {
    match slot {
        ColorSlot::Foreground => colors.foreground = Some(rgba),
        ColorSlot::Background => colors.background = Some(rgba),
        ColorSlot::Palette(i) => colors.palette[i as usize] = Some(rgba),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorSlot {
    Foreground,
    Background,
    Palette(u8),
}

const COLOR_SLOT_COUNT: usize = 18;
const COLOR_QUERY_TIMEOUT: Duration = Duration::from_millis(1200);
const COLOR_QUERY_IDLE: Duration = Duration::from_millis(250);

struct ColorQuery {
    colors: HostColors,
    received: usize,
    started: Instant,
    last_reply: Option<Instant>,
}

impl ColorQuery {
    fn new() -> Self {
        Self {
            colors: HostColors::default(),
            received: 0,
            started: Instant::now(),
            last_reply: None,
        }
    }

    fn deadline(&self) -> Instant {
        match self.last_reply {
            Some(at) => (at + COLOR_QUERY_IDLE).min(self.started + COLOR_QUERY_TIMEOUT),
            None => self.started + COLOR_QUERY_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowSize {
    pub cols: u32,
    pub rows: u32,
    pub width_px: u32,
    pub height_px: u32,
}

impl WindowSize {
    // fixme: why is this an option? if this is not an invariant, we should define the terminals this is the case for
    pub fn cell_size(&self) -> Option<(u32, u32)> {
        if self.cols > 0 && self.rows > 0 && self.width_px > 0 && self.height_px > 0 {
            Some((self.width_px / self.cols, self.height_px / self.rows))
        } else {
            None
        }
    }
}

fn retry_intr<T>(mut call: impl FnMut() -> rustix::io::Result<T>) -> rustix::io::Result<T> {
    loop {
        match call() {
            Err(rustix::io::Errno::INTR) => continue,
            other => return other,
        }
    }
}

enum TtyHandle {
    Stdio {
        stdin: io::Stdin,
        stdout: io::Stdout,
    },
    File(std::fs::File),
    Hosted {
        stream: std::os::unix::net::UnixStream,
        sink: io::Sink,
    },
    Embedded {
        stream: std::os::unix::net::UnixStream,
        tty: std::fs::File,
    },
}

impl TtyHandle {
    fn read_fd(&self) -> rustix::fd::BorrowedFd<'_> {
        use rustix::fd::AsFd as _;
        match self {
            TtyHandle::Stdio { stdin, .. } => stdin.as_fd(),
            TtyHandle::File(file) => file.as_fd(),
            TtyHandle::Hosted { stream, .. } => stream.as_fd(),
            TtyHandle::Embedded { stream, .. } => stream.as_fd(),
        }
    }

    fn out(&mut self) -> &mut dyn io::Write {
        match self {
            TtyHandle::Stdio { stdout, .. } => stdout,
            TtyHandle::File(file) => file,
            TtyHandle::Hosted { sink, .. } => sink,
            TtyHandle::Embedded { tty, .. } => tty,
        }
    }
}

pub struct Terminal {
    io: TtyHandle,
    saved: Option<Termios>,
    hosted: Option<crate::hosted::HostState>,
    host_target: Option<HerdrTarget>,
    pointer_shape_written: bool,
    mouse_pixels: bool,
    mouse_pixels_pending: bool,
    focused: bool,
    cell: Option<(u32, u32)>,
    pending: Vec<u8>,
    lone_escape_since: Option<Instant>,
    relay_cell: Option<(u32, u32)>,
    wrapper: Wrapper,
    wake_rx: Option<rustix::fd::OwnedFd>,
    waker: Option<Waker>,
    resize_slot: Option<usize>,
    // if the terminal supports https://sw.kovidgoyal.net/kitty/clipboard/
    clipboard_data: bool,
    clip_read: Option<ClipRead>,
    // if the terminal tells us when its palette changes (DEC private mode 2031)
    color_scheme_updates: bool,
    color_query: Option<ColorQuery>,
    kitty_keyboard: bool,
    pixel_mouse: bool,
}

#[derive(Default)]
struct ClipRead {
    items: Vec<(String, Vec<u8>)>,
    total: usize,
    overflow: bool,
}

const CLIP_READ_MAX_BYTES: usize = 64 * 1024 * 1024;

const LONE_ESCAPE_WAIT: Duration = Duration::from_millis(50);

const RESIZE_WAKE_SLOTS: usize = 64;
static RESIZE_WAKE_FDS: [std::sync::atomic::AtomicI32; RESIZE_WAKE_SLOTS] =
    [const { std::sync::atomic::AtomicI32::new(-1) }; RESIZE_WAKE_SLOTS];

fn claim_resize_slot(fd: i32) -> Option<usize> {
    for (i, slot) in RESIZE_WAKE_FDS.iter().enumerate() {
        if slot
            .compare_exchange(
                -1,
                fd,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
        {
            return Some(i);
        }
    }
    None
}

#[allow(unsafe_code)]
extern "C" fn sigwinch_handler(_: libc::c_int) {
    for slot in &RESIZE_WAKE_FDS {
        let fd = slot.load(std::sync::atomic::Ordering::Relaxed);
        if fd >= 0 {
            unsafe {
                libc::write(fd, [1u8].as_ptr().cast(), 1);
            }
        }
    }
}

#[derive(Clone)]
pub struct Waker {
    fd: std::sync::Arc<rustix::fd::OwnedFd>,
}

impl Waker {
    pub fn wake(&self) {
        let _ = rustix::io::write(&*self.fd, &[1]);
    }
}

#[derive(Clone, Debug, Default)]
pub struct SessionEnv {
    session: Option<std::collections::HashMap<String, String>>,
}

impl SessionEnv {
    pub fn of_session(env: std::collections::HashMap<String, String>) -> Self {
        Self { session: Some(env) }
    }

    pub fn of_process() -> Self {
        Self { session: None }
    }

    pub fn var(&self, key: &str) -> Option<String> {
        match &self.session {
            Some(env) => env.get(key).cloned(),
            None => std::env::var(key).ok(),
        }
    }
}

impl Terminal {
    pub fn new(wrapper: Wrapper, pixel_mouse: bool) -> io::Result<Self> {
        Self::with_handle(
            TtyHandle::Stdio {
                stdin: io::stdin(),
                stdout: io::stdout(),
            },
            wrapper,
            pixel_mouse,
        )
    }

    pub fn open(tty_path: &str, wrapper: Wrapper, pixel_mouse: bool) -> io::Result<Self> {
        let file = std::fs::File::options().read(true).write(true).open(tty_path)?;
        Self::with_handle(TtyHandle::File(file), wrapper, pixel_mouse)
    }

    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        pixel_core::profiler::span("term.write", || {
            self.io.out().write_all(bytes)?;
            self.io.out().flush()
        })
    }

    pub fn join_host(socket: &str, pane: &str, name: &str) -> io::Result<Self> {
        let crate::hosted::Joined {
            stream,
            state,
            pending,
        } = crate::hosted::join(socket, pane, name)?;
        let io = TtyHandle::Hosted {
            stream,
            sink: io::sink(),
        };
        let mut terminal = Self::blank(io, None, Wrapper::None);
        terminal.host_target = Some(HerdrTarget {
            pane: pane.to_string(),
            socket: socket.to_string(),
        });
        terminal.focused = state.focused;
        terminal.hosted = Some(state);
        terminal.pending = pending;
        terminal.kitty_keyboard = true;
        terminal.mouse_pixels = true;
        terminal.pixel_mouse = true;
        Ok(terminal)
    }

    pub fn is_hosted(&self) -> bool {
        self.hosted.is_some()
    }

    pub fn join_embedded(socket: &str, pane: &str, name: &str, tty_path: &str) -> io::Result<Self> {
        let crate::hosted::Joined {
            stream,
            mut state,
            pending,
        } = crate::hosted::join(socket, pane, name)?;
        let tty = std::fs::File::options().read(true).write(true).open(tty_path)?;
      
        if state.cell.is_none() {
            state.cell = cell_size_of_tty(&tty).or_else(|| {
                pixel_core::logging::warn("embed", "the terminal reports no cell size; assuming 16x34");
                Some(DEFAULT_CELL)
            });
        }
        state.fill_pixel_size();
       
        rustix::fs::fcntl_setfl(&tty, rustix::fs::fcntl_getfl(&tty)? | rustix::fs::OFlags::NONBLOCK)?;
        let mut terminal = Self::blank(TtyHandle::Embedded { stream, tty }, None, Wrapper::None);
        terminal.cell = state.cell;
        terminal.focused = state.focused;
        terminal.hosted = Some(state);
        terminal.pending = pending;
        terminal.kitty_keyboard = true;
        terminal.mouse_pixels = true;
        terminal.pixel_mouse = true;
        Ok(terminal)
    }

    pub fn is_embedded(&self) -> bool {
        matches!(self.io, TtyHandle::Embedded { .. })
    }

    pub fn retarget(&mut self, target: Retarget) -> io::Result<()> {
        let mut fresh = match target {
            Retarget::Tty { path, wrapper } => Terminal::open(&path, wrapper, self.pixel_mouse)
                .map_err(|e| io::Error::new(e.kind(), format!("open {path}: {e}")))?,
            Retarget::Host { socket, pane, name } => Terminal::join_host(&socket, &pane, &name)?,
        };
        fresh.wake_rx = self.wake_rx.take();
        fresh.waker = self.waker.take();
        fresh.resize_slot = self.resize_slot.take();
        *self = fresh;
        Ok(())
    }

    fn with_handle(mut io: TtyHandle, wrapper: Wrapper, pixel_mouse: bool) -> io::Result<Self> {
        let step = |name: &str, error: io::Error| io::Error::new(error.kind(), format!("{name}: {error}"));
        let saved = retry_intr(|| termios::tcgetattr(io.read_fd())).map_err(|e| step("tcgetattr", e.into()))?;
        let mut raw = saved.clone();
        raw.make_raw();
        retry_intr(|| termios::tcsetattr(io.read_fd(), OptionalActions::Drain, &raw)).map_err(|e| step("tcsetattr", e.into()))?;

        // would prefer if they weren't magic and linked to some known doc on the internet
        io.out().write_all(if pixel_mouse {
            b"\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?1016h\x1b[?1004h\x1b[?2004h\x1b[?2048h\x1b[>1u"
        } else {
            b"\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?2048h\x1b[>1u"
        })?; // enable many reporting modes so we get info about mouse/keyboard
        io.out().flush()?;

        let mut terminal = Self::blank(io, Some(saved), wrapper);
        terminal.pixel_mouse = pixel_mouse;
        terminal.kitty_keyboard = terminal.probe_kitty_keyboard()?;
        if !terminal.kitty_keyboard {
            terminal.io.out().write_all(b"\x1b[>4;2m")?;
            terminal.io.out().flush()?;
        }
        let mouse_pixels = if wrapper.relayed() || !pixel_mouse {
            Some(false)
        } else {
            terminal.probe_mouse_pixels()?
        };
        terminal.mouse_pixels = mouse_pixels == Some(true);
        terminal.mouse_pixels_pending = mouse_pixels.is_none();
        if !terminal.mouse_pixels && pixel_mouse {
            terminal.io.out().write_all(b"\x1b[?1016l\x1b[?1006h")?;
            terminal.io.out().flush()?;
        }
        terminal.clipboard_data = !wrapper.relayed() && terminal.probe_clipboard_data()?;
        terminal.color_scheme_updates = terminal.probe_color_scheme()?;
        if terminal.color_scheme_updates {
            terminal.io.out().write_all(b"\x1b[?2031h")?;
            terminal.io.out().flush()?;
        }
        Ok(terminal)
    }

    fn blank(io: TtyHandle, saved: Option<Termios>, wrapper: Wrapper) -> Self {
        Self {
            io,
            saved,
            hosted: None,
            host_target: None,
            pointer_shape_written: false,
            mouse_pixels: false,
            mouse_pixels_pending: false,
            focused: true,
            cell: None,
            pending: Vec::new(),
            lone_escape_since: None,
            relay_cell: None,
            wrapper,
            wake_rx: None,
            waker: None,
            resize_slot: None,
            clipboard_data: false,
            clip_read: None,
            color_scheme_updates: false,
            color_query: None,
            kitty_keyboard: false,
            pixel_mouse: false,
        }
    }

    fn host_send(&mut self, message: serde_json::Value) -> io::Result<()> {
        match &mut self.io {
            TtyHandle::Hosted { stream, .. } | TtyHandle::Embedded { stream, .. } => {
                crate::hosted::send(stream, &message)
            }
            _ => Ok(()),
        }
    }

    pub fn reports_color_scheme(&self) -> bool {
        self.color_scheme_updates || self.hosted.is_some()
    }

    pub fn relayed(&self) -> bool {
        self.wrapper.relayed()
    }

    pub fn kitty_keyboard(&self) -> bool {
        self.kitty_keyboard
    }

    pub fn set_key_event_types(&mut self, enabled: bool) -> io::Result<()> {
        if self.hosted.is_some() {
            return Ok(());
        }
        self.io.out().write_all(b"\x1b[<u")?;
        self.io.out()
            .write_all(if enabled { b"\x1b[>27u" } else { b"\x1b[>1u" })?;
        self.io.out().flush()
    }



    pub fn poll_event(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        if self.hosted.is_some() {
       
            return self.poll_host_event(timeout);
        }
        let deadline = timeout.map(|t| Instant::now() + t);
        loop {
            if let Some((raw, used)) = parse_event_kitty(&self.pending, self.kitty_keyboard) {
                self.pending.drain(..used);
                self.lone_escape_since = None;

                return Ok(Some(match raw {
                    RawEvent::Key(key) => Event::Key(key),
                    RawEvent::Paste(text) => Event::Paste(text),
                    RawEvent::Focus(focused) => {
                        self.focused = focused;
                        Event::Focus(focused)
                    }
                    RawEvent::WindowSize(ws) => Event::WindowSize(ws),
                    RawEvent::CellSize(cell) => {
                        self.cell = Some(cell);
                        Event::CellSize(cell)
                    }
                    RawEvent::MousePixels(pixels) => {
                        if pixels && self.mouse_pixels_pending {
                            self.enable_mouse_pixels()?;
                        }
                        continue;
                    }
                    RawEvent::Mouse(kind, button, mods, x, y) => {
                        if self.mouse_pixels_pending
                            && self.relay_cell.is_none()
                            && self.is_past_cell_grid(x, y)
                        {
                            self.enable_mouse_pixels()?;
                        }
                        let (x, y) = match self.relay_cell {
                            Some(cell) => relay_mouse_position_px(
                                cell,
                                kind,
                                x,
                                y,
                                self.focused,
                                self.mouse_pixels,
                                || self.size().ok(),
                            ),
                            None => self.mouse_position_px(x, y),
                        };
                        Event::Mouse(Mouse {
                            kind,
                            button,
                            mods,
                            x,
                            y,
                        })
                    }
                    RawEvent::Clip(packet) => match self.apply_clip_packet(packet) {
                        Some(event) => event,
                        None => continue,
                    },
                    RawEvent::ColorSchemeChanged => Event::ColorSchemeChanged,
                    RawEvent::Color(slot, rgba) => match self.collect_color(slot, rgba) {
                        Some(colors) => Event::Colors(colors),
                        None => continue,
                    },
                }));
            }
            let escape_deadline = self.lone_escape_deadline();
            let color_deadline = self.color_query.as_ref().map(ColorQuery::deadline);
            let until = [deadline, escape_deadline, color_deadline]
                .into_iter()
                .flatten()
                .min();
            let wait = until.map(|d| d.saturating_duration_since(Instant::now()));
            if !self.wait_for_input(wait)? {
                if escape_deadline.is_some_and(|d| Instant::now() >= d) {
                    self.pending.drain(..1);
                    self.lone_escape_since = None;
                    return Ok(Some(Event::Key(KeyEvent::plain(Key::Escape))));
                }
                if color_deadline.is_some_and(|d| Instant::now() >= d) {
                    match self.take_settled_colors() {
                        Some(colors) => return Ok(Some(Event::Colors(colors))),
                        None => continue,
                    }
                }
                return Ok(None);
            }
            let mut chunk = [0u8; 256];
            let n = match rustix::io::read(self.io.read_fd(), &mut chunk) {
                Ok(n) => n,
                Err(rustix::io::Errno::INTR) => continue,
                Err(e) => return Err(e.into()),
            };
            if n == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            self.pending.extend_from_slice(&chunk[..n]);
        }
    }

    fn poll_host_event(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        let deadline = timeout.map(|t| Instant::now() + t);
        if self.hosted.as_ref().is_some_and(|state| state.closed) {
            self.wait_for_wake(timeout)?;
            return Ok(None);
        }
        loop {
            while let Some(end) = self.pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=end).collect();
                let Some(state) = self.hosted.as_mut() else {
                    return Ok(None);
                };
                if let Some(event) = crate::hosted::parse_line(&line, state) {
                    match event {
                        Event::Focus(focused) => self.focused = focused,
                        Event::WindowSize(_) => {
                            if state.cell.is_some() {
                                self.cell = state.cell;
                            }
                        }
                        _ => {}
                    }
                    return Ok(Some(event));
                }
            }
            let wait = deadline.map(|d| d.saturating_duration_since(Instant::now()));
            if !self.wait_for_input(wait)? {
                return Ok(None);
            }
            let mut chunk = [0u8; 4096];
            let n = match rustix::io::read(self.io.read_fd(), &mut chunk) {
                Ok(n) => n,
                Err(rustix::io::Errno::INTR) => continue,
                Err(e) => return Err(e.into()),
            };
            if n == 0 {
                if let Some(state) = self.hosted.as_mut() {
                    state.closed = true;
                }
                self.pending.clear();
                return Ok(Some(Event::HostClosed));
            }
            self.pending.extend_from_slice(&chunk[..n]);
        }
    }

    fn wait_for_wake(&self, wait: Option<Duration>) -> io::Result<()> {
        let Some(wake) = &self.wake_rx else {
            std::thread::sleep(wait.unwrap_or(Duration::from_millis(50)));
            return Ok(());
        };
        let timeout = match wait {
            Some(w) => Some(
                rustix::event::Timespec::try_from(w)
                    .map_err(|_| io::Error::other("timeout out of range"))?,
            ),
            None => None,
        };
        let mut fds = [rustix::event::PollFd::new(wake, rustix::event::PollFlags::IN)];
        match rustix::event::poll(&mut fds, timeout.as_ref()) {
            Ok(_) | Err(rustix::io::Errno::INTR) => {}
            Err(e) => return Err(e.into()),
        }
        if fds[0].revents().contains(rustix::event::PollFlags::IN) {
            let mut sink = [0u8; 64];
            while matches!(rustix::io::read(wake, &mut sink), Ok(n) if n > 0) {}
        }
        Ok(())
    }

    fn lone_escape_deadline(&mut self) -> Option<Instant> {
        let bare_escapes = self.wrapper.relayed() || !self.kitty_keyboard;
        if !bare_escapes || self.pending.first() != Some(&0x1b) {
            self.lone_escape_since = None;
            return None;
        }
        Some(*self.lone_escape_since.get_or_insert_with(Instant::now) + LONE_ESCAPE_WAIT)
    }

    pub fn waker(&mut self) -> io::Result<Waker> {
        if let Some(waker) = &self.waker {
            return Ok(waker.clone());
        }
        let (rx, tx) = rustix::pipe::pipe()?;
        rustix::fs::fcntl_setfl(&rx, rustix::fs::OFlags::NONBLOCK)?;
        rustix::fs::fcntl_setfl(&tx, rustix::fs::OFlags::NONBLOCK)?;
        self.wake_rx = Some(rx);
        let waker = Waker {
            fd: std::sync::Arc::new(tx),
        };
        self.waker = Some(waker.clone());
        Ok(waker)
    }

    #[allow(unsafe_code)]
    pub fn watch_resize(&mut self) -> io::Result<()> {
        use rustix::fd::AsRawFd as _;
        let waker = self.waker()?;
        self.resize_slot = claim_resize_slot(waker.fd.as_raw_fd());
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = sigwinch_handler as *const () as usize;
            action.sa_flags = libc::SA_RESTART;
            if libc::sigaction(libc::SIGWINCH, &action, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    fn wait_for_input(&self, wait: Option<Duration>) -> io::Result<bool> {
        let timeout = match wait {
            Some(w) => Some(
                rustix::event::Timespec::try_from(w)
                    .map_err(|_| io::Error::other("timeout out of range"))?,
            ),
            None => None,
        };
        let poll = |fds: &mut [rustix::event::PollFd<'_>]| match rustix::event::poll(
            fds,
            timeout.as_ref(),
        ) {
            Ok(n) => Ok(n),
            Err(rustix::io::Errno::INTR) => Ok(0),
            Err(e) => Err(io::Error::from(e)),
        };
        let stdin_borrow = self.io.read_fd();
        let stdin_fd = rustix::event::PollFd::new(&stdin_borrow, rustix::event::PollFlags::IN);
        match &self.wake_rx {
            None => {
                let mut fds = [stdin_fd];
                Ok(poll(&mut fds)? > 0)
            }
            Some(wake) => {
                let mut fds = [
                    stdin_fd,
                    rustix::event::PollFd::new(wake, rustix::event::PollFlags::IN),
                ];
                poll(&mut fds)?;
                if fds[1].revents().contains(rustix::event::PollFlags::IN) {
                    let mut sink = [0u8; 64];
                    while matches!(rustix::io::read(wake, &mut sink), Ok(n) if n > 0) {}
                }
                Ok(fds[0].revents().contains(rustix::event::PollFlags::IN))
            }
        }
    }

    fn enable_mouse_pixels(&mut self) -> io::Result<()> {
        self.mouse_pixels_pending = false;
        self.mouse_pixels = true;
        self.io.out().write_all(b"\x1b[?1016h")?;
        self.io.out().flush()
    }

    fn is_past_cell_grid(&self, x: u32, y: u32) -> bool {
        self.size()
            .is_ok_and(|ws| ws.cols > 0 && ws.rows > 0 && (x > ws.cols || y > ws.rows))
    }

    fn mouse_position_px(&self, x: u32, y: u32) -> (u32, u32) {
        if self.mouse_pixels {
            (x.saturating_sub(1), y.saturating_sub(1))
        } else {
            let (cw, ch) = self
                .cell
                .or_else(|| self.size().ok().and_then(|ws| ws.cell_size()))
                .unwrap_or(DEFAULT_CELL);
            ((x - 1) * cw + cw / 2, (y - 1) * ch + ch / 2)
        }
    }

    pub fn size(&self) -> io::Result<WindowSize> {
        if let Some(state) = &self.hosted {
            return Ok(state.size);
        }
        let ws = retry_intr(|| termios::tcgetwinsize(self.io.read_fd()))?;
        Ok(WindowSize {
            cols: u32::from(ws.ws_col),
            rows: u32::from(ws.ws_row),
            width_px: u32::from(ws.ws_xpixel),
            height_px: u32::from(ws.ws_ypixel),
        })
    }

    pub fn reports_pixel_mouse(&self) -> bool {
        self.mouse_pixels
    }


    pub fn set_cell_size(&mut self, cell: (u32, u32)) {
        self.cell = Some(cell);
    }

    pub fn cell_size(&mut self) -> io::Result<Option<(u32, u32)>> {
        if self.cell.is_some() {
            return Ok(self.cell);
        }
        if let Some(cell) = self.ask_cell_size()? {
            self.cell = Some(cell);
            return Ok(self.cell);
        }
        if self.hosted.is_none() && !self.wrapper.relayed() {
            self.cell = self.read_report(300, parse_cell_size_report)?;
        }
        if self.cell.is_none() {
            self.cell = self.size()?.cell_size();
        }
        Ok(self.cell)
    }


    pub fn ask_cell_size(&mut self) -> io::Result<Option<(u32, u32)>> {
        if let Some(state) = &self.hosted {
            return Ok(state.cell.or_else(|| state.size.cell_size()));
        }
        self.io.out().write_all(&self.wrapper.wrap(b"\x1b[16t"))?;
        self.io.out().flush()?;
        Ok(None)
    }

    pub fn query_colors(&mut self) -> io::Result<HostColors> {
        if let Some(state) = &self.hosted {
            return Ok(state.colors);
        }
        let query = Self::color_queries();
        self.io.out().write_all(&query)?;
        self.io.out().flush()?;

        let deadline = Instant::now() + Duration::from_millis(300);
        let mut buf = Vec::new();
        loop {
            let replies = buf.windows(4).filter(|w| w == b"rgb:").count();
            if replies >= 18 {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = if replies > 0 {
                remaining.min(Duration::from_millis(60))
            } else {
                remaining
            };
            if wait.is_zero() || buf.len() > 4096 {
                break;
            }
            if !self.wait_for_input(Some(wait))? {
                break;
            }
            let mut chunk = [0u8; 256];
            let n = match rustix::io::read(self.io.read_fd(), &mut chunk) {
                Ok(n) => n,
                Err(rustix::io::Errno::INTR) => continue,
                Err(e) => return Err(e.into()),
            };
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }

        let mut colors = HostColors {
            foreground: parse_osc_color(&buf, "10;"),
            background: parse_osc_color(&buf, "11;"),
            ..HostColors::default()
        };
        for (i, slot) in colors.palette.iter_mut().enumerate() {
            *slot = parse_osc_color(&buf, &format!("4;{i};"));
        }
        Ok(colors)
    }

    fn probe_kitty_keyboard(&mut self) -> io::Result<bool> {
        self.io.out().write_all(b"\x1b[?u")?;
        self.io.out().flush()?;
        Ok(self.read_report(150, parse_kitty_keyboard)?.unwrap_or(false))
    }

    fn probe_mouse_pixels(&mut self) -> io::Result<Option<bool>> {
        self.io.out().write_all(b"\x1b[?1016$p")?;
        self.io.out().flush()?;
        self.read_report(150, parse_decrqm_1016)
    }

    fn probe_clipboard_data(&mut self) -> io::Result<bool> {
        self.io.out().write_all(b"\x1b[?5522$p")?;
        self.io.out().flush()?;
        Ok(self.read_report(150, parse_decrqm_5522)?.unwrap_or(false))
    }

    fn probe_color_scheme(&mut self) -> io::Result<bool> {
        self.io.out().write_all(b"\x1b[?2031$p")?;
        self.io.out().flush()?;
        Ok(self.read_report(150, parse_decrqm_2031)?.unwrap_or(false))
    }

    fn color_queries() -> Vec<u8> {
        let mut query = b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\".to_vec();
        for i in 0..16 {
            query.extend_from_slice(format!("\x1b]4;{i};?\x1b\\").as_bytes());
        }
        query
    }

    pub fn request_colors(&mut self) -> io::Result<()> {
        if self.hosted.is_some() {
            return Ok(());
        }
        let query = Self::color_queries();
        self.io.out().write_all(&query)?;
        self.io.out().flush()?;
        self.color_query = Some(ColorQuery::new());
        Ok(())
    }

    fn take_settled_colors(&mut self) -> Option<HostColors> {
        let query = self.color_query.take()?;
        (query.received > 0).then_some(query.colors)
    }

    fn collect_color(&mut self, slot: ColorSlot, rgba: [u8; 4]) -> Option<HostColors> {
        let query = self.color_query.as_mut()?;
        set_color(&mut query.colors, slot, rgba);
        query.received += 1;
        query.last_reply = Some(Instant::now());
        if query.received < COLOR_SLOT_COUNT {
            return None;
        }
        self.take_settled_colors()
    }

    fn read_report<T>(
        &mut self,
        timeout_ms: u64,
        mut parse: impl FnMut(&[u8]) -> Option<T>,
    ) -> io::Result<Option<T>> {
        let start = self.pending.len();
        let report = self.read_report_keeping_input(timeout_ms, |buf| {
            parse(buf).map(|value| (value, 0..buf.len()))
        })?;
        self.pending.truncate(start);
        Ok(report)
    }

    fn read_report_keeping_input<T>(
        &mut self,
        timeout_ms: u64,
        mut find: impl FnMut(&[u8]) -> Option<(T, std::ops::Range<usize>)>,
    ) -> io::Result<Option<T>> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let start = self.pending.len();
        loop {
            if let Some((value, report)) = find(&self.pending[start..]) {
                self.pending.drain(start + report.start..start + report.end);
                return Ok(Some(value));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || self.pending.len() - start > 4096 {
                return Ok(None);
            }
            if !self.wait_for_input(Some(remaining))? {
                continue;
            }
            let mut chunk = [0u8; 64];
            let n = match rustix::io::read(self.io.read_fd(), &mut chunk) {
                Ok(n) => n,
                Err(rustix::io::Errno::INTR) => continue,
                Err(e) => return Err(e.into()),
            };
            if n == 0 {
                return Ok(None);
            }
            self.pending.extend_from_slice(&chunk[..n]);
            if self.mouse_pixels_pending && parse_decrqm_1016(&self.pending[start..]) == Some(true) {
                self.enable_mouse_pixels()?;
            }
        }
    }

    pub fn set_pointer_shape(&mut self, shape: &str, drawn: &str) -> io::Result<()> {
        if !shape.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
            return Ok(());
        }
        if self.hosted.is_some() {
            self.host_send(crate::hosted::pointer(shape))?;
            if !self.is_embedded() {
                return Ok(());
            }
        }
        self.pointer_shape_written = true;
        self.io.out()
            .write_all(format!("\x1b]22;{drawn}\x1b\\").as_bytes())?;
        self.io.out().flush()
    }

    fn restore_pointer_shape(&mut self) {
        if self.pointer_shape_written {
            let _ = self.io.out().write_all(b"\x1b]22;text\x1b\\");
        }
    }

    pub fn set_title(&mut self, text: &str) -> io::Result<()> {
        if self.hosted.is_some() {
            return self.host_send(crate::hosted::title(text));
        }
        let text: String = text.chars().filter(|c| !c.is_control()).collect();
        self.io.out()
            .write_all(format!("\x1b]2;{text}\x1b\\").as_bytes())?;
        self.io.out().flush()
    }

    pub fn set_clipboard(&mut self, text: &str) -> io::Result<()> {
        if self.hosted.is_some() {
            return self.host_send(crate::hosted::clipboard(text));
        }
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode(text);
        self.io.out()
            .write_all(format!("\x1b]52;c;{payload}\x1b\\").as_bytes())?;
        self.io.out().flush()
    }

    // this will trigger a prompt or just not work
    pub fn request_clipboard(&mut self) -> io::Result<()> {
        if self.hosted.is_some() {
            return Ok(());
        }
        self.io.out().write_all(b"\x1b]52;c;?\x1b\\")?;
        self.io.out().flush()
    }

    pub fn clipboard_data_supported(&self) -> bool {
        self.clipboard_data
    }

    pub fn request_clipboard_types(&mut self) -> io::Result<()> {
        self.request_clipboard_mimes(".")
    }

    pub fn request_clipboard_data(&mut self, mime: &str) -> io::Result<()> {
        self.request_clipboard_mimes(mime)
    }

    fn request_clipboard_mimes(&mut self, mimes: &str) -> io::Result<()> {
        if self.hosted.is_some() {
            return Ok(());
        }
        use base64::Engine as _;
        self.clip_read = None;
        let payload = base64::engine::general_purpose::STANDARD.encode(mimes);
        self.io.out()
            .write_all(format!("\x1b]5522;type=read;{payload}\x1b\\").as_bytes())?;
        self.io.out().flush()
    }

    fn apply_clip_packet(&mut self, packet: ClipPacket) -> Option<Event> {
        match packet.status {
            ClipStatus::Ok => {
                self.clip_read = Some(ClipRead::default());
                None
            }
            ClipStatus::Data => {
                let read = self.clip_read.get_or_insert_with(ClipRead::default);
                if read.total + packet.payload.len() > CLIP_READ_MAX_BYTES {
                    read.overflow = true;
                    return None;
                }
                read.total += packet.payload.len();
                let mime = packet.mime.unwrap_or_default();
                match read.items.last_mut() {
                    Some((last, data)) if *last == mime => data.extend_from_slice(&packet.payload),
                    _ => read.items.push((mime, packet.payload)),
                }
                None
            }
            ClipStatus::Done => {
                let read = self.clip_read.take().unwrap_or_default();
                Some(Event::ClipboardData {
                    items: read.items,
                    ok: !read.overflow,
                })
            }
            ClipStatus::Error => {
                self.clip_read = None;
                Some(Event::ClipboardData {
                    items: Vec::new(),
                    ok: false,
                })
            }
        }
    }
}





fn cell_size_of_tty(tty: &std::fs::File) -> Option<(u32, u32)> {
    let ws = termios::tcgetwinsize(tty).ok()?;
    WindowSize {
        cols: u32::from(ws.ws_col),
        rows: u32::from(ws.ws_row),
        width_px: u32::from(ws.ws_xpixel),
        height_px: u32::from(ws.ws_ypixel),
    }
    .cell_size()
}



impl Terminal {
    pub fn set_relay_cell(&mut self, cell: Option<(u32, u32)>) {
        self.relay_cell = cell;
    }
}

impl pixel_kitty::Vars for SessionEnv {
    fn var(&self, key: &str) -> Option<String> {
        SessionEnv::var(self, key)
    }
}

impl pixel_kitty::Tty for Terminal {
    fn output(&self) -> io::Result<pixel_kitty::Output> {
        let tty = |file: &std::fs::File| -> io::Result<pixel_kitty::Output> {
            Ok(pixel_kitty::Output::new(Box::new(file.try_clone()?), Some(file.try_clone()?)))
        };
        match &self.io {
            TtyHandle::Stdio { .. } => {
                let stdout = std::fs::File::from(rustix::io::dup(io::stdout())?);
                Ok(pixel_kitty::Output::new(Box::new(stdout), None))
            }
            TtyHandle::File(file) => tty(file),
            TtyHandle::Hosted { .. } => Ok(pixel_kitty::Output::new(Box::new(io::sink()), None)),
            TtyHandle::Embedded { tty: file, .. } => tty(file),
        }
    }

    fn read_reply(
        &mut self,
        timeout_ms: u64,
        keep_input: bool,
        find: &mut dyn FnMut(&[u8]) -> Option<std::ops::Range<usize>>,
    ) -> io::Result<bool> {
        let found = if keep_input {
            self.read_report_keeping_input(timeout_ms, |buf| find(buf).map(|range| ((), range)))?
        } else {
            self.read_report(timeout_ms, |buf| find(buf).map(|_| ()))?
        };
        Ok(found.is_some())
    }

    fn host_send(&mut self, message: serde_json::Value) -> io::Result<()> {
        Terminal::host_send(self, message)
    }

    fn host(&self) -> Option<pixel_kitty::Host> {
        let state = self.hosted.as_ref()?;
        Some(pixel_kitty::Host {
            embedded: self.is_embedded(),
            closed: state.closed,
            transport: state.transport.clone(),
            image_id: state.image_id,
            target: self.host_target.clone(),
        })
    }

    fn wrapper(&self) -> Wrapper {
        self.wrapper
    }

    fn cell(&self) -> Option<(u32, u32)> {
        self.cell
    }

    fn screen(&self) -> Option<pixel_kitty::Screen> {
        let ws = self.size().ok()?;
        Some(pixel_kitty::Screen { cols: ws.cols, rows: ws.rows, cell: ws.cell_size() })
    }
}

fn relay_mouse_position_px(
    cell: (u32, u32),
    kind: MouseKind,
    x: u32,
    y: u32,
    focused: bool,
    pixel_mouse: bool,
    grid: impl FnOnce() -> Option<WindowSize>,
) -> (u32, u32) {
    let (cell_w, cell_h) = cell;
    let cell_center =
        |x: u32, y: u32| ((x - 1) * cell_w + cell_w / 2, (y - 1) * cell_h + cell_h / 2);
    if !pixel_mouse {
        return cell_center(x, y);
    }
    if !focused && is_wheel(kind) && grid().is_some_and(|ws| within_grid(&ws, x, y)) {
        return cell_center(x, y);
    }
    (x.saturating_sub(1), y.saturating_sub(1))
}

fn is_wheel(kind: MouseKind) -> bool {
    matches!(
        kind,
        MouseKind::ScrollUp
            | MouseKind::ScrollDown
            | MouseKind::ScrollLeft
            | MouseKind::ScrollRight
    )
}

fn within_grid(ws: &WindowSize, x: u32, y: u32) -> bool {
    x >= 1 && y >= 1 && x <= ws.cols && y <= ws.rows
}

impl Drop for Terminal {
    fn drop(&mut self) {
        if let Some(slot) = self.resize_slot.take() {
            RESIZE_WAKE_FDS[slot].store(-1, std::sync::atomic::Ordering::Release);
        }
        if self.is_embedded() {
            self.restore_pointer_shape();
            let _ = self.io.out().flush();
            return;
        }
        if !self.kitty_keyboard {
            let _ = self.io.out().write_all(b"\x1b[>4;0m");
        }
        if self.color_scheme_updates {
            let _ = self.io.out().write_all(b"\x1b[?2031l");
        }
        self.restore_pointer_shape();
        let _ = self.io.out().write_all(
            b"\x1b[<u\x1b[?2048l\x1b[?2004l\x1b[?1004l\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l",
        );
        let _ = self.io.out().flush();
        if let Some(saved) = &self.saved {
            let _ = retry_intr(|| {
                termios::tcsetattr(self.io.read_fd(), OptionalActions::Flush, saved)
            });
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RawEvent {
    Key(KeyEvent),
    Mouse(MouseKind, MouseButton, Mods, u32, u32),
    Paste(String),
    Focus(bool),
    WindowSize(WindowSize),
    CellSize((u32, u32)),
    Clip(ClipPacket),
    Color(ColorSlot, [u8; 4]),
    ColorSchemeChanged,
    MousePixels(bool),
}

#[derive(Debug, PartialEq, Eq)]
enum ClipStatus {
    Ok,
    Data,
    Done,
    Error,
}

#[derive(Debug, PartialEq, Eq)]
struct ClipPacket {
    status: ClipStatus,
    mime: Option<String>,
    payload: Vec<u8>,
}

fn decode_b64(payload: &[u8]) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(payload))
        .ok()
}

fn parse_clip_packet(seq: &[u8]) -> Option<ClipPacket> {
    let body = seq.strip_prefix(b"\x1b]5522;")?;
    let end = body
        .iter()
        .position(|&b| b == 0x07 || b == 0x1b)
        .unwrap_or(body.len());
    let body = &body[..end];
    let (meta, payload) = match body.iter().position(|&b| b == b';') {
        Some(semi) => (&body[..semi], &body[semi + 1..]),
        None => (body, &b""[..]),
    };
    let mut status = None;
    let mut mime = None;
    for field in meta.split(|&b| b == b':') {
        let eq = field.iter().position(|&b| b == b'=')?;
        let (key, value) = (&field[..eq], &field[eq + 1..]);
        match key {
            b"status" => {
                status = Some(match value {
                    b"OK" => ClipStatus::Ok,
                    b"DATA" => ClipStatus::Data,
                    b"DONE" => ClipStatus::Done,
                    _ => ClipStatus::Error,
                })
            }
            b"mime" => {
                mime = decode_b64(value).map(|m| String::from_utf8_lossy(&m).into_owned());
            }
            _ => {}
        }
    }
    Some(ClipPacket {
        status: status?,
        mime,
        payload: if payload.is_empty() {
            Vec::new()
        } else {
            decode_b64(payload)?
        },
    })
}

#[cfg(test)]
fn parse_event(buf: &[u8]) -> Option<(RawEvent, usize)> {
    parse_event_kitty(buf, false)
}

fn parse_event_kitty(buf: &[u8], kitty_active: bool) -> Option<(RawEvent, usize)> {
    let b0 = *buf.first()?;
    if b0 != 0x1b {
        return parse_plain_bytes(buf, kitty_active);
    }
    match *buf.get(1)? {
        b'[' => parse_csi(buf),
        b'_' | b']' | b'P' | b'X' | b'^' => {
            if let Some(end) = consume_string_sequence(buf)
                && let Some(packet) = parse_clip_packet(&buf[..end])
            {
                return Some((RawEvent::Clip(packet), end));
            }
            consume_string_sequence(buf).map(|end| match parse_osc52_reply(&buf[..end]) {
                Some(text) => (RawEvent::Paste(text), end),
                None => match parse_osc_color_reply(&buf[..end]) {
                    Some((slot, rgba)) => (RawEvent::Color(slot, rgba), end),
                    None => (RawEvent::Key(KeyEvent::plain(Key::Unknown)), end),
                },
            })
        }
        b'O' => {
            let key = match *buf.get(2)? {
                b'A' => Key::Up,
                b'B' => Key::Down,
                b'C' => Key::Right,
                b'D' => Key::Left,
                b'H' => Key::Home,
                b'F' => Key::End,
                b'P' => Key::Function(1),
                b'Q' => Key::Function(2),
                b'R' => Key::Function(3),
                b'S' => Key::Function(4),
                _ => Key::Unknown,
            };
            Some((RawEvent::Key(KeyEvent::plain(key)), 3))
        }
        b => {
            let mut event = byte_key_event(b);
            event.mods.alt = true;
            event.text = None;
            Some((RawEvent::Key(event), 2))
        }
    }
}

fn parse_plain_bytes(buf: &[u8], kitty_active: bool) -> Option<(RawEvent, usize)> {
    let b0 = buf[0];
    if b0 >= 0x80 {
        let len = match b0 {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return Some((RawEvent::Key(KeyEvent::plain(Key::Unknown)), 1)),
        };
        if buf.len() < len {
            return None;
        }
        return Some(match std::str::from_utf8(&buf[..len]) {
            Ok(s) => {
                let c = s.chars().next().expect("non-empty utf8");
                (RawEvent::Key(KeyEvent::plain(Key::Char(c))), len)
            }
            Err(_) => (RawEvent::Key(KeyEvent::plain(Key::Unknown)), 1),
        });
    }
    if kitty_active && let Some(event) = unrewrite_natural_editing(b0) {
        return Some((RawEvent::Key(event), 1));
    }
    Some((RawEvent::Key(byte_key_event(b0)), 1))
}

fn unrewrite_natural_editing(b: u8) -> Option<KeyEvent> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let key = match b {
        0x01 => Key::Left,
        0x05 => Key::Right,
        0x15 => Key::Backspace,
        _ => return None,
    };
    Some(KeyEvent {
        key,
        mods: Mods {
            sup: true,
            ..Mods::default()
        },
        kind: KeyKind::Press,
        text: None,
    })
}

fn byte_key_event(b: u8) -> KeyEvent {
    match b {
        0x0d => KeyEvent::plain(Key::Enter),
        0x09 => KeyEvent::plain(Key::Tab),
        0x7f | 0x08 => KeyEvent::plain(Key::Backspace),
        c @ 0x01..=0x1a => KeyEvent {
            key: Key::Char((b'a' + c - 1) as char),
            mods: Mods {
                ctrl: true,
                ..Mods::default()
            },
            kind: KeyKind::Press,
            text: None,
        },
        c @ 0x20..=0x7e => KeyEvent::plain(Key::Char(c as char)),
        _ => KeyEvent::plain(Key::Unknown),
    }
}

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

fn parse_csi(buf: &[u8]) -> Option<(RawEvent, usize)> {
    if buf.starts_with(PASTE_START) {
        let body_start = PASTE_START.len();
        let end = buf[body_start..]
            .windows(PASTE_END.len())
            .position(|w| w == PASTE_END)?;
        let body = normalize_newlines(
            String::from_utf8_lossy(&buf[body_start..body_start + end]).into_owned(),
        );
        return Some((RawEvent::Paste(body), body_start + end + PASTE_END.len()));
    }
    let mut end = 2;
    let terminator = loop {
        let b = *buf.get(end)?;
        end += 1;
        if (0x40..=0x7e).contains(&b) {
            break b;
        }
        if end - 2 > 1024 {
            return Some((RawEvent::Key(KeyEvent::plain(Key::Unknown)), end));
        }
    };
    let params = &buf[2..end - 1];
    let mods = decode_mods(param(params, 1).unwrap_or(1));
    let kind = key_kind(params);
    let event = match terminator {
        b'A' => RawEvent::Key(KeyEvent {
            key: Key::Up,
            mods,
            kind,
            text: None,
        }),
        b'B' => RawEvent::Key(KeyEvent {
            key: Key::Down,
            mods,
            kind,
            text: None,
        }),
        b'C' => RawEvent::Key(KeyEvent {
            key: Key::Right,
            mods,
            kind,
            text: None,
        }),
        b'D' => RawEvent::Key(KeyEvent {
            key: Key::Left,
            mods,
            kind,
            text: None,
        }),
        b'H' => RawEvent::Key(KeyEvent {
            key: Key::Home,
            mods,
            kind,
            text: None,
        }),
        b'F' => RawEvent::Key(KeyEvent {
            key: Key::End,
            mods,
            kind,
            text: None,
        }),
        b'Z' => RawEvent::Key(KeyEvent {
            key: Key::Tab,
            mods: Mods {
                shift: true,
                ..mods
            },
            kind,
            text: None,
        }),
        b'P' => RawEvent::Key(KeyEvent {
            key: Key::Function(1),
            mods,
            kind,
            text: None,
        }),
        b'Q' => RawEvent::Key(KeyEvent {
            key: Key::Function(2),
            mods,
            kind,
            text: None,
        }),
        b'R' => RawEvent::Key(KeyEvent {
            key: Key::Function(3),
            mods,
            kind,
            text: None,
        }),
        b'S' => RawEvent::Key(KeyEvent {
            key: Key::Function(4),
            mods,
            kind,
            text: None,
        }),
        b'u' => RawEvent::Key(parse_kitty_key(params)),
        b'~' => {
            let key = match param(params, 0) {
                Some(2) => Key::Insert,
                Some(3) => Key::Delete,
                Some(5) => Key::PageUp,
                Some(6) => Key::PageDown,
                Some(1 | 7) => Key::Home,
                Some(4 | 8) => Key::End,
                Some(11) => Key::Function(1),
                Some(12) => Key::Function(2),
                Some(13) => Key::Function(3),
                Some(14) => Key::Function(4),
                Some(15) => Key::Function(5),
                Some(17..=21) => Key::Function((param(params, 0).unwrap() - 11) as u8),
                Some(23 | 24) => Key::Function((param(params, 0).unwrap() - 12) as u8),
                // todo: needs link
                // xterm modifyOtherKeys: `CSI 27 ; mods ; codepoint ~`.
                Some(27) => {
                    let key = param(params, 2).map_or(Key::Unknown, key_from_codepoint);
                    return Some((
                        RawEvent::Key(KeyEvent {
                            key,
                            mods,
                            kind,
                            text: None,
                        }),
                        end,
                    ));
                }
                _ => Key::Unknown,
            };
            RawEvent::Key(KeyEvent {
                key,
                mods,
                kind,
                text: None,
            })
        }
        b'I' => RawEvent::Focus(true),
        b'O' => RawEvent::Focus(false),
        b'M' | b'm' => match parse_sgr_mouse(params, terminator == b'M') {
            Some((kind, button, mods, x, y)) => RawEvent::Mouse(kind, button, mods, x, y),
            None => RawEvent::Key(KeyEvent::plain(Key::Unknown)),
        },
        b't' => match (parse_resize_report(params), parse_cell_report(params)) {
            (Some(ws), _) => RawEvent::WindowSize(ws),
            (None, Some(cell)) => RawEvent::CellSize(cell),
            (None, None) => RawEvent::Key(KeyEvent::plain(Key::Unknown)),
        },
        b'y' if params.starts_with(b"?1016;") => {
            RawEvent::MousePixels(parse_decrqm_1016(&buf[..end]) == Some(true))
        }
        // `CSI ? 997 ; 1 n` — the terminal's palette changed under us.
        b'n' if params.starts_with(b"?997") => RawEvent::ColorSchemeChanged,
        _ => RawEvent::Key(KeyEvent::plain(Key::Unknown)),
    };
    Some((event, end))
}

fn parse_resize_report(params: &[u8]) -> Option<WindowSize> {
    let mut fields = params.split(|&b| b == b';').map(|field| {
        let digits: Vec<u8> = field
            .iter()
            .copied()
            .take_while(u8::is_ascii_digit)
            .collect();
        std::str::from_utf8(&digits).ok()?.parse::<u32>().ok()
    });
    if fields.next()?? != 48 {
        return None;
    }
    let rows = fields.next()??;
    let cols = fields.next()??;
    let height_px = fields.next().flatten().unwrap_or(0);
    let width_px = fields.next().flatten().unwrap_or(0);
    if rows == 0 || cols == 0 {
        return None;
    }
    Some(WindowSize {
        cols,
        rows,
        width_px,
        height_px,
    })
}

fn parse_kitty_key(params: &[u8]) -> KeyEvent {
    let Some(code) = param(params, 0) else {
        return KeyEvent::plain(Key::Unknown);
    };
    let mods = decode_mods(param(params, 1).unwrap_or(1));
    let kind = key_kind(params);
    KeyEvent {
        key: key_from_codepoint(code),
        mods,
        kind,
        text: associated_text(params),
    }
}

fn key_from_codepoint(code: u32) -> Key {
    match code {
        0 => Key::Unknown,
        13 => Key::Enter,
        9 => Key::Tab,
        27 => Key::Escape,
        8 | 127 => Key::Backspace,
        57364..=57398 => Key::Function((code - 57363) as u8),
        57399..=57408 => Key::Char(char::from_digit(code - 57399, 10).unwrap()),
        57409 => Key::Char('.'),
        57410 => Key::Char('/'),
        57411 => Key::Char('*'),
        57412 => Key::Char('-'),
        57413 => Key::Char('+'),
        57414 => Key::Enter,
        57415 => Key::Char('='),
        57417 => Key::Left,
        57418 => Key::Right,
        57419 => Key::Up,
        57420 => Key::Down,
        57421 => Key::PageUp,
        57422 => Key::PageDown,
        57423 => Key::Home,
        57424 => Key::End,
        57425 => Key::Insert,
        57426 => Key::Delete,
        57441 => Key::LeftShift,
        57442 => Key::LeftControl,
        57443 => Key::LeftAlt,
        57444 => Key::LeftSuper,
        57447 => Key::RightShift,
        57448 => Key::RightControl,
        57449 => Key::RightAlt,
        57450 => Key::RightSuper,
        57344..=63743 => Key::Unknown,
        c => char::from_u32(c).map_or(Key::Unknown, Key::Char),
    }
}

fn normalize_newlines(text: String) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

// todo: needs link
/// `OSC 52 ; c ; <base64> ST` — a terminal's answer to a clipboard read.
fn parse_osc52_reply(seq: &[u8]) -> Option<String> {
    use base64::Engine as _;
    let body = seq.strip_prefix(b"\x1b]52;")?;
    let semi = body.iter().position(|&b| b == b';')?;
    let payload = &body[semi + 1..];
    let end = payload
        .iter()
        .position(|&b| b == 0x07 || b == 0x1b)
        .unwrap_or(payload.len());
    let payload = &payload[..end];
    if payload == b"?" {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    Some(normalize_newlines(
        String::from_utf8_lossy(&bytes).into_owned(),
    ))
}

fn decode_mods(param: u32) -> Mods {
    let bits = param.saturating_sub(1);
    Mods {
        shift: bits & 1 != 0,
        alt: bits & 2 != 0,
        ctrl: bits & 4 != 0,
        sup: bits & 8 != 0, // interesting
    }
}

fn param(params: &[u8], index: usize) -> Option<u32> {
    let field = params.split(|&b| b == b';').nth(index)?;
    let field = field.split(|&b| b == b':').next()?;
    std::str::from_utf8(field).ok()?.parse().ok()
}

fn subparam(params: &[u8], index: usize, subindex: usize) -> Option<u32> {
    let field = params.split(|&b| b == b';').nth(index)?;
    let value = field.split(|&b| b == b':').nth(subindex)?;
    std::str::from_utf8(value).ok()?.parse().ok()
}

fn key_kind(params: &[u8]) -> KeyKind {
    match subparam(params, 1, 1) {
        Some(2) => KeyKind::Repeat,
        Some(3) => KeyKind::Release,
        _ => KeyKind::Press,
    }
}

fn associated_text(params: &[u8]) -> Option<String> {
    let field = params.split(|&b| b == b';').nth(2)?;
    let mut text = String::new();
    for code in field.split(|&b| b == b':') {
        let code = std::str::from_utf8(code).ok()?.parse().ok()?;
        let character = char::from_u32(code)?;
        if character.is_control() {
            return None;
        }
        text.push(character);
    }
    (!text.is_empty()).then_some(text)
}

fn consume_string_sequence(buf: &[u8]) -> Option<usize> {
    let mut i = 2;
    loop {
        match *buf.get(i)? {
            0x07 if buf[1] == b']' => return Some(i + 1),
            0x1b => {
                if *buf.get(i + 1)? == b'\\' {
                    return Some(i + 2);
                }
                i += 1;
            }
            _ if i > 16384 => return Some(i),
            _ => i += 1,
        }
    }
}

fn parse_sgr_mouse(params: &[u8], press: bool) -> Option<(MouseKind, MouseButton, Mods, u32, u32)> {
    let rest = params.strip_prefix(b"<")?;
    let mut fields = rest.split(|&b| b == b';');
    let mut next_int = || -> Option<u32> { std::str::from_utf8(fields.next()?).ok()?.parse().ok() };
    let b = next_int()?;
    let x = next_int()?;
    let y = next_int()?;
    if x == 0 || y == 0 {
        return None;
    }

    let button = match b & 3 {
        0 => MouseButton::Left,
        1 => MouseButton::Middle,
        2 => MouseButton::Right,
        _ => MouseButton::None,
    };
    let mods = Mods {
        shift: b & 4 != 0,
        alt: b & 8 != 0,
        ctrl: b & 16 != 0,
        sup: false,
    };
    let kind = if b & 64 != 0 {
        match b & 3 {
            0 => MouseKind::ScrollUp,
            1 => MouseKind::ScrollDown,
            2 => MouseKind::ScrollLeft,
            _ => MouseKind::ScrollRight,
        }
    } else if b & 32 != 0 {
        MouseKind::Move
    } else if press {
        MouseKind::Down
    } else {
        MouseKind::Up
    };
    Some((kind, button, mods, x, y))
}

fn parse_kitty_keyboard(buf: &[u8]) -> Option<bool> {
    let mut at = 0;
    while let Some(found) = buf[at..].windows(3).position(|w| w == b"\x1b[?") {
        let digits = at + found + 3;
        let end = digits + buf[digits..].iter().take_while(|b| b.is_ascii_digit()).count();
        if end > digits && buf.get(end) == Some(&b'u') {
            return Some(true);
        }
        at = digits;
    }
    None
}

fn parse_decrqm_1016(buf: &[u8]) -> Option<bool> {
    let start = buf.windows(8).position(|w| w == b"\x1b[?1016;")? + 8;
    let ps = *buf.get(start)?;
    Some(ps == b'1' || ps == b'3')
}

fn parse_decrqm_5522(buf: &[u8]) -> Option<bool> {
    let start = buf.windows(8).position(|w| w == b"\x1b[?5522;")? + 8;
    let ps = *buf.get(start)?;
    Some(ps == b'1' || ps == b'2' || ps == b'3')
}

fn parse_decrqm_2031(buf: &[u8]) -> Option<bool> {
    let start = buf.windows(8).position(|w| w == b"\x1b[?2031;")? + 8;
    let ps = *buf.get(start)?;
    Some(ps == b'1' || ps == b'2')
}

/// `rgb:RRRR/GGGG/BBBB`, with each channel 1-4 hex digits.
fn parse_rgb_spec(spec: &str) -> Option<[u8; 4]> {
    let mut channels = spec.split('/').map(|hex| {
        let value = u16::from_str_radix(hex, 16).ok()?;
        Some(match hex.len() {
            1 => (value * 17) as u8,
            2 => value as u8,
            3 => (value >> 4) as u8,
            4 => (value >> 8) as u8,
            _ => return None,
        })
    });
    let r = channels.next()??;
    let g = channels.next()??;
    let b = channels.next()??;
    Some([r, g, b, 255])
}

fn parse_osc_color(buf: &[u8], selector: &str) -> Option<[u8; 4]> {
    let text = String::from_utf8_lossy(buf);
    let prefix = format!("\x1b]{selector}rgb:");
    let start = text.find(&prefix)? + prefix.len();
    let spec: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '/')
        .collect();
    parse_rgb_spec(&spec)
}

fn parse_osc_color_reply(seq: &[u8]) -> Option<(ColorSlot, [u8; 4])> {
    let text = String::from_utf8_lossy(seq);
    let body = text.strip_prefix("\x1b]")?;
    let (selector, rest) = body.split_once(';')?;
    let (slot, rest) = match selector {
        "10" => (ColorSlot::Foreground, rest),
        "11" => (ColorSlot::Background, rest),
        "4" => {
            let (index, rest) = rest.split_once(';')?;
            let index: u8 = index.parse().ok()?;
            if index >= 16 {
                return None;
            }
            (ColorSlot::Palette(index), rest)
        }
        _ => return None,
    };
    let spec: String = rest
        .strip_prefix("rgb:")?
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '/')
        .collect();
    Some((slot, parse_rgb_spec(&spec)?))
}

fn parse_cell_size_report(buf: &[u8]) -> Option<(u32, u32)> {
    let start = buf.windows(4).position(|w| w == b"\x1b[6;")? + 2;
    let end = start + buf[start..].iter().position(|&b| b == b't')?;
    parse_cell_report(&buf[start..end])
}

fn parse_cell_report(params: &[u8]) -> Option<(u32, u32)> {
    let mut fields = params
        .split(|&b| b == b';')
        .map(|field| std::str::from_utf8(field).ok()?.parse::<u32>().ok());
    if fields.next()?? != 6 {
        return None;
    }
    let height = fields.next()??;
    let width = fields.next()??;
    (width > 0 && height > 0).then_some((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_in_band_resize_reports() {
        let (event, used) = parse_event(b"\x1b[48;30;100;630;1000t").unwrap();
        assert_eq!(
            event,
            RawEvent::WindowSize(WindowSize {
                cols: 100,
                rows: 30,
                width_px: 1000,
                height_px: 630,
            })
        );
        assert_eq!(used, 21);
        let (event, _) = parse_event(b"\x1b[48;30:1;100;630;1000t").unwrap();
        assert!(matches!(event, RawEvent::WindowSize(ws) if ws.rows == 30 && ws.cols == 100));
        let (event, _) = parse_event(b"\x1b[48;30;100;0;0t").unwrap();
        assert!(matches!(event, RawEvent::WindowSize(ws) if ws.cell_size().is_none()));
        let (event, _) = parse_event(b"\x1b[6;21;10t").unwrap();
        assert!(matches!(event, RawEvent::CellSize((10, 21))));
    }

    #[test]
    fn parses_cell_size_report_amid_noise() {
        assert_eq!(parse_cell_size_report(b"\x1b[6;14;7t"), Some((7, 14)));
        assert_eq!(parse_cell_size_report(b"ab\x1b[6;28;13tcd"), Some((13, 28)));
        assert_eq!(parse_cell_size_report(b"\x1b[6;14"), None);
        assert_eq!(parse_cell_size_report(b"\x1b[6;0;0t"), None);
    }

    #[test]
    fn parses_sgr_mouse_events() {
        let plain = Mods::default();
        assert_eq!(
            parse_sgr_mouse(b"<0;100;200", true),
            Some((MouseKind::Down, MouseButton::Left, plain, 100, 200))
        );
        assert_eq!(
            parse_sgr_mouse(b"<2;5;6", false),
            Some((MouseKind::Up, MouseButton::Right, plain, 5, 6))
        );
        assert_eq!(
            parse_sgr_mouse(b"<32;9;9", true),
            Some((MouseKind::Move, MouseButton::Left, plain, 9, 9))
        );
        assert_eq!(
            parse_sgr_mouse(b"<64;1;1", true),
            Some((MouseKind::ScrollUp, MouseButton::Left, plain, 1, 1))
        );
        assert_eq!(
            parse_sgr_mouse(b"<65;1;1", true),
            Some((MouseKind::ScrollDown, MouseButton::Middle, plain, 1, 1))
        );
        assert_eq!(
            parse_sgr_mouse(b"<66;1;1", true).unwrap().0,
            MouseKind::ScrollLeft
        );
        assert_eq!(
            parse_sgr_mouse(b"<67;1;1", true).unwrap().0,
            MouseKind::ScrollRight
        );
        assert_eq!(parse_sgr_mouse(b"0;1;1", true), None);
        assert_eq!(parse_sgr_mouse(b"<0;0;1", true), None);

        assert_eq!(parse_sgr_mouse(b"<4;1;1", true).unwrap().2, SHIFT);
        assert_eq!(parse_sgr_mouse(b"<8;1;1", true).unwrap().2, ALT);
        assert_eq!(
            parse_sgr_mouse(b"<80;1;1", true).unwrap(),
            (MouseKind::ScrollUp, MouseButton::Left, CTRL, 1, 1),
            "ctrl+wheel keeps the scroll direction"
        );
        let (_, _, mods, _, _) = parse_sgr_mouse(b"<28;1;1", true).unwrap();
        assert!(mods.shift && mods.alt && mods.ctrl && !mods.sup);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn natural_text_editing_bytes_unrewrite_only_under_kitty() {
        // with the protocol active a raw readline byte can only be a macOS
        // "natural text editing" rewrite, so the original chord comes back
        assert_eq!(parse_event_kitty(b"\x01", true), Some((key_mods(Key::Left, SUPER), 1)));
        assert_eq!(parse_event_kitty(b"\x05", true), Some((key_mods(Key::Right, SUPER), 1)));
        assert_eq!(
            parse_event_kitty(b"\x15", true),
            Some((key_mods(Key::Backspace, SUPER), 1))
        );
        // without the protocol the byte is genuinely ambiguous, so nothing
        // is invented and ctrl+a stays ctrl+a
        assert_eq!(
            parse_event_kitty(b"\x01", false),
            Some((key_mods(Key::Char('a'), CTRL), 1))
        );
        // esc-prefixed bytes are alt chords, never rewrites
        assert_eq!(
            parse_event_kitty(b"\x1b\x01", true),
            Some((
                key_mods(
                    Key::Char('a'),
                    Mods {
                        ctrl: true,
                        alt: true,
                        ..Mods::default()
                    }
                ),
                2
            ))
        );
    }

    #[test]
    fn kitty_keyboard_reply_is_the_whole_answer() {
        // a terminal that speaks the protocol names the flags it is using
        assert_eq!(parse_kitty_keyboard(b"\x1b[?1u"), Some(true));
        assert_eq!(parse_kitty_keyboard(b"\x1b[?27u"), Some(true));
        assert_eq!(parse_kitty_keyboard(b"\x1b[?0u"), Some(true));
        // one that does not stays quiet, and other reports share the opening without
        // being an answer — reading them as "no" would end the wait on the wrong evidence
        assert_eq!(parse_kitty_keyboard(b""), None);
        assert_eq!(parse_kitty_keyboard(b"\x1b[?62;22;52c"), None);
        assert_eq!(parse_kitty_keyboard(b"\x1b[?1016;1$y"), None);
        assert_eq!(parse_kitty_keyboard(b"\x1b[?u"), None);
        // and it is still found behind one of them
        assert_eq!(parse_kitty_keyboard(b"\x1b[?62;22;52c\x1b[?27u"), Some(true));
    }

    fn key(k: Key) -> RawEvent {
        RawEvent::Key(KeyEvent::plain(k))
    }

    fn key_mods(k: Key, mods: Mods) -> RawEvent {
        RawEvent::Key(KeyEvent {
            key: k,
            mods,
            kind: KeyKind::Press,
            text: None,
        })
    }

    const SHIFT: Mods = Mods {
        shift: true,
        alt: false,
        ctrl: false,
        sup: false,
    };
    const ALT: Mods = Mods {
        shift: false,
        alt: true,
        ctrl: false,
        sup: false,
    };
    const CTRL: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: true,
        sup: false,
    };
    const SUPER: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: false,
        sup: true,
    };

    #[test]
    fn parse_event_consumes_one_event_and_reports_incomplete_tails() {
        assert_eq!(parse_event(b""), None);
        assert_eq!(parse_event(b"a"), Some((key(Key::Char('a')), 1)));
        assert_eq!(parse_event(b"\x1b"), None, "escape alone: wait for more");
        assert_eq!(parse_event(b"\x1b["), None);
        assert_eq!(parse_event(b"\x1b[<65;10;2"), None, "mouse mid-sequence");
        assert_eq!(
            parse_event(b"\x1b[<65;10;20Mxyz"),
            Some((
                RawEvent::Mouse(MouseKind::ScrollDown, MouseButton::Middle, Mods::default(), 10, 20),
                12
            ))
        );
        assert_eq!(parse_event(b"\x1b[Aq"), Some((key(Key::Up), 3)));
        assert_eq!(parse_event(b"\x1b[I"), Some((RawEvent::Focus(true), 3)));
        assert_eq!(parse_event(b"\x1b[O"), Some((RawEvent::Focus(false), 3)));
        assert_eq!(parse_event(b"\x1bOP"), Some((key(Key::Function(1)), 3)));
        assert_eq!(parse_event(b"\x1bOA"), Some((key(Key::Up), 3)));
    }

    #[test]
    fn parses_a_burst_of_sgr_pixel_wheel_ticks_from_one_read() {
        let mut buf = b"\x1b[<64;575;692M".repeat(3);
        buf.extend_from_slice(&b"\x1b[<65;575;692M".repeat(2));
        let mut rest = &buf[..];
        let mut kinds = Vec::new();
        while let Some((event, used)) = parse_event(rest) {
            let RawEvent::Mouse(kind, _, mods, x, y) = event else {
                panic!("not a mouse event: {event:?}");
            };
            assert_eq!((mods, x, y), (Mods::default(), 575, 692));
            kinds.push(kind);
            rest = &rest[used..];
        }
        assert!(rest.is_empty());
        use MouseKind::{ScrollDown as D, ScrollUp as U};
        assert_eq!(kinds, [U, U, U, D, D]);
    }

    #[test]
    fn a_late_1016_mode_report_is_read_from_the_input_stream() {
        assert_eq!(
            parse_event(b"\x1b[?1016;1$yx"),
            Some((RawEvent::MousePixels(true), 11))
        );
        assert_eq!(
            parse_event(b"\x1b[?1016;0$y"),
            Some((RawEvent::MousePixels(false), 11))
        );
    }

    #[test]
    fn terminal_reply_strings_never_leak_as_keystrokes() {
        // xterm.js < May 2026 replies OK to every transmission despite q=2.
        assert_eq!(
            parse_event(b"\x1b_Gi=1;OK\x1b\\"),
            Some((key(Key::Unknown), 11))
        );
        assert_eq!(parse_event(b"\x1b_Gi=1;OK"), None, "reply mid-arrival");
        assert_eq!(
            parse_event(b"\x1b]11;rgb:1e/2a/34\x07x"),
            Some((RawEvent::Color(ColorSlot::Background, [30, 42, 52, 255]), 18)),
            "late OSC reply, BEL-terminated"
        );
        assert_eq!(
            parse_event(b"\x1bP1$r0m\x1b\\"),
            Some((key(Key::Unknown), 9))
        );
    }

    #[test]
    fn reads_color_replies_for_every_slot_and_leaves_the_next_keystroke_alone() {
        assert_eq!(
            parse_event(b"\x1b]10;rgb:ff/ee/dd\x1b\\"),
            Some((RawEvent::Color(ColorSlot::Foreground, [255, 238, 221, 255]), 19))
        );
        assert_eq!(
            parse_event(b"\x1b]4;13;rgb:9f9f/8686/ebeb\x1b\\"),
            Some((RawEvent::Color(ColorSlot::Palette(13), [159, 134, 235, 255]), 27))
        );
        assert_eq!(
            parse_osc_color_reply(b"\x1b]4;99;rgb:11/22/33\x07"),
            None,
            "slots past the 16 we track"
        );

        let stream = b"\x1b]11;rgb:1e/2a/34\x07a";
        let (event, used) = parse_event(stream).unwrap();
        assert_eq!(event, RawEvent::Color(ColorSlot::Background, [30, 42, 52, 255]));
        assert_eq!(parse_event(&stream[used..]), Some((key(Key::Char('a')), 1)));
    }

    #[test]
    fn reads_the_color_scheme_notification() {
        assert_eq!(parse_event(b"\x1b[?997;1n"), Some((RawEvent::ColorSchemeChanged, 9)));
        assert_eq!(parse_event(b"\x1b[?997;2n"), Some((RawEvent::ColorSchemeChanged, 9)));
    }

    #[test]
    fn decrqm_replies_say_whether_a_mode_is_supported() {
        assert_eq!(parse_decrqm_2031(b"\x1b[?2031;1$y"), Some(true));
        assert_eq!(parse_decrqm_2031(b"\x1b[?2031;2$y"), Some(true));
        assert_eq!(parse_decrqm_2031(b"\x1b[?2031;0$y"), Some(false));
        assert_eq!(parse_decrqm_2031(b""), None, "terminal never answered");

        assert_eq!(parse_decrqm_5522(b"\x1b[?5522;2$y"), Some(true));
        assert_eq!(parse_decrqm_5522(b"\x1b[?5522;1$y"), Some(true));
        assert_eq!(parse_decrqm_5522(b"\x1b[?5522;0$y"), Some(false));
        assert_eq!(parse_decrqm_5522(b"\x1b[?5522;4$y"), Some(false));
        assert_eq!(parse_decrqm_5522(b"\x1b[?1016;1$y"), None);

        assert_eq!(parse_decrqm_1016(b"\x1b[?1016;1$y"), Some(true));
        assert_eq!(
            parse_decrqm_1016(b"\x1b[?1016;2$y"),
            Some(false),
            "pixel mouse reports only count when the mode is on, unlike the other modes"
        );
        assert_eq!(parse_decrqm_1016(b"\x1b[?1016;0$y"), Some(false));
        assert_eq!(parse_decrqm_1016(b"\x1b[?1015;1$y"), None);
    }

    #[test]
    fn parses_modifiers_on_legacy_and_kitty_keys() {
        assert_eq!(
            parse_event(b"\x1b[1;2D"),
            Some((key_mods(Key::Left, SHIFT), 6))
        );
        assert_eq!(
            parse_event(b"\x1b[1;3C"),
            Some((key_mods(Key::Right, ALT), 6))
        );
        assert_eq!(
            parse_event(b"\x1b[1;9A"),
            Some((key_mods(Key::Up, SUPER), 6))
        );
        assert_eq!(parse_event(b"\x1b[3~"), Some((key(Key::Delete), 4)));
        assert_eq!(parse_event(b"\x1b[H"), Some((key(Key::Home), 3)));
        assert_eq!(parse_event(b"\x1b[F"), Some((key(Key::End), 3)));
        assert_eq!(parse_event(b"\x1b[Z"), Some((key_mods(Key::Tab, SHIFT), 3)));

        assert_eq!(
            parse_event(b"\x1b[99;5u"),
            Some((key_mods(Key::Char('c'), CTRL), 7))
        );
        assert_eq!(
            parse_event(b"\x1b[97;9u"),
            Some((key_mods(Key::Char('a'), SUPER), 7))
        );
        assert_eq!(
            parse_event(b"\x1b[13;2u"),
            Some((key_mods(Key::Enter, SHIFT), 7))
        );
        assert_eq!(
            parse_event(b"\x1b[127;3u"),
            Some((key_mods(Key::Backspace, ALT), 8))
        );
        assert_eq!(parse_event(b"\x1b[27u"), Some((key(Key::Escape), 5)));
        assert_eq!(
            parse_event(b"\x1b[99:67;5u"),
            Some((key_mods(Key::Char('c'), CTRL), 10)),
            "sub-parameters (shifted key) are ignored"
        );
        assert_eq!(parse_event(b"\x1b[57428;1u"), Some((key(Key::Unknown), 10)));
    }

    #[test]
    fn parses_kitty_repeat_and_release_events() {
        let (repeat, _) = parse_event(b"\x1b[97;1:2u").unwrap();
        let (release, _) = parse_event(b"\x1b[97;1:3u").unwrap();
        assert!(matches!(repeat, RawEvent::Key(KeyEvent { kind: KeyKind::Repeat, .. })));
        assert!(matches!(release, RawEvent::Key(KeyEvent { kind: KeyKind::Release, .. })));
    }

    #[test]
    fn parses_kitty_associated_text_and_function_keys() {
        let (event, _) = parse_event(b"\x1b[97;2;65u").unwrap();
        assert!(matches!(
            event,
            RawEvent::Key(KeyEvent {
                key: Key::Char('a'),
                text: Some(text),
                ..
            }) if text == "A"
        ));
        let (event, _) = parse_event(b"\x1b[0;;229u").unwrap();
        assert!(matches!(
            event,
            RawEvent::Key(KeyEvent {
                key: Key::Unknown,
                text: Some(text),
                ..
            }) if text == "å"
        ));
        assert_eq!(parse_event(b"\x1b[5~"), Some((key(Key::PageUp), 4)));
        assert_eq!(parse_event(b"\x1b[24~"), Some((key(Key::Function(12)), 5)));
        assert_eq!(parse_event(b"\x1bOP"), Some((key(Key::Function(1)), 3)));
        assert_eq!(parse_event(b"\x1b[57444;9u"), Some((key_mods(Key::LeftSuper, SUPER), 10)));
    }

    #[test]
    fn ctrl_bytes_and_alt_prefixes_decode_as_modified_chars() {
        assert_eq!(
            parse_event(b"\x11"),
            Some((key_mods(Key::Char('q'), CTRL), 1))
        );
        assert_eq!(parse_event(b"\x09"), Some((key(Key::Tab), 1)));
        assert_eq!(parse_event(b"\x0d"), Some((key(Key::Enter), 1)));
        assert_eq!(
            parse_event(b"\x1bf"),
            Some((key_mods(Key::Char('f'), ALT), 2))
        );
        assert_eq!(
            parse_event(b"\x1b\x7f"),
            Some((key_mods(Key::Backspace, ALT), 2))
        );
        // Ghostty's common `shift+enter=text:\x1b\r` rewrite must land as
        // Enter, not vanish as an unknown key.
        assert_eq!(
            parse_event(b"\x1b\x0d"),
            Some((key_mods(Key::Enter, ALT), 2))
        );
    }

    #[test]
    fn utf8_input_decodes_whole_chars() {
        assert_eq!(parse_event("é".as_bytes()), Some((key(Key::Char('é')), 2)));
        assert_eq!(
            parse_event("猫x".as_bytes()),
            Some((key(Key::Char('猫')), 3))
        );
        assert_eq!(
            parse_event(&"é".as_bytes()[..1]),
            None,
            "partial utf8 waits for the rest"
        );
        assert_eq!(parse_event(b"\xff"), Some((key(Key::Unknown), 1)));
    }

    #[test]
    fn parses_modify_other_keys_sequences() {
        assert_eq!(
            parse_event(b"\x1b[27;3;127~"),
            Some((key_mods(Key::Backspace, ALT), 11))
        );
        assert_eq!(
            parse_event(b"\x1b[27;9;127~"),
            Some((key_mods(Key::Backspace, SUPER), 11))
        );
        assert_eq!(
            parse_event(b"\x1b[27;5;99~"),
            Some((key_mods(Key::Char('c'), CTRL), 10))
        );
    }

    #[test]
    fn clipboard_read_replies_become_paste_events() {
        assert_eq!(
            parse_event(b"\x1b]52;c;aGkNdGhlcmU=\x1b\\"),
            Some((RawEvent::Paste("hi\nthere".into()), 21)),
            "base64 decoded, newlines normalized"
        );
        assert_eq!(
            parse_event(b"\x1b]52;c;aGVsbG8=\x07x"),
            Some((RawEvent::Paste("hello".into()), 16)),
            "BEL-terminated"
        );
        assert_eq!(
            parse_event(b"\x1b]52;c;?\x1b\\"),
            Some((key(Key::Unknown), 10)),
            "a query echo is not clipboard data"
        );
        assert_eq!(
            parse_event(b"\x1b]52;c;!!!\x1b\\"),
            Some((key(Key::Unknown), 12)),
            "garbage payload swallowed silently"
        );
    }

    #[test]
    fn bracketed_paste_arrives_as_one_normalized_event() {
        assert_eq!(
            parse_event(b"\x1b[200~hi\r\nthere\rend\x1b[201~x"),
            Some((RawEvent::Paste("hi\nthere\nend".into()), 25))
        );
        assert_eq!(
            parse_event(b"\x1b[200~partial paste"),
            None,
            "paste waits for its terminator"
        );
        assert_eq!(
            parse_event(b"\x1b[200~\x1b[201~"),
            Some((RawEvent::Paste(String::new()), 12))
        );
    }

    #[test]
    fn parses_osc_color_replies() {
        let reply =
            b"\x1b]11;rgb:1e1e/2a2a/3434\x1b\\\x1b]10;rgb:ff/ee/dd\x07\x1b]4;13;rgb:9f/86/eb\x1b\\";
        assert_eq!(parse_osc_color(reply, "11;"), Some([0x1e, 0x2a, 0x34, 255]));
        assert_eq!(parse_osc_color(reply, "10;"), Some([0xff, 0xee, 0xdd, 255]));
        assert_eq!(
            parse_osc_color(reply, "4;13;"),
            Some([0x9f, 0x86, 0xeb, 255])
        );
        assert_eq!(parse_osc_color(reply, "4;2;"), None);
        assert_eq!(parse_osc_color(b"garbage", "11;"), None);
    }

    #[test]
    fn clip_packets_parse_status_mime_and_chunk() {
        use base64::Engine as _;
        let b64 = |v: &[u8]| base64::engine::general_purpose::STANDARD.encode(v);
        let ok = parse_clip_packet(b"\x1b]5522;type=read:status=OK\x1b\\").unwrap();
        assert_eq!(ok.status, ClipStatus::Ok);

        let seq = format!(
            "\x1b]5522;type=read:status=DATA:mime={};{}\x1b\\",
            b64(b"image/png"),
            b64(b"chunk-bytes")
        );
        let data = parse_clip_packet(seq.as_bytes()).unwrap();
        assert_eq!(data.status, ClipStatus::Data);
        assert_eq!(data.mime.as_deref(), Some("image/png"));
        assert_eq!(data.payload, b"chunk-bytes");

        let done = parse_clip_packet(b"\x1b]5522;type=read:status=DONE\x1b\\").unwrap();
        assert_eq!(done.status, ClipStatus::Done);
        let denied = parse_clip_packet(b"\x1b]5522;type=read:status=EPERM\x1b\\").unwrap();
        assert_eq!(denied.status, ClipStatus::Error);
        assert!(parse_clip_packet(b"\x1b]52;c;?\x1b\\").is_none(), "osc52 untouched");
    }

}

#[cfg(test)]
mod tty_tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    fn open(path: &str, wrapper: Wrapper) -> Terminal {
        Terminal::open(path, wrapper, true).unwrap()
    }


    #[test]
    fn mouse_coordinates_match_the_negotiated_format() {
        for (reply, wrapper) in [
            (Some(b"\x1b[?1016;1$y".as_slice()), Wrapper::None),
            (Some(b"\x1b[?1016;4$y".as_slice()), Wrapper::None),
            (None, Wrapper::None),
            (None, Wrapper::Tmux),
        ] {
            let (master, _slave, path) = open_pty();
            let _terminal = fake_terminal_answering_1016(&master, reply, Duration::ZERO);
            let mut term = open(&path, wrapper);
            term.cell = Some((8, 16));
            term.io.out().write_all(b"\x1b[5n").unwrap();
            term.io.out().flush().unwrap();
            let event = term.poll_event(Some(Duration::from_millis(500))).unwrap();
            assert!(
                matches!(event, Some(Event::Mouse(Mouse {
                    kind: MouseKind::Down,
                    button: MouseButton::Left,
                    x: 484,
                    y: 328,
                    ..
                }))),
                "the same click must land at (484, 328), reply={reply:?}, wrapper={wrapper:?}: {event:?}"
            );
        }
    }

    #[test]
    fn a_1016_answer_that_arrives_late_still_switches_to_pixels() {
        let (master, _slave, path) = open_pty();
        let _terminal = fake_terminal_answering_1016(
            &master,
            Some(b"\x1b[?1016;1$y"),
            Duration::from_millis(400),
        );
        let mut term = open(&path, Wrapper::None);
        term.cell = Some((8, 16));
        assert!(!term.reports_pixel_mouse(), "no answer yet: cells");
        let _ = term.poll_event(Some(Duration::from_millis(600))).unwrap();
        assert!(
            term.reports_pixel_mouse(),
            "the late answer was read from the input stream"
        );
        term.io.out().write_all(b"\x1b[5n").unwrap();
        term.io.out().flush().unwrap();
        let event = term.poll_event(Some(Duration::from_millis(500))).unwrap();
        assert!(term.reports_pixel_mouse());
        assert!(
            matches!(event, Some(Event::Mouse(Mouse { x: 484, y: 328, .. }))),
            "{event:?}"
        );
    }

    #[test]
    fn a_report_past_the_cell_grid_switches_an_unanswered_terminal_to_pixels() {
        let (mut master, slave, path) = open_pty();
        let size = rustix::termios::Winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        rustix::termios::tcsetwinsize(&slave, size).unwrap();
        let _terminal = fake_terminal_answering_1016(&master, None, Duration::ZERO);
        let mut term = open(&path, Wrapper::None);
        term.cell = Some((8, 16));
        assert!(!term.reports_pixel_mouse());
        master.write_all(b"\x1b[<35;485;329M").unwrap();
        let event = term.poll_event(Some(Duration::from_millis(500))).unwrap();
        assert!(term.reports_pixel_mouse());
        assert!(
            matches!(event, Some(Event::Mouse(Mouse { x: 484, y: 328, .. }))),
            "{event:?}"
        );
        term.io.out().write_all(b"\x1b[5n").unwrap();
        term.io.out().flush().unwrap();
        let event = term.poll_event(Some(Duration::from_millis(500))).unwrap();
        assert!(
            matches!(event, Some(Event::Mouse(Mouse { x: 484, y: 328, .. }))),
            "the terminal was switched back to pixels: {event:?}"
        );
    }

    fn open_pty() -> (std::fs::File, std::fs::File, String) {
        let mut master: libc::c_int = 0;
        let mut slave: libc::c_int = 0;
        let mut name = [0u8; 128];
        #[allow(unsafe_code)]
        let ok = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                name.as_mut_ptr().cast(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        assert_eq!(ok, 0, "openpty failed");
        let end = name.iter().position(|&b| b == 0).unwrap();
        let path = String::from_utf8(name[..end].to_vec()).unwrap();
        #[allow(unsafe_code)]
        let (master, slave) = unsafe {
            use std::os::unix::io::FromRawFd as _;
            (
                std::fs::File::from_raw_fd(master),
                std::fs::File::from_raw_fd(slave),
            )
        };
        (master, slave, path)
    }

    fn fake_terminal(master: &std::fs::File) -> std::thread::JoinHandle<()> {
        fake_terminal_answering_1016(master, Some(b"\x1b[?1016;0$y"), Duration::ZERO)
    }

    fn fake_terminal_answering_1016(
        master: &std::fs::File,
        mode_1016: Option<&'static [u8]>,
        mode_1016_delay: Duration,
    ) -> std::thread::JoinHandle<()> {
        let mut master = master.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut seen = Vec::new();
            let mut pixels = false;
            let mut byte = [0u8; 1];
            while master.read_exact(&mut byte).is_ok() {
                seen.push(byte[0]);
                let reply: Option<Vec<u8>> = if seen.ends_with(b"\x1b[?1016h") {
                    pixels = true;
                    None
                } else if seen.ends_with(b"\x1b[?1016l") || seen.ends_with(b"\x1b[?1006h") {
                    pixels = false;
                    None
                } else if seen.ends_with(b"\x1b[?u") {
                    Some(b"\x1b[?0u".to_vec())
                } else if seen.ends_with(b"\x1b[?1016$p") && !mode_1016_delay.is_zero() {
                    let mut late = master.try_clone().unwrap();
                    let reply = mode_1016.unwrap_or_default();
                    std::thread::spawn(move || {
                        std::thread::sleep(mode_1016_delay);
                        late.write_all(reply).unwrap();
                    });
                    None
                } else if seen.ends_with(b"\x1b[?1016$p") {
                    mode_1016.map(<[u8]>::to_vec)
                } else if seen.ends_with(b"\x1b[?5522$p") {
                    Some(b"\x1b[?5522;0$y".to_vec())
                } else if seen.ends_with(b"\x1b[?2031$p") {
                    Some(b"\x1b[?2031;0$y".to_vec())
                } else if seen.ends_with(b"\x1b[>0q") {
                    Some(b"\x1bP>|fake 0.0\x1b\\".to_vec())
                } else if seen.ends_with(b"\x1b[5n") {
                    Some(if pixels { b"\x1b[<0;485;329M".to_vec() } else { b"\x1b[<0;61;21M".to_vec() })
                } else if seen.ends_with(b"\x1b\\") {
                    graphics_error(&seen)
                } else {
                    continue;
                };
                seen.clear();
                if let Some(reply) = reply {
                    master.write_all(&reply).unwrap();
                }
            }
        })
    }

    fn graphics_error(seen: &[u8]) -> Option<Vec<u8>> {
        let start = seen.windows(3).rposition(|w| w == b"\x1b_G")? + 3;
        let control = seen[start..].split(|&b| b == b';').next()?;
        let mut action = None;
        let mut id = None;
        for pair in std::str::from_utf8(control).ok()?.split(',') {
            match pair.split_once('=') {
                Some(("a", value)) => action = Some(value),
                Some(("i", value)) => id = value.parse::<u32>().ok(),
                _ => {}
            }
        }
        let error = match action? {
            "q" => "ENOENT:no such medium",
            "f" => "EINVAL:no such action",
            _ => return None,
        };
        Some(format!("\x1b_Gi={};{error}\x1b\\", id?).into_bytes())
    }

    #[test]
    fn two_terminals_share_a_process() {
        let (mut master_a, _slave_a, path_a) = open_pty();
        let (master_b, _slave_b, path_b) = open_pty();
        let _terminal_a = fake_terminal(&master_a);
        let _terminal_b = fake_terminal(&master_b);
        let mut a = open(&path_a, Wrapper::None);
        let mut b = open(&path_b, Wrapper::None);

        master_a.write_all(b"\x1b[97;;97u").unwrap();
        let got = a.poll_event(Some(Duration::from_millis(500))).unwrap();
        assert!(
            matches!(got, Some(Event::Key(_))),
            "terminal A should see its own input: {got:?}"
        );
        let other = b.poll_event(Some(Duration::from_millis(50))).unwrap();
        assert!(other.is_none(), "terminal B must not see A's input: {other:?}");

        a.watch_resize().unwrap();
        b.watch_resize().unwrap();
        assert_ne!(a.resize_slot, b.resize_slot);
        assert!(a.resize_slot.is_some() && b.resize_slot.is_some());

        let slot_a = a.resize_slot.unwrap();
        drop(a);
        assert_eq!(
            RESIZE_WAKE_FDS[slot_a].load(std::sync::atomic::Ordering::Relaxed),
            -1,
            "dropping a terminal must release its resize slot"
        );
    }

    #[test]
    fn a_bare_escape_resolves_on_its_own_under_tmux_or_without_kitty_keys() {
        let (mut master, _slave, path) = open_pty();
        let _terminal = fake_terminal(&master);
        let mut term = open(&path, Wrapper::Tmux);

        master.write_all(b"\x1b").unwrap();
        let got = term.poll_event(Some(Duration::from_millis(500))).unwrap();
        assert!(
            matches!(&got, Some(Event::Key(key)) if key.key == Key::Escape),
            "tmux sends the escape key as a bare 0x1b: {got:?}"
        );

        master.write_all(b"\x1b[112;3u").unwrap();
        let next = term.poll_event(Some(Duration::from_millis(500))).unwrap();
        assert!(
            matches!(&next, Some(Event::Key(key)) if key.key == Key::Char('p') && key.mods.alt),
            "the key after an escape must survive: {next:?}"
        );

        let (mut master, _slave, path) = open_pty();
        let _terminal = fake_terminal(&master);
        let mut term = open(&path, Wrapper::None);

        master.write_all(b"\x1b").unwrap();
        let got = term.poll_event(Some(Duration::from_millis(200))).unwrap();
        assert!(got.is_none(), "outside tmux escape arrives as CSI-u: {got:?}");

        let (mut master, _slave, path) = open_pty();
        let _terminal = fake_terminal(&master);
        let mut term = open(&path, Wrapper::None);
        term.kitty_keyboard = false;
        master.write_all(b"\x1b").unwrap();
        let got = term.poll_event(Some(Duration::from_millis(500))).unwrap();
        assert!(
            matches!(&got, Some(Event::Key(key)) if key.key == Key::Escape),
            "a terminal without kitty keys sends escape as a bare 0x1b: {got:?}"
        );
    }

    #[test]
    fn a_wake_ends_a_blocking_poll() {
        let (master, _slave, path) = open_pty();
        let _terminal = fake_terminal(&master);
        let mut term = open(&path, Wrapper::None);
        let waker = term.waker().unwrap();

        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            waker.wake();
        });
        let started = Instant::now();
        let got = term.poll_event(Some(Duration::from_secs(5))).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the poll ran to its deadline instead of ending at the wake"
        );
        assert!(got.is_none(), "a wake carries no terminal event: {got:?}");
    }
}

#[cfg(test)]
mod relay_mouse_tests {
    use super::*;

    fn grid() -> Option<WindowSize> {
        Some(WindowSize {
            cols: 120,
            rows: 40,
            width_px: 1200,
            height_px: 800,
        })
    }

    #[test]
    fn unfocused_in_grid_wheel_rescales_to_cell_centers() {

        // The bug case: an unfocused wheel arrives as cells (8, 9) and is
        // rescaled to the cell center.
        assert_eq!(
            relay_mouse_position_px((10, 20), MouseKind::ScrollUp, 8, 9, false, true, grid),
            (75, 170)
        );
        // Focused wheels are honest pixels; pass them through 0-based.
        assert_eq!(
            relay_mouse_position_px((10, 20), MouseKind::ScrollUp, 8, 9, true, true, grid),
            (7, 8)
        );
        // Coordinates beyond the cell grid can only be pixels.
        assert_eq!(
            relay_mouse_position_px((10, 20), MouseKind::ScrollDown, 640, 9, false, true, grid),
            (639, 8)
        );
        // Without pixel mouse mode every report is cells.
        assert_eq!(
            relay_mouse_position_px((10, 20), MouseKind::ScrollUp, 8, 9, false, false, grid),
            (75, 170)
        );
        // Only wheels: clicks focus the pane first, so they stay untouched.
        assert_eq!(
            relay_mouse_position_px((10, 20), MouseKind::Down, 8, 9, false, true, grid),
            (7, 8)
        );
    }
}

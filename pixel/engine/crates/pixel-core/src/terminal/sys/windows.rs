#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::cell::Cell;
use std::io::{self, Read as _, Write as _};
use std::os::windows::io::{AsRawHandle as _, AsRawSocket as _};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Networking::WinSock::{POLLRDNORM, SOCKET, WSAPOLLFD, WSAPoll};
use windows_sys::Win32::System::Console::{
    CONSOLE_MODE, CONSOLE_SCREEN_BUFFER_INFO, DISABLE_NEWLINE_AUTO_RETURN, ENABLE_EXTENDED_FLAGS,
    ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WINDOW_INPUT,
    GetConsoleMode, GetConsoleScreenBufferInfo, GetStdHandle, INPUT_RECORD, KEY_EVENT,
    PeekConsoleInputW, ReadConsoleInputW, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetConsoleMode,
    WINDOW_BUFFER_SIZE_EVENT,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects,
};

use super::super::{TtyHandle, WindowSize};

#[path = "windows_relay.rs"]
pub(crate) mod relay;

pub(crate) type HostStream = uds_windows::UnixStream;

#[cfg(test)]
pub(crate) type HostListener = uds_windows::UnixListener;

const SOCKET_POLL_SLICE: Duration = Duration::from_millis(10);
const PIPE_POLL_SLICE: Duration = Duration::from_millis(2);

#[derive(Clone, Copy)]
pub(crate) struct ConsoleModes {
    input: CONSOLE_MODE,
    output: CONSOLE_MODE,
}

// A relayed terminal arrives as a pipe, which has no console modes to change.
pub(in crate::terminal) struct RawMode(Option<ConsoleModes>);

pub(crate) fn enter_console_raw_mode() -> io::Result<ConsoleModes> {
    let step = |name: &str, error: io::Error| io::Error::new(error.kind(), format!("{name}: {error}"));
    let input = std_handle(STD_INPUT_HANDLE);
    let output = std_handle(STD_OUTPUT_HANDLE);
    let saved = ConsoleModes {
        input: console_mode(input).map_err(|e| step("GetConsoleMode(input)", e))?,
        output: console_mode(output).map_err(|e| step("GetConsoleMode(output)", e))?,
    };
    set_console_mode(input, ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT | ENABLE_EXTENDED_FLAGS)
        .map_err(|e| step("SetConsoleMode(input)", e))?;
    set_console_mode(output, saved.output | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN)
        .map_err(|e| step("SetConsoleMode(output)", e))?;
    Ok(saved)
}

pub(crate) fn leave_console_raw_mode(saved: ConsoleModes) {
    let _ = set_console_mode(std_handle(STD_INPUT_HANDLE), saved.input);
    let _ = set_console_mode(std_handle(STD_OUTPUT_HANDLE), saved.output);
}

fn std_handle(which: u32) -> HANDLE {
    unsafe { GetStdHandle(which) }
}

fn console_mode(handle: HANDLE) -> io::Result<CONSOLE_MODE> {
    let mut mode: CONSOLE_MODE = 0;
    if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(mode)
}

fn set_console_mode(handle: HANDLE, mode: CONSOLE_MODE) -> io::Result<()> {
    if unsafe { SetConsoleMode(handle, mode) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// Electron is a GUI program on Windows, so it starts detached from the console of the
// shell that launched it and has to join that console before it can draw in it.
pub(in crate::terminal) fn attach_console() -> io::Result<()> {
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole, SetStdHandle};

    if console_mode(std_handle(STD_INPUT_HANDLE)).is_ok() && console_mode(std_handle(STD_OUTPUT_HANDLE)).is_ok() {
        return Ok(());
    }
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
    for (name, which) in [("CONIN$", STD_INPUT_HANDLE), ("CONOUT$", STD_OUTPUT_HANDLE)] {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::other(format!("open {name}: {}", io::Error::last_os_error())));
        }
        if unsafe { SetStdHandle(which, handle) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

impl TtyHandle {
    pub(in crate::terminal) fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            TtyHandle::Stdio { stdin, .. } => read_console(stdin.as_raw_handle() as HANDLE, buf),
            TtyHandle::File(file) => (&*file).read(buf),
            TtyHandle::Hosted { stream, .. } | TtyHandle::Embedded { stream, .. } => {
                (&*stream).read(buf)
            }
        }
    }

    pub(in crate::terminal) fn enter_raw_mode(&self) -> io::Result<RawMode> {
        match self {
            TtyHandle::File(_) => Ok(RawMode(None)),
            _ => Ok(RawMode(Some(enter_console_raw_mode()?))),
        }
    }

    pub(in crate::terminal) fn leave_raw_mode(&self, saved: &RawMode) {
        if let RawMode(Some(modes)) = saved {
            leave_console_raw_mode(*modes);
        }
    }

    pub(in crate::terminal) fn window_size(&self) -> io::Result<WindowSize> {
        let output = match self {
            TtyHandle::File(file) => file.as_raw_handle() as HANDLE,
            _ => std_handle(STD_OUTPUT_HANDLE),
        };
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
        if unsafe { GetConsoleScreenBufferInfo(output, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(window_size_of(&info))
    }

    pub(in crate::terminal) fn unread_output(&self) -> Option<usize> {
        None
    }

    pub(in crate::terminal) fn wait_readable(
        &self,
        wake: Option<&WakeRx>,
        wait: Option<Duration>,
    ) -> io::Result<bool> {
        match self {
            TtyHandle::Stdio { .. } => wait_console(std_handle(STD_INPUT_HANDLE), wake, wait),
            TtyHandle::File(file) => wait_polling(|slice| pipe_readable(file.as_raw_handle() as HANDLE, slice), wake, wait),
            TtyHandle::Hosted { stream, .. } | TtyHandle::Embedded { stream, .. } => {
                let socket = stream.as_raw_socket() as SOCKET;
                wait_polling(|slice| socket_readable(socket, slice.as_millis() as i32), wake, wait)
            }
        }
    }
}

fn window_size_of(info: &CONSOLE_SCREEN_BUFFER_INFO) -> WindowSize {
    let cols = i32::from(info.srWindow.Right) - i32::from(info.srWindow.Left) + 1;
    let rows = i32::from(info.srWindow.Bottom) - i32::from(info.srWindow.Top) + 1;
    WindowSize {
        cols: cols.max(0) as u32,
        rows: rows.max(0) as u32,
        width_px: 0,
        height_px: 0,
    }
}

fn wait_millis(deadline: Option<Instant>) -> u32 {
    match deadline {
        None => INFINITE,
        Some(at) => at
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u128::from(INFINITE - 1)) as u32,
    }
}

thread_local! {
    static HIGH_SURROGATE: Cell<Option<u16>> = const { Cell::new(None) };
}

// With virtual terminal input on, every keystroke and every terminal reply arrives as
// key-down records carrying one UTF-16 unit each, so the bytes match what a Unix tty delivers.
fn record_text(record: &INPUT_RECORD, out: &mut Vec<u8>) {
    if u32::from(record.EventType) == WINDOW_BUFFER_SIZE_EVENT as u32 {
        notify_resize();
        return;
    }
    if u32::from(record.EventType) != KEY_EVENT as u32 {
        return;
    }
    let key = unsafe { &record.Event.KeyEvent };
    if key.bKeyDown == 0 {
        return;
    }
    let unit = unsafe { key.uChar.UnicodeChar };
    if unit == 0 {
        return;
    }
    for _ in 0..key.wRepeatCount.max(1) {
        push_utf16(unit, out);
    }
}

fn push_utf16(unit: u16, out: &mut Vec<u8>) {
    let units = match HIGH_SURROGATE.take() {
        Some(high) => vec![high, unit],
        None if (0xD800..0xDC00).contains(&unit) => {
            HIGH_SURROGATE.set(Some(unit));
            return;
        }
        None => vec![unit],
    };
    for c in char::decode_utf16(units) {
        let mut bytes = [0u8; 4];
        out.extend_from_slice(
            c.unwrap_or(char::REPLACEMENT_CHARACTER)
                .encode_utf8(&mut bytes)
                .as_bytes(),
        );
    }
}

fn is_text(record: &INPUT_RECORD) -> bool {
    u32::from(record.EventType) == KEY_EVENT as u32 && {
        let key = unsafe { &record.Event.KeyEvent };
        key.bKeyDown != 0 && unsafe { key.uChar.UnicodeChar } != 0
    }
}

fn read_console(input: HANDLE, buf: &mut [u8]) -> io::Result<usize> {
    let capacity = (buf.len() / 4).max(1);
    let mut records: Vec<INPUT_RECORD> = vec![unsafe { std::mem::zeroed() }; capacity];
    let mut text = Vec::with_capacity(buf.len());
    loop {
        let mut read = 0u32;
        if unsafe { ReadConsoleInputW(input, records.as_mut_ptr(), capacity as u32, &mut read) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        for record in &records[..read as usize] {
            record_text(record, &mut text);
        }
        if !text.is_empty() {
            let n = text.len().min(buf.len());
            buf[..n].copy_from_slice(&text[..n]);
            return Ok(n);
        }
    }
}

fn console_has_text(input: HANDLE) -> io::Result<bool> {
    let mut records: Vec<INPUT_RECORD> = vec![unsafe { std::mem::zeroed() }; 64];
    loop {
        let mut seen = 0u32;
        if unsafe {
            PeekConsoleInputW(input, records.as_mut_ptr(), records.len() as u32, &mut seen)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if seen == 0 {
            return Ok(false);
        }
        if records[..seen as usize].iter().any(is_text) {
            return Ok(true);
        }
        let mut discarded = 0u32;
        if unsafe { ReadConsoleInputW(input, records.as_mut_ptr(), seen, &mut discarded) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut ignored = Vec::new();
        for record in &records[..discarded as usize] {
            record_text(record, &mut ignored);
        }
    }
}

fn wait_console(input: HANDLE, wake: Option<&WakeRx>, wait: Option<Duration>) -> io::Result<bool> {
    let deadline = wait.map(|w| Instant::now() + w);
    let handles: Vec<HANDLE> = std::iter::once(input)
        .chain(wake.map(|w| w.event.0))
        .collect();
    loop {
        if console_has_text(input)? {
            return Ok(true);
        }
        let result = unsafe {
            WaitForMultipleObjects(
                handles.len() as u32,
                handles.as_ptr(),
                0,
                wait_millis(deadline),
            )
        };
        match result {
            WAIT_TIMEOUT => return Ok(false),
            r if r == WAIT_OBJECT_0 => continue,
            r if r == WAIT_OBJECT_0 + 1 => return console_has_text(input),
            _ => return Err(io::Error::last_os_error()),
        }
    }
}

fn socket_readable(socket: SOCKET, millis: i32) -> io::Result<bool> {
    let mut fd = WSAPOLLFD {
        fd: socket,
        events: POLLRDNORM,
        revents: 0,
    };
    let n = unsafe { WSAPoll(&mut fd, 1, millis) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(n > 0)
}

// A broken pipe counts as readable, so the next read reports the end of the stream.
fn pipe_readable(pipe: HANDLE, slice: Duration) -> io::Result<bool> {
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;
    let mut available = 0u32;
    if unsafe { PeekNamedPipe(pipe, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut available, std::ptr::null_mut()) } == 0 {
        return Ok(true);
    }
    if available > 0 {
        return Ok(true);
    }
    std::thread::sleep(slice.min(PIPE_POLL_SLICE));
    Ok(false)
}

fn wait_polling(
    mut ready: impl FnMut(Duration) -> io::Result<bool>,
    wake: Option<&WakeRx>,
    wait: Option<Duration>,
) -> io::Result<bool> {
    let deadline = wait.map(|w| Instant::now() + w);
    loop {
        let slice = match deadline {
            Some(at) => at.saturating_duration_since(Instant::now()).min(SOCKET_POLL_SLICE),
            None => SOCKET_POLL_SLICE,
        };
        if ready(slice)? {
            return Ok(true);
        }
        if wake.is_some_and(WakeRx::take) || deadline.is_some_and(|at| Instant::now() >= at) {
            return Ok(false);
        }
    }
}

pub(in crate::terminal) fn open_tty(path: &str) -> io::Result<std::fs::File> {
    std::fs::File::options().read(true).write(true).open(path)
}

pub(in crate::terminal) fn open_embedded_tty(path: &str) -> io::Result<std::fs::File> {
    open_tty(path)
}

pub(in crate::terminal) fn cell_size_of_tty(_tty: &std::fs::File) -> Option<(u32, u32)> {
    None
}

struct Event(HANDLE);

unsafe impl Send for Event {}
unsafe impl Sync for Event {}

impl Event {
    fn auto_reset() -> io::Result<Self> {
        let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub(in crate::terminal) struct WakeRx {
    event: std::sync::Arc<Event>,
}

impl WakeRx {
    fn event_handle(&self) -> HANDLE {
        self.event.0
    }

    fn take(&self) -> bool {
        unsafe { WaitForMultipleObjects(1, &self.event.0, 0, 0) == WAIT_OBJECT_0 }
    }

    pub(in crate::terminal) fn wait(&self, wait: Option<Duration>) -> io::Result<()> {
        let deadline = wait.map(|w| Instant::now() + w);
        let result = unsafe { WaitForMultipleObjects(1, &self.event.0, 0, wait_millis(deadline)) };
        if result != WAIT_OBJECT_0 && result != WAIT_TIMEOUT {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

pub(crate) struct WakeTx {
    event: std::sync::Arc<Event>,
}

impl WakeTx {
    pub(crate) fn wake(&self) {
        unsafe { SetEvent(self.event.0) };
    }
}

pub(in crate::terminal) fn wake_pair() -> io::Result<(WakeRx, WakeTx)> {
    let event = std::sync::Arc::new(Event::auto_reset()?);
    Ok((
        WakeRx {
            event: event.clone(),
        },
        WakeTx { event },
    ))
}

static RESIZE_WATCHERS: Mutex<Vec<(u64, std::sync::Arc<Event>)>> = Mutex::new(Vec::new());
static NEXT_RESIZE_WATCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn notify_resize() {
    if let Ok(watchers) = RESIZE_WATCHERS.lock() {
        for (_, event) in watchers.iter() {
            unsafe { SetEvent(event.0) };
        }
    }
}

pub(in crate::terminal) struct ResizeWatch(u64);

impl Drop for ResizeWatch {
    fn drop(&mut self) {
        if let Ok(mut watchers) = RESIZE_WATCHERS.lock() {
            watchers.retain(|(id, _)| *id != self.0);
        }
    }
}

pub(in crate::terminal) fn watch_resize(tx: &WakeTx) -> io::Result<ResizeWatch> {
    let id = NEXT_RESIZE_WATCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    RESIZE_WATCHERS
        .lock()
        .map_err(|_| io::Error::other("resize watchers poisoned"))?
        .push((id, tx.event.clone()));
    Ok(ResizeWatch(id))
}

pub(crate) struct FrameFile {
    pub(crate) path: std::path::PathBuf,
    file: std::fs::File,
    pub(crate) len: usize,
    scratch: Vec<u8>,
}

impl FrameFile {
    pub(crate) fn create(path: std::path::PathBuf, len: usize) -> io::Result<Self> {
        let _ = std::fs::remove_file(&path);
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.set_len(len as u64)?;
        Ok(Self {
            path,
            file,
            len,
            scratch: Vec::new(),
        })
    }

    fn overwrite(&mut self, data: &[u8]) {
        use std::os::windows::fs::FileExt as _;
        let _ = self.file.seek_write(data, 0);
    }

    pub(crate) fn write(&mut self, data: &[u8]) {
        let len = self.len.min(data.len());
        self.overwrite(&data[..len]);
    }

    pub(crate) fn write_bgra(&mut self, data: &[u8]) {
        let len = self.len.min(data.len());
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.resize(len, 0);
        super::swap_bgra_into(&mut scratch, &data[..len]);
        self.overwrite(&scratch);
        self.scratch = scratch;
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for FrameFile {
    fn drop(&mut self) {
        let _ = self.file.flush();
        let _ = std::fs::remove_file(&self.path);
    }
}

fn no_shared_memory() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "terminals on Windows take no shared memory frames",
    )
}

pub(crate) fn write_shm(_name: &str, _data: &[u8]) -> io::Result<()> {
    Err(no_shared_memory())
}

pub(crate) fn unlink_shm(_name: &str) {}

pub(in crate::terminal) struct Shm;

pub(in crate::terminal) fn open_shm(_name: &str, _len: usize) -> io::Result<Shm> {
    Err(no_shared_memory())
}

pub(in crate::terminal) fn fill_shm(
    _shm: &Shm,
    _len: usize,
    _fill: impl FnOnce(&mut [u8]),
) -> io::Result<()> {
    Err(no_shared_memory())
}

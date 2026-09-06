#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::io::{self, Read as _};
use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    FALSE, HANDLE, INVALID_HANDLE_VALUE, TRUE, WAIT_FAILED, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Console::{
    ATTACH_PARENT_PROCESS, AttachConsole, CONSOLE_MODE, CONSOLE_SCREEN_BUFFER_INFO,
    DISABLE_NEWLINE_AUTO_RETURN, ENABLE_ECHO_INPUT, STD_HANDLE,
    ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT, ENABLE_PROCESSED_OUTPUT,
    ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode,
    GetConsoleScreenBufferInfo, GetNumberOfConsoleInputEvents, GetStdHandle, INPUT_RECORD,
    KEY_EVENT, ReadConsoleInputW, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetConsoleMode,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, INFINITE, ResetEvent, SetEvent, WaitForMultipleObjects, WaitForSingleObject,
};

use crate::terminal::WindowSize;

#[derive(Clone)]
pub struct Waker {
    event: Arc<OwnedHandle>,
}

impl Waker {
    pub fn wake(&self) {
        unsafe { SetEvent(self.event.as_raw_handle()) };
    }
}

#[derive(Default)]
struct InputState {
    bytes: Vec<u8>,
    closed: bool,
}

// The console cannot tell us how many bytes are waiting, so a thread does the
// blocking reads and signals `ready` once bytes have arrived.
struct Input {
    state: Mutex<InputState>,
    ready: OwnedHandle,
}

impl Input {
    fn start(mut source: Box<dyn io::Read + Send>) -> io::Result<Arc<Self>> {
        let input = Arc::new(Self {
            state: Mutex::new(InputState::default()),
            ready: create_event(true)?,
        });
        let reader = Arc::clone(&input);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                let read = source.read(&mut chunk);
                if matches!(&read, Err(e) if e.kind() == io::ErrorKind::Interrupted) {
                    continue;
                }
                let mut state = reader.state.lock().unwrap();
                match read {
                    Ok(0) | Err(_) => state.closed = true,
                    Ok(n) => state.bytes.extend_from_slice(&chunk[..n]),
                }
                let closed = state.closed;
                unsafe { SetEvent(reader.ready.as_raw_handle()) };
                drop(state);
                if closed {
                    return;
                }
            }
        });
        Ok(input)
    }

    fn take(&self, buf: &mut [u8]) -> Option<usize> {
        let mut state = self.state.lock().unwrap();
        if state.bytes.is_empty() {
            return state.closed.then_some(0);
        }
        let n = buf.len().min(state.bytes.len());
        buf[..n].copy_from_slice(&state.bytes[..n]);
        state.bytes.drain(..n);
        if state.bytes.is_empty() && !state.closed {
            unsafe { ResetEvent(self.ready.as_raw_handle()) };
        }
        Some(n)
    }

    // A process has one console, so every terminal that reads it shares one
    // reader rather than racing the others for the same bytes. That holds
    // however the console was reached: a reader started for one terminal
    // outlives it, and a second reader would take turns with the first,
    // losing every other keypress to a terminal nobody is using any more.
    fn console(
        open: impl FnOnce() -> io::Result<Box<dyn io::Read + Send>>,
    ) -> io::Result<Arc<Self>> {
        static CONSOLE: Mutex<Option<Arc<Input>>> = Mutex::new(None);
        let mut shared = CONSOLE.lock().unwrap();
        if let Some(input) = shared.as_ref() {
            return Ok(Arc::clone(input));
        }
        let input = Self::start(open()?)?;
        *shared = Some(Arc::clone(&input));
        Ok(input)
    }

    fn waiting(&self) -> bool {
        let state = self.state.lock().unwrap();
        !state.bytes.is_empty() || state.closed
    }
}

enum Out {
    Stdout(io::Stdout),
    File(std::fs::File),
}

pub(crate) struct Tty {
    out: Out,
    /// The console itself, when what this program was handed was not it.
    console: Option<std::fs::File>,
    console_in: HANDLE,
    console_out: HANDLE,
    saved_in: CONSOLE_MODE,
    saved_out: CONSOLE_MODE,
    input: Arc<Input>,
    wake: Option<Arc<OwnedHandle>>,
    waker: Option<Waker>,
}

impl Tty {
    pub(crate) fn stdio() -> io::Result<Self> {
        adopt_parent_console();
        match console_of(STD_INPUT_HANDLE, "CONIN$")? {
            Given::Handed => Self::raw(
                unsafe { GetStdHandle(STD_INPUT_HANDLE) },
                unsafe { GetStdHandle(STD_OUTPUT_HANDLE) },
                Input::console(|| Ok(Box::new(io::stdin())))?,
                Out::Stdout(io::stdout()),
            ),
            Given::Opened(reading) => {
                let writing = match console_of(STD_OUTPUT_HANDLE, "CONOUT$")? {
                    Given::Opened(file) => Out::File(file),
                    Given::Handed => Out::Stdout(io::stdout()),
                };
                let console_out = match &writing {
                    Out::File(file) => file.as_raw_handle(),
                    Out::Stdout(_) => unsafe { GetStdHandle(STD_OUTPUT_HANDLE) },
                };
                let console_in = reading.as_raw_handle();
                let source = reading.try_clone()?;
                Self::raw(
                    console_in,
                    console_out,
                    Input::console(move || Ok(Box::new(source)))?,
                    writing,
                )
                .map(|tty| tty.holding(reading))
            }
        }
    }

    fn holding(mut self, console: std::fs::File) -> Self {
        self.console = Some(console);
        self
    }

    pub(crate) fn open(path: &str) -> io::Result<Self> {
        let file = std::fs::File::options().read(true).write(true).open(path)?;
        let source = file.try_clone()?;
        let handle = file.as_raw_handle();
        Self::raw(handle, handle, Input::start(Box::new(source))?, Out::File(file))
    }

    fn raw(
        console_in: HANDLE,
        console_out: HANDLE,
        input: Arc<Input>,
        out: Out,
    ) -> io::Result<Self> {
        let (saved_in, saved_out) = make_raw(console_in, console_out)?;
        Ok(Self {
            out,
            console: None,
            console_in,
            console_out,
            saved_in,
            saved_out,
            input,
            wake: None,
            waker: None,
        })
    }

    pub(crate) fn out(&mut self) -> &mut dyn io::Write {
        match &mut self.out {
            Out::Stdout(stdout) => stdout,
            Out::File(file) => file,
        }
    }

    pub(crate) fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if let Some(n) = self.input.take(buf) {
                return Ok(n);
            }
            self.wait_for_input(None)?;
        }
    }

    pub(crate) fn window_size(&self) -> io::Result<WindowSize> {
        window_size_of(self.console_out)
    }

    pub(crate) fn waker(&mut self) -> io::Result<Waker> {
        if let Some(waker) = &self.waker {
            return Ok(waker.clone());
        }
        let event = Arc::new(create_event(false)?);
        self.wake = Some(Arc::clone(&event));
        let waker = Waker { event };
        self.waker = Some(waker.clone());
        Ok(waker)
    }

    // The terminal reports resizes in band through mode 2048, so there is
    // nothing to watch for separately.
    pub(crate) fn watch_resize(&mut self) -> io::Result<()> {
        Ok(())
    }

    pub(crate) fn wait_for_input(&self, wait: Option<Duration>) -> io::Result<bool> {
        if self.input.waiting() {
            return Ok(true);
        }
        let mut events = [self.input.ready.as_raw_handle(); 2];
        let count = match &self.wake {
            Some(wake) => {
                events[1] = wake.as_raw_handle();
                2
            }
            None => 1,
        };
        let waited =
            unsafe { WaitForMultipleObjects(count, events.as_ptr(), FALSE, timeout_ms(wait)) };
        match waited {
            WAIT_FAILED => Err(io::Error::last_os_error()),
            signalled => Ok(signalled == WAIT_OBJECT_0),
        }
    }
}

impl Drop for Tty {
    fn drop(&mut self) {
        let _ = set_console_mode(self.console_in, self.saved_in);
        let _ = set_console_mode(self.console_out, self.saved_out);
    }
}

// A terminal cannot know how many bytes are waiting, so a thread does its
// blocking reads. A probe asks one question and leaves, and a thread it cannot
// stop would outlive it and take the answers meant for whoever asks next --
// including a child process handed the same console. So this reads the input
// records itself and leaves nothing behind.
pub(crate) struct Probe {
    output: std::fs::File,
    console_in: HANDLE,
    console_out: HANDLE,
    saved_in: CONSOLE_MODE,
    saved_out: CONSOLE_MODE,
    pending: std::collections::VecDeque<u8>,
    // Held because closing it would close the handle the fields above use.
    _input: std::fs::File,
}

impl Probe {
    pub(crate) fn probe() -> io::Result<Self> {
        adopt_parent_console();
        let input = std::fs::File::options().read(true).write(true).open("CONIN$")?;
        let output = std::fs::File::options().read(true).write(true).open("CONOUT$")?;
        let console_in = input.as_raw_handle();
        let console_out = output.as_raw_handle();
        let (saved_in, saved_out) = make_raw(console_in, console_out)?;
        Ok(Self {
            output,
            console_in,
            console_out,
            saved_in,
            saved_out,
            pending: std::collections::VecDeque::new(),
            _input: input,
        })
    }

    pub(crate) fn out(&mut self) -> &mut dyn io::Write {
        &mut self.output
    }

    pub(crate) fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let taken = buf.len().min(self.pending.len());
        for slot in buf.iter_mut().take(taken) {
            *slot = self.pending.pop_front().expect("checked the length");
        }
        Ok(taken)
    }

    pub(crate) fn window_size(&self) -> io::Result<WindowSize> {
        window_size_of(self.console_out)
    }

    pub(crate) fn wait_for_input(&mut self, wait: Option<Duration>) -> io::Result<bool> {
        let deadline = wait.map(|wait| Instant::now() + wait);
        loop {
            if !self.pending.is_empty() {
                return Ok(true);
            }
            let remaining = match deadline {
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Ok(false);
                    }
                    Some(left)
                }
                None => None,
            };
            match unsafe { WaitForSingleObject(self.console_in, timeout_ms(remaining)) } {
                WAIT_FAILED => return Err(io::Error::last_os_error()),
                WAIT_OBJECT_0 => self.collect()?,
                _ => return Ok(false),
            }
        }
    }

    // The console signals for every kind of event, so a wait that wakes may
    // still have no characters behind it.
    fn collect(&mut self) -> io::Result<()> {
        let mut waiting = 0u32;
        if unsafe { GetNumberOfConsoleInputEvents(self.console_in, &mut waiting) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if waiting == 0 {
            return Ok(());
        }
        let mut records = vec![unsafe { std::mem::zeroed::<INPUT_RECORD>() }; waiting as usize];
        let mut read = 0u32;
        if unsafe { ReadConsoleInputW(self.console_in, records.as_mut_ptr(), waiting, &mut read) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut units = Vec::new();
        for record in &records[..read as usize] {
            if u32::from(record.EventType) != KEY_EVENT {
                continue;
            }
            let key = unsafe { record.Event.KeyEvent };
            let unit = unsafe { key.uChar.UnicodeChar };
            if key.bKeyDown != 0 && unit != 0 {
                units.push(unit);
            }
        }
        for character in char::decode_utf16(units) {
            let character = character.unwrap_or(char::REPLACEMENT_CHARACTER);
            let mut bytes = [0u8; 4];
            self.pending.extend(character.encode_utf8(&mut bytes).as_bytes());
        }
        Ok(())
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let _ = set_console_mode(self.console_in, self.saved_in);
        let _ = set_console_mode(self.console_out, self.saved_out);
    }
}

enum Given {
    /// What the program was handed is the console.
    Handed,
    /// It was handed something else, so the console was opened by name.
    Opened(std::fs::File),
}

// A program started by one that opens windows is handed that program's idea of
// input, which is not the console even when there is one. Whatever it was
// handed, the console can still be opened by name once this process has joined
// it.
fn console_of(which: STD_HANDLE, name: &str) -> io::Result<Given> {
    let handed = unsafe { GetStdHandle(which) };
    if handed != INVALID_HANDLE_VALUE && console_mode(handed).is_ok() {
        return Ok(Given::Handed);
    }
    let file = std::fs::File::options().read(true).write(true).open(name)?;
    Ok(Given::Opened(file))
}

// A program that opens windows is given no console of its own, even when it
// was started from one and handed its handles, and the console calls below
// only answer for a console this process has joined.
fn adopt_parent_console() {
    let mut mode = 0;
    let input = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    if unsafe { GetConsoleMode(input, &mut mode) } != 0 {
        return;
    }
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
}

// Answers with the modes that were there, since whoever set raw puts them back.
fn make_raw(console_in: HANDLE, console_out: HANDLE) -> io::Result<(CONSOLE_MODE, CONSOLE_MODE)> {
    let saved_in = console_mode(console_in)?;
    let saved_out = console_mode(console_out)?;
    set_console_mode(
        console_in,
        (saved_in & !(ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT))
            | ENABLE_VIRTUAL_TERMINAL_INPUT,
    )?;
    set_console_mode(
        console_out,
        saved_out
            | ENABLE_PROCESSED_OUTPUT
            | ENABLE_VIRTUAL_TERMINAL_PROCESSING
            | DISABLE_NEWLINE_AUTO_RETURN,
    )?;
    Ok((saved_in, saved_out))
}

fn window_size_of(console_out: HANDLE) -> io::Result<WindowSize> {
    let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
    if unsafe { GetConsoleScreenBufferInfo(console_out, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let window = info.srWindow;
    Ok(WindowSize {
        cols: (window.Right - window.Left + 1).max(0) as u32,
        rows: (window.Bottom - window.Top + 1).max(0) as u32,
        width_px: 0,
        height_px: 0,
    })
}

fn console_mode(handle: HANDLE) -> io::Result<CONSOLE_MODE> {
    let mut mode = 0;
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

fn create_event(manual_reset: bool) -> io::Result<OwnedHandle> {
    let manual_reset = if manual_reset { TRUE } else { FALSE };
    let event = unsafe { CreateEventW(std::ptr::null(), manual_reset, FALSE, std::ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(event) })
}

fn timeout_ms(wait: Option<Duration>) -> u32 {
    match wait {
        None => INFINITE,
        Some(wait) => u32::try_from(wait.as_nanos().div_ceil(1_000_000))
            .unwrap_or(INFINITE)
            .min(INFINITE - 1),
    }
}

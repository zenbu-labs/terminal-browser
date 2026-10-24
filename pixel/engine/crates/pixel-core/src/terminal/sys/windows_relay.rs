use std::io;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
};
use windows_sys::Win32::System::Console::{
    CONSOLE_SCREEN_BUFFER_INFO, GetConsoleOutputCP, GetConsoleScreenBufferInfo, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    SetConsoleOutputCP,
};
use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, ResetEvent, WaitForMultipleObjects};

use super::{
    attach_console, console_has_text, enter_console_raw_mode, leave_console_raw_mode, read_console, std_handle, wake_pair,
    watch_resize, window_size_of,
};

const PIPE_BUFFER: u32 = 1 << 20;
const UTF8_CODE_PAGE: u32 = 65001;

struct Owned(HANDLE);

unsafe impl Send for Owned {}

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn manual_reset_event() -> io::Result<Owned> {
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(Owned(event))
}

// The default pipe security lets every user read, and pipe names can be listed, so another user
// could connect first and read the keys typed into this console; the relay's pipe admits only us.
fn owner_only_sddl() -> io::Result<String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Owned(token);
    let mut needed = 0u32;
    unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    if unsafe { GetTokenInformation(token.0, TokenUser, buffer.as_mut_ptr().cast(), needed, &mut needed) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut text: *mut u16 = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let length = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
    unsafe { LocalFree(text.cast()) };
    Ok(format!("D:P(A;;GA;;;{sid})"))
}

struct OwnerOnly(windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);

impl OwnerOnly {
    fn new() -> io::Result<Self> {
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        let sddl: Vec<u16> = owner_only_sddl()?.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut())
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }
}

impl Drop for OwnerOnly {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::LocalFree(self.0) };
    }
}

/// Carries this process's console to an engine that opened the pipe as its terminal: bytes the
/// engine writes go to the console, keys and terminal replies go back, and every console resize
/// is sent as an in-band size report.
pub struct ConsoleRelay {
    pipe: Owned,
}

impl ConsoleRelay {
    pub fn create(name: &str) -> io::Result<Self> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let owner_only = OwnerOnly::new()?;
        let attributes = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: owner_only.0,
            bInheritHandle: 0,
        };
        let pipe = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                PIPE_BUFFER,
                PIPE_BUFFER,
                0,
                &attributes,
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            return Err(io::Error::other(format!("create {name}: {}", io::Error::last_os_error())));
        }
        Ok(Self { pipe: Owned(pipe) })
    }

    fn connect(&self) -> io::Result<()> {
        let event = manual_reset_event()?;
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event.0;
        if unsafe { ConnectNamedPipe(self.pipe.0, &mut overlapped) } == 0 {
            match unsafe { GetLastError() } {
                ERROR_PIPE_CONNECTED => return Ok(()),
                ERROR_IO_PENDING => {
                    let mut ignored = 0u32;
                    if unsafe { GetOverlappedResult(self.pipe.0, &overlapped, &mut ignored, 1) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                _ => return Err(io::Error::last_os_error()),
            }
        }
        Ok(())
    }

    fn send(&self, bytes: &[u8]) -> io::Result<()> {
        let event = manual_reset_event()?;
        let mut sent = 0;
        while sent < bytes.len() {
            let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            overlapped.hEvent = event.0;
            let chunk = &bytes[sent..];
            let mut written = 0u32;
            let ok = unsafe { WriteFile(self.pipe.0, chunk.as_ptr(), chunk.len() as u32, std::ptr::null_mut(), &mut overlapped) };
            if ok == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
                return Err(io::Error::last_os_error());
            }
            if unsafe { GetOverlappedResult(self.pipe.0, &overlapped, &mut written, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            sent += written as usize;
        }
        Ok(())
    }

    /// Waits for the engine to connect, then relays until it closes the pipe.
    pub fn run(self) -> io::Result<()> {
        self.connect()?;
        attach_console()?;
        let modes = enter_console_raw_mode()?;
        let code_page = unsafe { GetConsoleOutputCP() };
        unsafe { SetConsoleOutputCP(UTF8_CODE_PAGE) };
        let relayed = self.relay();
        unsafe { SetConsoleOutputCP(code_page) };
        leave_console_raw_mode(modes);
        unsafe { DisconnectNamedPipe(self.pipe.0) };
        relayed
    }

    fn relay(&self) -> io::Result<()> {
        let input = std_handle(STD_INPUT_HANDLE);
        let output = std_handle(STD_OUTPUT_HANDLE);
        let (resized, resize_tx) = wake_pair()?;
        let _watch = watch_resize(&resize_tx)?;
        let arrived = manual_reset_event()?;
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = arrived.0;
        let mut buffer = vec![0u8; PIPE_BUFFER as usize];
        let mut keys = [0u8; 1024];

        let start_read = |overlapped: &mut OVERLAPPED, buffer: &mut [u8]| -> io::Result<bool> {
            unsafe { ResetEvent(arrived.0) };
            let ok = unsafe { ReadFile(self.pipe.0, buffer.as_mut_ptr(), buffer.len() as u32, std::ptr::null_mut(), overlapped) };
            if ok == 0 {
                match unsafe { GetLastError() } {
                    ERROR_IO_PENDING => {}
                    ERROR_BROKEN_PIPE => return Ok(false),
                    _ => return Err(io::Error::last_os_error()),
                }
            }
            Ok(true)
        };

        if !start_read(&mut overlapped, &mut buffer)? {
            return Ok(());
        }
        let handles = [arrived.0, input, resized.event_handle()];
        loop {
            let woke = unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE) };
            match woke {
                w if w == WAIT_OBJECT_0 => {
                    let mut read = 0u32;
                    if unsafe { GetOverlappedResult(self.pipe.0, &overlapped, &mut read, 0) } == 0 {
                        return match unsafe { GetLastError() } {
                            ERROR_BROKEN_PIPE => Ok(()),
                            _ => Err(io::Error::last_os_error()),
                        };
                    }
                    write_all(output, &buffer[..read as usize])?;
                    if !start_read(&mut overlapped, &mut buffer)? {
                        return Ok(());
                    }
                }
                w if w == WAIT_OBJECT_0 + 1 => {
                    if console_has_text(input)? {
                        let n = read_console(input, &mut keys)?;
                        self.send(&keys[..n])?;
                    }
                }
                w if w == WAIT_OBJECT_0 + 2 => {
                    let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
                    if unsafe { GetConsoleScreenBufferInfo(output, &mut info) } != 0 {
                        let size = window_size_of(&info);
                        self.send(&crate::terminal::resize_report(size.cols, size.rows))?;
                    }
                }
                _ => return Err(io::Error::last_os_error()),
            }
        }
    }
}

fn write_all(handle: HANDLE, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let mut written = 0u32;
        if unsafe { WriteFile(handle, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    fn name() -> String {
        format!(r"\\.\pipe\pixel-relay-test-{}-{}", std::process::id(), rand_suffix())
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn the_pipe_admits_only_the_user_running_the_relay() {
        let sddl = owner_only_sddl().unwrap();
        let sid = sddl.strip_prefix("D:P(A;;GA;;;").and_then(|rest| rest.strip_suffix(')')).unwrap();
        assert!(sid.starts_with("S-1-5-"), "{sddl}");
        assert!(!sid.contains('('), "one entry, for this user alone: {sddl}");
    }

    #[test]
    fn only_one_relay_can_own_a_pipe_name() {
        let name = name();
        let _first = ConsoleRelay::create(&name).unwrap();
        assert!(ConsoleRelay::create(&name).is_err(), "a second process must not take over the terminal");
    }

    #[test]
    fn an_engine_opening_the_pipe_talks_to_the_relay() {
        let name = name();
        let relay = ConsoleRelay::create(&name).unwrap();
        let engine = std::thread::spawn({
            let name = name.clone();
            move || {
                let mut pipe = std::fs::File::options().read(true).write(true).open(&name).unwrap();
                let mut got = [0u8; 5];
                pipe.read_exact(&mut got).unwrap();
                pipe.write_all(b"frame").unwrap();
                got
            }
        });
        relay.connect().unwrap();
        relay.send(b"\x1b[48;").unwrap();
        assert_eq!(&engine.join().unwrap(), b"\x1b[48;");
    }
}

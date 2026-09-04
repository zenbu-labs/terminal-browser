use std::io;
use std::time::{Duration, Instant};

use crate::terminal::{WindowSize, parse_cell_size_report, parse_probe_reply};
use crate::tty::{Tty, Waker};

/// The terminal as bytes and nothing else. What those bytes mean belongs to
/// Terminal. Only one of these at a time: they all reach the same console.
pub struct Console(Tty);

/// Nothing said is not the same as no.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Graphics {
    Supported,
    Unsupported,
    Unknown,
}

const PROBE_ID: u32 = 4207;

impl Console {
    pub fn open() -> io::Result<Self> {
        Ok(Self(Tty::stdio()?))
    }

    pub fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }

    pub fn wait(&self, until: Option<Duration>) -> io::Result<bool> {
        self.0.wait_for_input(until)
    }

    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.0.out().write_all(bytes)?;
        self.0.out().flush()
    }

    pub fn size(&self) -> io::Result<WindowSize> {
        self.0.window_size()
    }

    pub fn waker(&mut self) -> io::Result<Waker> {
        self.0.waker()
    }

    /// The only way to size the terminal in pixels where it reports zero.
    pub fn cell_size(&mut self, timeout_ms: u64) -> io::Result<Option<(u32, u32)>> {
        self.write(b"\x1b[16t")?;
        self.reply(timeout_ms, parse_cell_size_report)
    }

    pub fn graphics(&mut self, timeout_ms: u64) -> io::Result<Graphics> {
        let query = format!("\x1b_Gi={PROBE_ID},a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\\x1b[c");
        self.write(query.as_bytes())?;
        let needle = format!("Gi={PROBE_ID};");
        let answer = self.reply(timeout_ms, |buf| parse_probe_reply(buf, needle.as_bytes()))?;
        Ok(match answer {
            Some(true) => Graphics::Supported,
            Some(false) => Graphics::Unsupported,
            None => Graphics::Unknown,
        })
    }

    fn reply<T>(
        &mut self,
        timeout_ms: u64,
        parse: impl Fn(&[u8]) -> Option<T>,
    ) -> io::Result<Option<T>> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut buf = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || buf.len() > 256 {
                return Ok(None);
            }
            if !self.wait(Some(remaining))? {
                return Ok(None);
            }
            let mut chunk = [0u8; 64];
            let read = match self.read(&mut chunk) {
                Ok(0) => return Ok(None),
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            buf.extend_from_slice(&chunk[..read]);
            if let Some(found) = parse(&buf) {
                return Ok(Some(found));
            }
        }
    }
}

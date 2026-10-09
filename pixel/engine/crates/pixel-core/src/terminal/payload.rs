use std::io;
use std::time::{Duration, Instant};

use super::{FrameTransport, Terminal, fill_shm, open_shm};

const HANDOFF_STALE_AFTER: Duration = Duration::from_secs(3);
const HANDOFF_MAX_PENDING: usize = 4096;

pub(super) enum Payload {
    Shm(String),
    File(std::path::PathBuf),
}

impl Payload {
    fn remove(self) {
        match self {
            Payload::Shm(name) => {
                let _ = rustix::shm::unlink(&name);
            }
            Payload::File(path) => {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

#[derive(Default)]
pub(super) struct Payloads {
    seq: u64,
    pending: std::collections::VecDeque<(Instant, Payload)>,
}

impl Payloads {
    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn track(&mut self, payload: Payload) {
        self.remove_stale();
        self.pending.push_back((Instant::now(), payload));
    }

    pub(super) fn remove_stale(&mut self) {
        while let Some((at, _)) = self.pending.front() {
            if at.elapsed() < HANDOFF_STALE_AFTER && self.pending.len() <= HANDOFF_MAX_PENDING {
                break;
            }
            self.remove_front();
        }
    }

    pub(super) fn remove_all(&mut self) {
        while !self.pending.is_empty() {
            self.remove_front();
        }
    }

    fn remove_front(&mut self) {
        if let Some((_, payload)) = self.pending.pop_front() {
            payload.remove();
        }
    }
}

impl Terminal {
    pub(super) fn shm_name(&self, seq: u64) -> String {
        format!("/px-{}-{}-{seq}", std::process::id(), self.terminal_id)
    }

    fn temp_payload_path(&self, seq: u64) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "tty-graphics-protocol-px-{}-{}-{seq}.rgba",
            std::process::id(),
            self.terminal_id
        ))
    }

    fn hand_off_shm_with(&mut self, len: usize, fill: impl FnOnce(&mut [u8])) -> io::Result<String> {
        let seq = self.payloads.next_seq();
        let name = self.shm_name(seq);
        let fd = match open_shm(&name, len) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let _ = rustix::shm::unlink(&name);
                open_shm(&name, len)?
            }
            other => other?,
        };
        fill_shm(&fd, len, fill)?;
        self.payloads.track(Payload::Shm(name.clone()));
        Ok(name)
    }

    pub(crate) fn hand_off_shm(&mut self, data: &[u8]) -> io::Result<String> {
        self.hand_off_shm_with(data.len(), |out| out.copy_from_slice(data))
    }

    fn hand_off_temp_file(&mut self, data: &[u8]) -> io::Result<String> {
        let seq = self.payloads.next_seq();
        let path = self.temp_payload_path(seq);
        std::fs::write(&path, data)?;
        self.payloads.track(Payload::File(path.clone()));
        Ok(path.to_string_lossy().into_owned())
    }

    pub(crate) fn patch_medium(&self) -> Option<crate::kitty::Medium> {
        match self.transport {
            FrameTransport::Inline | FrameTransport::Host => None,
            FrameTransport::Shared => Some(crate::kitty::Medium::Shared),
            // Keep the negotiated t=f medium so every multiplexer client can read the patch.
            // Payloads already cleans up these files after the handoff grace period.
            FrameTransport::File => Some(crate::kitty::Medium::File),
        }
    }

    pub(crate) fn hand_off_payload(
        &mut self,
        medium: crate::kitty::Medium,
        len: usize,
        fill: impl FnOnce(&mut [u8]),
    ) -> io::Result<String> {
        match medium {
            crate::kitty::Medium::Shared => self.hand_off_shm_with(len, fill),
            crate::kitty::Medium::File => {
                let mut data = vec![0u8; len];
                fill(&mut data);
                self.hand_off_temp_file(&data)
            }
        }
    }

    pub(crate) fn hand_off_frame(&mut self, pixels: &[u8]) -> io::Result<Option<(crate::kitty::Medium, String)>> {
        Ok(match self.transport {
            FrameTransport::Inline | FrameTransport::Host => None,
            FrameTransport::Shared => Some((crate::kitty::Medium::Shared, self.hand_off_shm(pixels)?)),
            FrameTransport::File => Some((crate::kitty::Medium::File, self.write_frame_file(pixels)?)),
        })
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::surfaces::Rect;
    use crate::terminal::TtyHandle;
    use crate::wrapper::Wrapper;
    use base64::Engine as _;

    #[test]
    fn file_transport_patches_can_be_read_by_multiple_terminal_clients() {
        let (stream, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let mut terminal = Terminal::blank(
            TtyHandle::Hosted {
                stream,
                sink: io::sink(),
            },
            None,
            Wrapper::None,
            None,
        );
        terminal.transport = FrameTransport::File;
        terminal.cell = Some((14, 32));
        let mut out = Vec::new();
        terminal
            .place_image(
                &mut out,
                2,
                Rect {
                    x: 17,
                    y: 83,
                    w: 2,
                    h: 1,
                },
                2,
                false,
                |pixels| pixels.copy_from_slice(&[255, 0, 0, 255, 0, 255, 0, 255]),
            )
            .unwrap();
        let command = String::from_utf8(out).unwrap();
        assert!(
            command.contains("t=f,"),
            "patches must use the negotiated, reusable medium: {command}"
        );
        assert!(command.contains("X=3,Y=19"));
        let name = command
            .split_once("\x1b_G")
            .unwrap()
            .1
            .split_once(';')
            .unwrap()
            .1
            .strip_suffix("\x1b\\")
            .unwrap();
        let path = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(name)
                .unwrap(),
        )
        .unwrap();
        let expected = [255, 0, 0, 255, 0, 255, 0, 255];
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            expected,
            "a second client can read the same patch"
        );
        drop(terminal);
        assert!(
            !std::path::Path::new(&path).exists(),
            "producer cleans up the handoff file"
        );
    }
}

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct SurfaceFrame {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

pub enum SurfaceCommand {
    Frame(SurfaceFrame),
    Remove(u32),
}

pub struct SurfaceSubmission<'a> {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub bgra: &'a [u8],
}

enum Pending {
    Frame(SurfaceFrame),
    Remove,
}

#[derive(Default)]
struct Slot {
    pending: Option<Pending>,
    spare: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct SurfaceMailbox {
    slots: Mutex<HashMap<u32, Slot>>,
    submitted: AtomicU64,
    coalesced: AtomicU64,
    presented: AtomicU64,
    bytes: AtomicU64,
}

impl SurfaceMailbox {
    pub fn submit(&self, update: SurfaceSubmission<'_>) -> Result<(), String> {
        let row_bytes = update
            .width
            .checked_mul(4)
            .map(|bytes| bytes as usize)
            .ok_or_else(|| "surface dimensions overflow".to_string())?;
        let expected = row_bytes
            .checked_mul(update.height as usize)
            .ok_or_else(|| "surface dimensions overflow".to_string())?;
        let source_bytes = update
            .stride
            .checked_mul(update.height as usize)
            .ok_or_else(|| "surface dimensions overflow".to_string())?;
        if expected == 0 || update.stride < row_bytes || update.bgra.len() < source_bytes {
            return Err(format!(
                "surface buffer has {} bytes, expected {source_bytes}",
                update.bgra.len()
            ));
        }
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        let slot = slots.entry(update.id).or_default();
        let mut pixels = match slot.pending.take() {
            Some(Pending::Frame(frame)) => {
                self.coalesced.fetch_add(1, Ordering::Relaxed);
                frame.pixels
            }
            Some(Pending::Remove) | None => slot.spare.take().unwrap_or_default(),
        };
        convert_bgra(
            update.bgra,
            &mut pixels,
            row_bytes,
            update.height as usize,
            update.stride,
        );
        slot.pending = Some(Pending::Frame(SurfaceFrame {
            id: update.id,
            width: update.width,
            height: update.height,
            pixels,
        }));
        self.submitted.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(expected as u64, Ordering::Relaxed);
        Ok(())
    }

    pub fn remove(&self, id: u32) {
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        let slot = slots.entry(id).or_default();
        if let Some(Pending::Frame(frame)) = slot.pending.take() {
            slot.spare = Some(frame.pixels);
        }
        slot.pending = Some(Pending::Remove);
    }

    pub fn take(&self) -> Vec<SurfaceCommand> {
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        slots
            .iter_mut()
            .filter_map(|(&id, slot)| match slot.pending.take()? {
                Pending::Frame(frame) => Some(SurfaceCommand::Frame(frame)),
                Pending::Remove => Some(SurfaceCommand::Remove(id)),
            })
            .collect()
    }

    pub fn recycle(&self, frame: SurfaceFrame) {
        self.presented.fetch_add(1, Ordering::Relaxed);
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        let slot = slots.entry(frame.id).or_default();
        if slot.spare.is_none() {
            slot.spare = Some(frame.pixels);
        }
    }

    pub fn stats(&self) -> (u64, u64, u64, u64) {
        (
            self.submitted.load(Ordering::Relaxed),
            self.coalesced.load(Ordering::Relaxed),
            self.presented.load(Ordering::Relaxed),
            self.bytes.load(Ordering::Relaxed),
        )
    }
}

fn convert_bgra(src: &[u8], dst: &mut Vec<u8>, row_bytes: usize, height: usize, stride: usize) {
    dst.resize(row_bytes * height, 0);
    for row in 0..height {
        let source = &src[row * stride..row * stride + row_bytes];
        let target = &mut dst[row * row_bytes..(row + 1) * row_bytes];
        for (source, target) in source.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
            target[0] = source[2];
            target[1] = source[1];
            target[2] = source[0];
            target[3] = source[3];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_bgra_to_rgba() {
        let mut output = Vec::new();
        convert_bgra(&[1, 2, 3, 4, 10, 20, 30, 40], &mut output, 8, 1, 8);
        assert_eq!(output, [3, 2, 1, 4, 30, 20, 10, 40]);
    }

    #[test]
    fn converts_bgra_rows_with_padding() {
        let mut output = Vec::new();
        convert_bgra(
            &[1, 2, 3, 4, 0, 0, 0, 0, 10, 20, 30, 40, 0, 0, 0, 0],
            &mut output,
            4,
            2,
            8,
        );
        assert_eq!(output, [3, 2, 1, 4, 30, 20, 10, 40]);
    }

    #[test]
    fn keeps_only_the_latest_unpresented_frame() {
        let mailbox = SurfaceMailbox::default();
        mailbox
            .submit(SurfaceSubmission {
                id: 1,
                bgra: &[1, 2, 3, 4],
                width: 1,
                height: 1,
                stride: 4,
            })
            .unwrap();
        mailbox
            .submit(SurfaceSubmission {
                id: 1,
                bgra: &[5, 6, 7, 8],
                width: 1,
                height: 1,
                stride: 4,
            })
            .unwrap();
        let commands = mailbox.take();
        assert_eq!(commands.len(), 1);
        let SurfaceCommand::Frame(frame) = &commands[0] else {
            panic!("expected a frame");
        };
        assert_eq!(frame.pixels, [7, 6, 5, 8]);
        assert_eq!(mailbox.stats().1, 1);
    }
}

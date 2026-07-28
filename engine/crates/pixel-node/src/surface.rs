use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use pixel_core::surfaces::Rect;

pub enum SurfacePixels {
    #[cfg(target_os = "macos")]
    Texture(crate::iosurface::RetainedSurface),
    Owned {
        bgra: Vec<u8>,
        width: u32,
        height: u32,
    },
}

pub struct SurfaceFrame {
    pub id: u32,
    pub pixels: SurfacePixels,
    pub damage: Option<Rect>,
}

pub enum SurfaceCommand {
    Frame(SurfaceFrame),
    Remove(u32),
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
    rows: AtomicU64,
}

impl SurfaceMailbox {
    pub fn submit(&self, id: u32, pixels: SurfacePixels, damage: Option<Rect>) {
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        let slot = slots.entry(id).or_default();
        let damage: Option<Rect> = match slot.pending.take() {
            Some(Pending::Frame(dropped)) => {
                self.coalesced.fetch_add(1, Ordering::Relaxed);
                if let SurfacePixels::Owned { bgra, .. } = dropped.pixels {
                    slot.spare = Some(bgra);
                }
                match (dropped.damage, damage) {
                    (Some(a), Some(b)) => Some(a.union(b)),
                    _ => None,
                }
            }
            Some(Pending::Remove) | None => damage,
        };
        slot.pending = Some(Pending::Frame(SurfaceFrame { id, pixels, damage }));
        self.submitted.fetch_add(1, Ordering::Relaxed);
    }

    pub fn take_spare(&self, id: u32) -> Vec<u8> {
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        slots
            .entry(id)
            .or_default()
            .spare
            .take()
            .unwrap_or_default()
    }

    pub fn remove(&self, id: u32) {
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        let slot = slots.entry(id).or_default();
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

    pub fn recycle(&self, frame: SurfaceFrame, rows: u32) {
        self.presented.fetch_add(1, Ordering::Relaxed);
        self.rows.fetch_add(u64::from(rows), Ordering::Relaxed);
        if let SurfacePixels::Owned { bgra, .. } = frame.pixels {
            let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
            let slot = slots.entry(frame.id).or_default();
            if slot.spare.is_none() {
                slot.spare = Some(bgra);
            }
        }
    }

    pub fn stats(&self) -> (u64, u64, u64, u64) {
        (
            self.submitted.load(Ordering::Relaxed),
            self.coalesced.load(Ordering::Relaxed),
            self.presented.load(Ordering::Relaxed),
            self.rows.load(Ordering::Relaxed),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(byte: u8) -> SurfacePixels {
        SurfacePixels::Owned {
            bgra: vec![byte; 4],
            width: 1,
            height: 1,
        }
    }

    fn rect(x: u32, w: u32) -> Rect {
        Rect { x, y: 0, w, h: 1 }
    }

    #[test]
    fn keeps_only_the_latest_unpresented_frame() {
        let mailbox = SurfaceMailbox::default();
        mailbox.submit(1, owned(1), Some(rect(0, 1)));
        mailbox.submit(1, owned(2), Some(rect(0, 1)));
        let commands = mailbox.take();
        assert_eq!(commands.len(), 1);
        let SurfaceCommand::Frame(frame) = &commands[0] else {
            panic!("expected a frame");
        };
        let SurfacePixels::Owned { bgra, .. } = &frame.pixels else {
            panic!("expected owned pixels");
        };
        assert_eq!(bgra, &[2, 2, 2, 2]);
        assert_eq!(mailbox.stats().1, 1);
    }

    #[test]
    fn dropping_a_frame_carries_its_damage_into_the_next_one() {
        let mailbox = SurfaceMailbox::default();
        mailbox.submit(1, owned(1), Some(rect(0, 2)));
        mailbox.submit(1, owned(2), Some(rect(8, 2)));
        let commands = mailbox.take();
        let SurfaceCommand::Frame(frame) = &commands[0] else {
            panic!("expected a frame");
        };
        assert_eq!(frame.damage, Some(rect(0, 10)));
    }

    #[test]
    fn an_unknown_damage_region_poisons_the_union() {
        let mailbox = SurfaceMailbox::default();
        mailbox.submit(1, owned(1), None);
        mailbox.submit(1, owned(2), Some(rect(8, 2)));
        let commands = mailbox.take();
        let SurfaceCommand::Frame(frame) = &commands[0] else {
            panic!("expected a frame");
        };
        assert_eq!(frame.damage, None);
    }

    #[test]
    fn a_dropped_buffer_comes_back_as_scratch() {
        let mailbox = SurfaceMailbox::default();
        mailbox.submit(1, owned(1), None);
        mailbox.submit(1, owned(2), None);
        assert_eq!(mailbox.take_spare(1).len(), 4);
        assert_eq!(mailbox.take_spare(1).len(), 0);
    }
}

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pixel_core::backend::{Backend, Event, Frame, HostInfo, Metrics, Waker};
use pixel_core::HostColors;

use crate::{Caret, CellPresenter, ColorTier};

#[derive(Default)]
struct Shared {
    events: VecDeque<Event>,
    text: String,
    caret: Option<Caret>,
    frames: Vec<Vec<u8>>,
}

#[derive(Clone, Default)]
pub struct TestHandle(Arc<Mutex<Shared>>);

impl TestHandle {
    pub fn send(&self, event: Event) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).events.push_back(event);
    }

    pub fn snapshot(&self) -> String {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).text.clone()
    }

    pub fn caret(&self) -> Option<Caret> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).caret
    }

    pub fn frames(&self) -> Vec<Vec<u8>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).frames.clone()
    }
}

pub struct TestBackend {
    presenter: CellPresenter,
    cell: (u32, u32),
    size: (u16, u16),
    colors: HostColors,
    handle: TestHandle,
}

impl TestBackend {
    pub fn new(size: (u16, u16), cell: (u32, u32), tier: ColorTier, colors: HostColors) -> (Self, TestHandle) {
        let handle = TestHandle::default();
        let backend = Self { presenter: CellPresenter::new(tier, colors, cell, size), cell, size, colors, handle: handle.clone() };
        (backend, handle)
    }
}

impl Backend for TestBackend {
    fn start(&mut self) -> io::Result<HostInfo> {
        Ok(HostInfo {
            metrics: Metrics { window: (self.size.0 as u32 * self.cell.0, self.size.1 as u32 * self.cell.1), cell: self.cell },
            colors: self.colors,
            device: crate::cell_device(self.cell, self.presenter.tier()),
        })
    }

    fn waker(&mut self) -> io::Result<Waker> {
        Ok(Waker::new(|| {}))
    }

    fn poll(&mut self, _timeout: Option<Duration>) -> io::Result<Option<Event>> {
        let event = self.handle.0.lock().unwrap_or_else(|e| e.into_inner()).events.pop_front();
        if let Some(Event::Colors(colors)) = &event {
            self.presenter.set_colors(*colors);
        }
        Ok(event)
    }

    fn present(&mut self, frame: Frame<'_>) -> io::Result<usize> {
        let mut out = Vec::new();
        self.presenter.present(&frame, &mut out);
        let mut shared = self.handle.0.lock().unwrap_or_else(|e| e.into_inner());
        shared.text = self.presenter.grid().text();
        shared.caret = self.presenter.caret();
        let written = out.len();
        shared.frames.push(out);
        Ok(written)
    }
}

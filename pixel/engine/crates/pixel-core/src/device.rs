use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::canvas::Frame;
use crate::terminal::{Event, TerminalColors, Waker, WindowSize};

pub trait DeviceHost: Send {
    fn present(&mut self, frame: &Frame<'_>) -> io::Result<usize>;
    fn write(&mut self, _data: &str) {}
    fn set_clipboard(&mut self, _text: &str) {}
    fn set_title(&mut self, _text: &str) {}
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeviceMetrics {
    pub width_px: u32,
    pub height_px: u32,
    pub cell: (u32, u32),
}

impl DeviceMetrics {
    fn window_size(&self) -> WindowSize {
        let (cw, ch) = (self.cell.0.max(1), self.cell.1.max(1));
        WindowSize {
            cols: (self.width_px / cw).max(1),
            rows: (self.height_px / ch).max(1),
            width_px: self.width_px,
            height_px: self.height_px,
        }
    }
}

#[derive(Default)]
struct Inbox {
    events: VecDeque<Event>,
    metrics: Option<DeviceMetrics>,
    waker: Option<Waker>,
}

#[derive(Clone, Default)]
pub struct DeviceInbox {
    shared: Arc<Mutex<Inbox>>,
}

impl DeviceInbox {
    pub fn push(&self, event: Event) {
        let mut inbox = self.lock();
        inbox.events.push_back(event);
        Self::wake(inbox);
    }

    pub fn resize(&self, metrics: DeviceMetrics) {
        let mut inbox = self.lock();
        inbox.metrics = Some(metrics);
        Self::wake(inbox);
    }

    fn wake(inbox: MutexGuard<'_, Inbox>) {
        let waker = inbox.waker.clone();
        drop(inbox);
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    fn pop(&self) -> Option<Event> {
        self.lock().events.pop_front()
    }

    fn metrics(&self) -> Option<DeviceMetrics> {
        self.lock().metrics
    }

    fn lock(&self) -> MutexGuard<'_, Inbox> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct DeviceConfig {
    pub host: Box<dyn DeviceHost>,
    pub inbox: DeviceInbox,
    pub metrics: DeviceMetrics,
    pub colors: TerminalColors,
}

pub struct DeviceIo {
    host: Box<dyn DeviceHost>,
    inbox: DeviceInbox,
    metrics: DeviceMetrics,
    colors: TerminalColors,
    wake_rx: rustix::fd::OwnedFd,
    waker: Waker,
}

impl DeviceIo {
    pub(crate) fn new(config: DeviceConfig) -> io::Result<Self> {
        let (wake_rx, waker) = Waker::pipe()?;
        {
            let mut inbox = config.inbox.lock();
            inbox.waker = Some(waker.clone());
            inbox.metrics.get_or_insert(config.metrics);
        }
        Ok(Self { host: config.host, inbox: config.inbox, metrics: config.metrics, colors: config.colors, wake_rx, waker })
    }

    pub(crate) fn draw(&mut self, frame: Frame<'_>) -> io::Result<usize> {
        self.host.present(&frame)
    }

    pub(crate) fn poll_event(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        if let Some(event) = self.inbox.pop() {
            return Ok(Some(event));
        }
        if timeout == Some(Duration::ZERO) {
            return Ok(None);
        }
        crate::terminal::wait_for_wake(&self.wake_rx, timeout)?;
        Ok(self.inbox.pop())
    }

    pub(crate) fn size(&self) -> WindowSize {
        self.current_metrics().window_size()
    }

    pub(crate) fn cell_size(&self) -> (u32, u32) {
        self.current_metrics().cell
    }

    fn current_metrics(&self) -> DeviceMetrics {
        self.inbox.metrics().unwrap_or(self.metrics)
    }

    pub(crate) fn colors(&self) -> TerminalColors {
        self.colors
    }

    pub(crate) fn waker(&self) -> Waker {
        self.waker.clone()
    }

    pub(crate) fn write(&mut self, data: &str) {
        self.host.write(data);
    }

    pub(crate) fn set_clipboard(&mut self, text: &str) {
        self.host.set_clipboard(text);
    }

    pub(crate) fn set_title(&mut self, text: &str) {
        self.host.set_title(text);
    }
}

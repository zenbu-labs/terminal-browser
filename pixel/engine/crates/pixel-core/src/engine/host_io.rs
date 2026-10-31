use std::io;
use std::time::{Duration, Instant};

#[cfg(feature = "device")]
use crate::device::DeviceIo;
use crate::terminal::{Event, Retarget, SessionEnv, Terminal, TerminalColors, Waker, WindowSize};

pub enum Io {
    Tty(Terminal),
    #[cfg(feature = "device")]
    Device(DeviceIo),
}

impl Io {
    pub fn tty(&self) -> Option<&Terminal> {
        match self {
            Io::Tty(term) => Some(term),
            #[cfg(feature = "device")]
            Io::Device(_) => None,
        }
    }

    pub fn tty_mut(&mut self) -> Option<&mut Terminal> {
        match self {
            Io::Tty(term) => Some(term),
            #[cfg(feature = "device")]
            Io::Device(_) => None,
        }
    }

    pub fn draw(&mut self, frame: crate::canvas::Frame<'_>) -> io::Result<usize> {
        match self {
            Io::Tty(term) => term.draw(frame),
            #[cfg(feature = "device")]
            Io::Device(device) => device.draw(frame),
        }
    }

    pub fn poll_event(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        match self {
            Io::Tty(term) => term.poll_event(timeout),
            #[cfg(feature = "device")]
            Io::Device(device) => device.poll_event(timeout),
        }
    }

    pub fn size(&self) -> io::Result<WindowSize> {
        match self {
            Io::Tty(term) => term.size(),
            #[cfg(feature = "device")]
            Io::Device(device) => Ok(device.size()),
        }
    }

    pub fn window(&self, ws: &WindowSize, cell: (u32, u32), cell_is_exact: bool) -> (u32, u32) {
        match self {
            Io::Tty(_) => super::window_from(ws, cell, cell_is_exact),
            #[cfg(feature = "device")]
            Io::Device(_) => (ws.width_px, ws.height_px),
        }
    }

    pub fn cell_size(&mut self) -> io::Result<Option<(u32, u32)>> {
        match self {
            Io::Tty(term) => term.cell_size(),
            #[cfg(feature = "device")]
            Io::Device(device) => Ok(Some(device.cell_size())),
        }
    }

    pub fn ask_cell_size(&mut self) -> io::Result<Option<(u32, u32)>> {
        match self {
            Io::Tty(term) => term.ask_cell_size(),
            #[cfg(feature = "device")]
            Io::Device(device) => Ok(Some(device.cell_size())),
        }
    }

    pub fn set_cell_size(&mut self, cell: (u32, u32)) {
        if let Some(term) = self.tty_mut() {
            term.set_cell_size(cell);
        }
    }

    pub fn query_colors(&mut self) -> io::Result<TerminalColors> {
        match self {
            Io::Tty(term) => term.query_colors(),
            #[cfg(feature = "device")]
            Io::Device(device) => Ok(device.colors()),
        }
    }

    pub fn request_colors(&mut self) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.request_colors(),
            #[cfg(feature = "device")]
            Io::Device(_) => Ok(()),
        }
    }

    pub fn waker(&mut self) -> io::Result<Waker> {
        match self {
            Io::Tty(term) => term.waker(),
            #[cfg(feature = "device")]
            Io::Device(device) => Ok(device.waker()),
        }
    }

    pub fn watch_resize(&mut self) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.watch_resize(),
            #[cfg(feature = "device")]
            Io::Device(_) => Ok(()),
        }
    }

    pub fn retarget(&mut self, target: Retarget, env: SessionEnv) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.retarget(target, env),
            #[cfg(feature = "device")]
            Io::Device(_) => Err(io::Error::new(io::ErrorKind::Unsupported, "a device host can't be retargeted")),
        }
    }

    pub fn set_title(&mut self, text: &str) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.set_title(text),
            #[cfg(feature = "device")]
            Io::Device(device) => {
                device.set_title(text);
                Ok(())
            }
        }
    }

    pub fn set_clipboard(&mut self, text: &str) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.set_clipboard(text),
            #[cfg(feature = "device")]
            Io::Device(device) => {
                device.set_clipboard(text);
                Ok(())
            }
        }
    }

    pub fn write_raw(&mut self, data: &str) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.write_raw(data),
            #[cfg(feature = "device")]
            Io::Device(device) => {
                device.write(data);
                Ok(())
            }
        }
    }

    pub fn set_pointer_shape(&mut self, shape: &str) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.set_pointer_shape(shape),
            #[cfg(feature = "device")]
            Io::Device(_) => Ok(()),
        }
    }

    pub fn request_clipboard(&mut self) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.request_clipboard(),
            #[cfg(feature = "device")]
            Io::Device(_) => Ok(()),
        }
    }

    pub fn clipboard_data_supported(&self) -> bool {
        self.tty().is_some_and(Terminal::clipboard_data_supported)
    }

    pub fn request_clipboard_types(&mut self) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.request_clipboard_types(),
            #[cfg(feature = "device")]
            Io::Device(_) => Ok(()),
        }
    }

    pub fn request_clipboard_data(&mut self, mime: &str) -> io::Result<()> {
        match self {
            Io::Tty(term) => term.request_clipboard_data(mime),
            #[cfg(feature = "device")]
            Io::Device(_) => Ok(()),
        }
    }

    pub fn kitty_keyboard(&self) -> bool {
        self.tty().is_none_or(Terminal::kitty_keyboard)
    }

    pub fn reports_pixel_mouse(&self) -> bool {
        self.tty().is_none_or(Terminal::reports_pixel_mouse)
    }

    pub fn reports_color_scheme(&self) -> bool {
        self.tty().is_some_and(Terminal::reports_color_scheme)
    }

    pub fn is_hosted(&self) -> bool {
        self.tty().is_some_and(Terminal::is_hosted)
    }

    pub fn is_embedded(&self) -> bool {
        self.tty().is_some_and(Terminal::is_embedded)
    }

    pub fn relayed(&self) -> bool {
        self.tty().is_some_and(Terminal::relayed)
    }

    pub fn draws_locally(&self) -> bool {
        self.tty().is_none_or(Terminal::draws_locally)
    }

    pub fn frames_are_inline(&self) -> bool {
        self.tty().is_some_and(Terminal::frames_are_inline)
    }

    pub fn highlight_active(&self) -> bool {
        self.tty().is_some_and(Terminal::highlight_active)
    }

    pub fn idle_flatten_at(&self) -> Option<Instant> {
        self.tty().and_then(Terminal::idle_flatten_at)
    }

    pub fn overlay_due(&self) -> Option<Instant> {
        self.tty().and_then(Terminal::overlay_due)
    }

    pub fn tick_highlights(&mut self) -> io::Result<()> {
        self.tty_mut().map_or(Ok(()), Terminal::tick_highlights)
    }

    pub fn draw_overlay(&mut self) -> io::Result<()> {
        self.tty_mut().map_or(Ok(()), Terminal::draw_overlay)
    }

    pub fn flatten_if_idle(&mut self, frame: crate::canvas::Frame<'_>) -> io::Result<()> {
        self.tty_mut().map_or(Ok(()), |term| term.flatten_if_idle(frame))
    }

    pub fn set_overlay_font(&mut self, font: crate::fonts::Font) {
        if let Some(term) = self.tty_mut() {
            term.set_overlay_font(font);
        }
    }

    pub fn overlay_off(&mut self) -> io::Result<()> {
        self.tty_mut().map_or(Ok(()), Terminal::overlay_off)
    }

    pub fn note(&mut self, text: String) {
        if let Some(term) = self.tty_mut() {
            term.note(text);
        }
    }
}

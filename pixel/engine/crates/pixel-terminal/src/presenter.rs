use std::collections::VecDeque;
use std::io;
use std::time::Instant;

use pixel_core::backend::{Event, Frame};
use pixel_core::fonts::Font;
use pixel_core::{Device, Mouse};
use pixel_kitty::Kitty;
use pixel_kitty::native::Pane;

use crate::terminal::{DEFAULT_CELL, SessionEnv, Terminal, WindowSize};

const INLINE_BYTES_PER_SEC: f32 = 3_000_000.0;

pub(crate) trait Presenter: Send {
    fn name(&self) -> &'static str;
    fn device(&self, cell: (u32, u32)) -> Device;
    fn whole_cells(&self) -> bool;
    fn renew(&self, term: &mut Terminal, env: &SessionEnv) -> io::Result<Box<dyn Presenter>>;
    fn close(&mut self, term: &mut Terminal);

    fn present(&mut self, term: &mut Terminal, frame: Frame<'_>) -> io::Result<usize>;
    fn geometry(&mut self, ws: &WindowSize, cell: (u32, u32));
    fn resized(&mut self, term: &mut Terminal, cell_changed: bool, cell: (u32, u32)) -> io::Result<Option<Device>>;
    fn window_reported(&mut self) {}
    fn focused(&mut self, _term: &mut Terminal) -> io::Result<()> {
        Ok(())
    }
    fn colors(&mut self, _colors: pixel_core::backend::HostColors) {}

    fn pending_present(&self) -> bool {
        false
    }
    fn animating(&self) -> bool {
        false
    }
    fn before_frame(&mut self, _term: &mut Terminal) -> io::Result<()> {
        Ok(())
    }
    fn idle(&mut self, _term: &mut Terminal) -> io::Result<()> {
        Ok(())
    }
    fn spare(&mut self, _fonts: &[Font], _until: Instant) {}
    fn deadline(&self) -> Option<Instant> {
        None
    }
    fn schedule_present(&mut self, _at: Option<Instant>) {}
    fn take_presented_at(&mut self) -> Option<Instant> {
        None
    }
    fn byte_rate_limit(&self) -> Option<f32> {
        None
    }
    fn pointer_shape<'a>(&self, shape: &'a str) -> &'a str {
        shape
    }

    fn start_input(&mut self, _term: &mut Terminal) {}
    fn native_scroll(&self) -> bool {
        false
    }
    fn swallows(&mut self, _mouse: &Mouse, _extent: Pane, _pixel_mouse: bool) -> bool {
        false
    }
    fn drain_input(
        &mut self,
        _extent: Pane,
        _pixel_mouse: bool,
        _pointer: Option<(f32, f32)>,
        _last_pointer_activity: Option<Instant>,
        _queued: &mut VecDeque<Event>,
    ) {
    }

    fn note(&mut self, _text: String) {}
    fn overlay_font(&mut self, _font: Option<Font>) -> io::Result<()> {
        Ok(())
    }
    fn highlight_transmits(&mut self, _on: bool) {}
}

pub(crate) struct KittyPresenter {
    kitty: Kitty,
    raster: pixel_raster::Raster,
}

impl KittyPresenter {
    pub(crate) const PIXEL_MOUSE: bool = true;

    pub(crate) fn new(term: &mut Terminal, env: &SessionEnv) -> io::Result<Self> {
        let mut presenter = Self { kitty: Kitty::new(term, env)?, raster: pixel_raster::Raster::new() };
        presenter.relay(term);
        Ok(presenter)
    }

    fn relay(&mut self, term: &mut Terminal) {
        if let Some(cell) = self.kitty.take_cell_change() {
            term.set_cell_size(cell);
        }
        term.set_relay_cell(self.kitty.relay_cell());
    }
}

impl Presenter for KittyPresenter {
    fn name(&self) -> &'static str {
        "kitty"
    }

    fn device(&self, _cell: (u32, u32)) -> Device {
        Device::default()
    }

    fn whole_cells(&self) -> bool {
        false
    }

    fn renew(&self, term: &mut Terminal, env: &SessionEnv) -> io::Result<Box<dyn Presenter>> {
        Ok(Box::new(Self::new(term, env)?))
    }

    fn close(&mut self, _term: &mut Terminal) {
        self.kitty.close();
    }

    fn present(&mut self, term: &mut Terminal, frame: Frame<'_>) -> io::Result<usize> {
        self.kitty.sync(term);
        let options = pixel_raster::RasterOptions {
            scroll_layer: self.kitty.draws_layers(),
            direct: self.kitty.draws_locally(),
            host_surfaces: false,
        };
        let pixels = self.raster.render(&frame, options);
        let written = self.kitty.draw(term, pixels);
        self.relay(term);
        written
    }

    fn geometry(&mut self, _ws: &WindowSize, _cell: (u32, u32)) {}

    fn resized(&mut self, term: &mut Terminal, _cell_changed: bool, _cell: (u32, u32)) -> io::Result<Option<Device>> {
        self.kitty.retry_frame_transport(term, false)?;
        self.kitty.native().invalidate();
        Ok(None)
    }

    fn window_reported(&mut self) {
        self.kitty.window_changed();
    }

    fn focused(&mut self, term: &mut Terminal) -> io::Result<()> {
        self.kitty.retry_frame_transport(term, true)
    }

    fn pending_present(&self) -> bool {
        self.kitty.holds_a_frame()
    }

    fn animating(&self) -> bool {
        self.kitty.highlight_active()
    }

    fn before_frame(&mut self, term: &mut Terminal) -> io::Result<()> {
        self.kitty.sync(term);
        self.kitty.tick_highlights()?;
        self.kitty.draw_overlay()
    }

    fn idle(&mut self, term: &mut Terminal) -> io::Result<()> {
        self.kitty.sync(term);
        self.kitty.flatten_if_idle(self.raster.last())
    }

    fn spare(&mut self, fonts: &[Font], until: Instant) {
        pixel_raster::Raster::warm_glyphs(fonts, until);
    }

    fn deadline(&self) -> Option<Instant> {
        [self.kitty.idle_flatten_at(), self.kitty.overlay_due()].into_iter().flatten().min()
    }

    fn schedule_present(&mut self, at: Option<Instant>) {
        self.kitty.present_at(at);
    }

    fn take_presented_at(&mut self) -> Option<Instant> {
        self.kitty.take_ready_at()
    }

    fn byte_rate_limit(&self) -> Option<f32> {
        self.kitty.frames_are_inline().then_some(INLINE_BYTES_PER_SEC)
    }

    fn pointer_shape<'a>(&self, shape: &'a str) -> &'a str {
        self.kitty.pointer_shape(shape)
    }

    fn start_input(&mut self, term: &mut Terminal) {
        if term.is_hosted() && !term.is_embedded() {
            self.kitty.native().stop();
            return;
        }
        let waker = term.waker().ok().map(|waker| Box::new(move || waker.wake()) as pixel_kitty::native::Waker);
        self.kitty.native().start(waker);
    }

    fn native_scroll(&self) -> bool {
        self.kitty.native_active()
    }

    fn swallows(&mut self, mouse: &Mouse, extent: Pane, pixel_mouse: bool) -> bool {
        self.kitty.native().swallows(mouse, extent, pixel_mouse)
    }

    fn drain_input(
        &mut self,
        extent: Pane,
        pixel_mouse: bool,
        pointer: Option<(f32, f32)>,
        last_pointer_activity: Option<Instant>,
        queued: &mut VecDeque<Event>,
    ) {
        self.kitty.native().drain_native(extent, pixel_mouse, pointer, last_pointer_activity, queued);
    }

    fn note(&mut self, text: String) {
        self.kitty.note(text);
    }

    fn overlay_font(&mut self, font: Option<Font>) -> io::Result<()> {
        match font {
            Some(font) => {
                self.kitty.set_overlay_font(font);
                Ok(())
            }
            None => self.kitty.overlay_off(),
        }
    }

    fn highlight_transmits(&mut self, on: bool) {
        self.kitty.set_highlight_transmits(on);
    }
}

pub(crate) struct CellsPresenter {
    cells: pixel_cells::CellPresenter,
}

impl CellsPresenter {
    pub(crate) const PIXEL_MOUSE: bool = false;

    pub(crate) fn new(env: &SessionEnv) -> Self {
        let tier = pixel_cells::ColorTier::detect(|key| env.var(key));
        Self { cells: pixel_cells::CellPresenter::new(tier, Default::default(), DEFAULT_CELL, (80, 24)) }
    }
}

fn grid_of(ws: &WindowSize) -> (u16, u16) {
    let cols = if ws.cols > 0 { ws.cols } else { 80 };
    let rows = if ws.rows > 0 { ws.rows } else { 24 };
    (cols.min(u16::MAX as u32) as u16, rows.min(u16::MAX as u32) as u16)
}

impl Presenter for CellsPresenter {
    fn name(&self) -> &'static str {
        "cells"
    }

    fn device(&self, cell: (u32, u32)) -> Device {
        pixel_cells::cell_device(cell, self.cells.tier())
    }

    fn whole_cells(&self) -> bool {
        true
    }

    fn renew(&self, _term: &mut Terminal, env: &SessionEnv) -> io::Result<Box<dyn Presenter>> {
        Ok(Box::new(Self::new(env)))
    }

    fn close(&mut self, term: &mut Terminal) {
        let _ = term.write(b"\x1b[0m\x1b[0 q");
    }

    fn present(&mut self, term: &mut Terminal, frame: Frame<'_>) -> io::Result<usize> {
        let mut out = Vec::new();
        pixel_core::profiler::span("cells.encode", || self.cells.present(&frame, &mut out));
        term.write(&out)?;
        Ok(out.len())
    }

    fn geometry(&mut self, ws: &WindowSize, cell: (u32, u32)) {
        self.cells.set_geometry(cell, grid_of(ws));
    }

    fn resized(&mut self, _term: &mut Terminal, cell_changed: bool, cell: (u32, u32)) -> io::Result<Option<Device>> {
        Ok(cell_changed.then(|| self.device(cell)))
    }

    fn colors(&mut self, colors: pixel_core::backend::HostColors) {
        self.cells.set_colors(colors);
    }
}

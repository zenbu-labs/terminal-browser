use std::io;

use crate::canvas::Canvas;
use crate::terminal::HerdrTarget;

// Herdr talks over a unix socket, so on windows there is never one to talk to.
pub(crate) enum Herdr {}

impl Herdr {
    pub(crate) fn open(_target: &HerdrTarget, _instance: u64) -> Option<Self> {
        None
    }

    pub(crate) fn cell(&self) -> (u32, u32) {
        match *self {}
    }

    pub(crate) fn mouse_position_px(
        &self,
        _kind: crate::terminal::MouseKind,
        _x: u32,
        _y: u32,
        _focused: bool,
        _pixel_mouse: bool,
        _grid: impl FnOnce() -> Option<crate::terminal::WindowSize>,
    ) -> (u32, u32) {
        match *self {}
    }

    pub(crate) fn present(&mut self, _canvas: &Canvas) -> io::Result<usize> {
        match *self {}
    }
}

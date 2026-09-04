use napi::Result;
use napi::bindgen_prelude::Error;
use napi_derive::napi;
use pixel_core::Graphics;

use crate::err;

#[napi(object)]
pub struct CellSize {
    pub width: u32,
    pub height: u32,
}

// Windows cannot ask a terminal anything from a program that opens windows,
// because such a program is given no console to ask through. This opens one.
#[napi]
pub struct Console(Option<pixel_core::Console>);

#[napi]
impl Console {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self(Some(pixel_core::Console::open().map_err(err)?)))
    }

    #[napi]
    pub fn graphics(&mut self, timeout_ms: u32) -> Result<String> {
        let answer = self.open()?.graphics(u64::from(timeout_ms)).map_err(err)?;
        Ok(match answer {
            Graphics::Supported => "supported",
            Graphics::Unsupported => "unsupported",
            Graphics::Unknown => "unknown",
        }
        .to_owned())
    }

    #[napi]
    pub fn cell_size(&mut self, timeout_ms: u32) -> Result<Option<CellSize>> {
        let size = self.open()?.cell_size(u64::from(timeout_ms)).map_err(err)?;
        Ok(size.map(|(width, height)| CellSize { width, height }))
    }

    // Dropping restores the console modes, and waiting for the collector to do
    // it would leave the terminal raw in the meantime.
    #[napi]
    pub fn close(&mut self) {
        self.0 = None;
    }

    fn open(&mut self) -> Result<&mut pixel_core::Console> {
        self.0
            .as_mut()
            .ok_or_else(|| Error::from_reason("console is closed"))
    }
}

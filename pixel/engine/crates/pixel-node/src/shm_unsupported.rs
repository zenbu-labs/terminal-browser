pub struct ShmSurface {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

impl ShmSurface {
    pub fn from_region(
        _raw_fd: i32,
        _width: u32,
        _height: u32,
        _stride: u32,
        _size: u32,
    ) -> Result<Self, String> {
        Err("shared memory frames are only produced on Linux".to_string())
    }

    pub fn set_on_drop(&mut self, _hook: Box<dyn FnOnce() + Send>) {}

    pub fn pixels(&self) -> &[u8] {
        &[]
    }
}

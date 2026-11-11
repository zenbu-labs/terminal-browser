use std::sync::Arc;

use crate::scroll::ScrollProfile;
use crate::scroll::profiles::Smooth;
use crate::text_metrics::{FontMetrics, TextMetrics};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorDepth {
    TrueColor,
    Indexed256,
    Indexed16,
    Monochrome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pointer {
    Precise,
    Coarse,
}

#[derive(Clone)]
pub struct Device {
    pub name: String,
    pub text: Arc<dyn TextMetrics>,
    pub lattice: (f32, f32),
    pub scroll: Arc<dyn ScrollProfile>,
    pub colors: ColorDepth,
    pub pointer: Pointer,
}

impl Default for Device {
    fn default() -> Self {
        Self {
            name: "pixels".into(),
            text: Arc::new(FontMetrics),
            lattice: (1.0, 1.0),
            scroll: Arc::new(Smooth { tau: 0.08, brake: 0.025 }),
            colors: ColorDepth::TrueColor,
            pointer: Pointer::Precise,
        }
    }
}

impl std::fmt::Debug for Device {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Device")
            .field("name", &self.name)
            .field("lattice", &self.lattice)
            .field("scroll", &self.scroll)
            .field("colors", &self.colors)
            .field("pointer", &self.pointer)
            .finish()
    }
}

impl PartialEq for Device {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
            && Arc::ptr_eq(&self.text, &other.text)
            && self.lattice == other.lattice
            && Arc::ptr_eq(&self.scroll, &other.scroll)
            && self.colors == other.colors
            && self.pointer == other.pointer
    }
}

use super::{Engine, Io};
use crate::device::{SurfaceCover, SurfacePlacement};
use crate::tree::PxRect;

impl Engine {
    pub(super) fn native_views(&self) -> bool {
        matches!(&self.io, Io::Device(device) if device.native_views())
    }

    pub(super) fn place_native_views(&mut self) {
        let Io::Device(device) = &mut self.io else {
            return;
        };
        if !device.native_views() {
            return;
        }
        let rect = |r: PxRect, origin: f32| [r.x + origin, r.y, r.w, r.h];
        let mut surfaces = Vec::new();
        let mut covers = Vec::new();
        for i in self.comp.active_views() {
            let view = &self.comp.views[i];
            let origin = view.origin_x as f32;
            surfaces.extend(view.tree.surface_nodes().map(|(surface, abs, visible)| SurfacePlacement {
                surface,
                rect: rect(abs, origin),
                visible: rect(visible, origin),
            }));
            if view.tree.surface_nodes().next().is_some() {
                covers.extend(
                    crate::paint::native_view_covers(&view.tree)
                        .into_iter()
                        .map(|(surface, r, opaque)| SurfaceCover { surface, rect: rect(r, origin), opaque }),
                );
            }
        }
        device.place(surfaces, covers);
    }
}

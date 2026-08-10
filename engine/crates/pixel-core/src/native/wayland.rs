use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, Proxy as _, QueueHandle};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};

#[derive(Default, Clone, Copy)]
struct Screen {
    device_width: i32,
    logical_x: i32,
    logical_y: i32,
    logical_width: i32,
    logical_height: i32,
}

impl Screen {
    fn scale(self) -> Option<f32> {
        if self.device_width <= 0 || self.logical_width <= 0 {
            return None;
        }
        Some(self.device_width as f32 / self.logical_width as f32)
    }

    fn holds(self, (x, y): (i32, i32)) -> bool {
        self.logical_width > 0
            && self.logical_height > 0
            && x >= self.logical_x
            && y >= self.logical_y
            && x < self.logical_x + self.logical_width
            && y < self.logical_y + self.logical_height
    }
}

#[derive(Default)]
struct Screens {
    found: Vec<Screen>,
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Screens {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<zxdg_output_manager_v1::ZxdgOutputManagerV1, ()> for Screens {
    fn event(
        _: &mut Self,
        _: &zxdg_output_manager_v1::ZxdgOutputManagerV1,
        _: zxdg_output_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_output::WlOutput, usize> for Screens {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        index: &usize,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let wl_output::Event::Mode { width, .. } = event else {
            return;
        };
        if let Some(screen) = state.found.get_mut(*index) {
            screen.device_width = width;
        }
    }
}

impl Dispatch<zxdg_output_v1::ZxdgOutputV1, usize> for Screens {
    fn event(
        state: &mut Self,
        _: &zxdg_output_v1::ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        index: &usize,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(screen) = state.found.get_mut(*index) else {
            return;
        };
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => {
                screen.logical_x = x;
                screen.logical_y = y;
            }
            zxdg_output_v1::Event::LogicalSize { width, height } => {
                screen.logical_width = width;
                screen.logical_height = height;
            }
            _ => {}
        }
    }
}

/// The compositor reports each screen twice: `wl_output` in device pixels and
/// `xdg_output` in the logical pixels apps lay out with. Their ratio is the scale,
/// including fractional ones that `wl_output` alone rounds away.
fn screens() -> Vec<Screen> {
    let Ok(connection) = Connection::connect_to_env() else {
        return Vec::new();
    };
    let Ok((globals, mut queue)) = registry_queue_init::<Screens>(&connection) else {
        return Vec::new();
    };
    let handle = queue.handle();
    let Ok(manager) =
        globals.bind::<zxdg_output_manager_v1::ZxdgOutputManagerV1, _, _>(&handle, 1..=3, ())
    else {
        return Vec::new();
    };

    let mut screens = Screens::default();
    for global in globals.contents().clone_list() {
        if global.interface != wl_output::WlOutput::interface().name {
            continue;
        }
        let index = screens.found.len();
        screens.found.push(Screen::default());
        let output = globals.registry().bind::<wl_output::WlOutput, _, _>(
            global.name,
            global.version.min(4),
            &handle,
            index,
        );
        manager.get_xdg_output(&output, &handle, index);
    }

    // One round trip carries the wl_output events, the next the xdg_output ones.
    if queue.roundtrip(&mut screens).is_err() || queue.roundtrip(&mut screens).is_err() {
        return Vec::new();
    }
    screens.found
}

/// Screens can differ in scale, so a point on one of them picks the right answer.
/// Without a point the sharpest screen is the safer guess, since rendering too sharp
/// only costs pixels while too soft looks broken.
pub(super) fn scale_at(point: Option<(i32, i32)>) -> Option<f32> {
    let screens = screens();
    if let Some(point) = point
        && let Some(found) = screens.iter().find(|screen| screen.holds(point))
    {
        return found.scale();
    }
    screens
        .iter()
        .filter_map(|screen| screen.scale())
        .max_by(|a, b| a.total_cmp(b))
}

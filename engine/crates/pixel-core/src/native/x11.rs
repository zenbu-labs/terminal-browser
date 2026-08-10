use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use x11rb::connection::Connection as _;
use x11rb::protocol::Event;
use x11rb::protocol::xinput::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;

use super::{Msg, NativeEvent, PHASE_BEGAN, Point, Rect, publish};
use crate::logging;

const ALL_DEVICES: u16 = 0;
const ALL_MASTER_DEVICES: u16 = 1;

// XInput 2.4 numbers the pinch events 27..29; x11rb has no constants for them yet.
const PINCH_EVENTS: u32 = (1 << 27) | (1 << 28) | (1 << 29);

// what libinput's ScrollPixelDistance means by a click, so a click of finger travel
// turns back into the pixels the finger moved
const PIXELS_PER_CLICK: f32 = 15.0;

const CURSOR_INTERVAL: Duration = Duration::from_millis(11);
const WINDOW_RECHECK: Duration = Duration::from_millis(500);
const NEW_GESTURE_AFTER: Duration = Duration::from_millis(200);

pub(super) struct Handle {
    shared: Arc<Shared>,
}

impl Handle {
    pub(super) fn set_positions(&self, want: bool) {
        let mut armed = self.shared.armed.lock().unwrap();
        if *armed == want {
            return;
        }
        *armed = want;
        drop(armed);
        self.shared.resume.notify_all();
    }

    pub(super) fn cursor_point(&self) -> Option<(i32, i32)> {
        let ((x, y), _) = pointer(&self.shared)?;
        Some((x as i32, y as i32))
    }

    pub(super) fn stop(&self) {
        self.shared.stopped.store(true, Ordering::Relaxed);
        self.shared.resume.notify_all();
        self.shared.wake_pump();
    }
}

struct Shared {
    conn: RustConnection,
    root: xproto::Window,
    wake: xproto::Window,
    wake_atom: xproto::Atom,
    stopped: AtomicBool,
    armed: Mutex<bool>,
    resume: Condvar,
    scrollers: Mutex<HashMap<u16, Scroller>>,
    window: Mutex<WindowUnderCursor>,
}

impl Shared {
    /** Sends ourselves an event so the thread parked in wait_for_event notices the stop. */
    fn wake_pump(&self) {
        let event = xproto::ClientMessageEvent::new(32, self.wake, self.wake_atom, [0u32; 5]);
        let _ = self
            .conn
            .send_event(false, self.wake, xproto::EventMask::NO_EVENT, event);
        let _ = self.conn.flush();
    }
}

#[derive(Default)]
struct WindowUnderCursor {
    window: Option<xproto::Window>,
    rect: Option<Rect>,
    checked: Option<Instant>,
}

#[derive(Clone, Copy)]
struct Axis {
    number: u16,
    increment: f32,
}

#[derive(Clone, Copy, Default)]
struct Scroller {
    vertical: Option<Axis>,
    horizontal: Option<Axis>,
    precise: bool,
}

impl Scroller {
    fn deltas(&self, event: &xinput::RawMotionEvent) -> Option<(f32, f32)> {
        let mut delta = (0.0, 0.0);
        for (number, value) in axes(event) {
            if let Some(axis) = self.vertical.filter(|axis| axis.number == number) {
                delta.1 = self.travel(value, axis);
            } else if let Some(axis) = self.horizontal.filter(|axis| axis.number == number) {
                delta.0 = self.travel(value, axis);
            }
        }
        (delta != (0.0, 0.0)).then_some(delta)
    }

    /** Axes count in clicks: one per wheel detent, or one per 15px of finger travel. */
    fn travel(&self, value: f32, axis: Axis) -> f32 {
        if axis.increment == 0.0 {
            return value;
        }
        let clicks = value / axis.increment;
        match self.precise {
            true => clicks * PIXELS_PER_CLICK,
            false => clicks,
        }
    }
}

pub(super) fn start() -> Option<Handle> {
    std::env::var_os("DISPLAY")?;
    let (conn, screen) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen)?.root;

    let version = conn.xinput_xi_query_version(2, 4).ok()?.reply().ok()?;
    if version.major_version < 2 {
        return None;
    }
    // only one client at a time may watch a window's gestures, so give them up rather
    // than lose the scrolling too
    let mut pinch = (version.major_version, version.minor_version) >= (2, 4);
    if pinch && select_events(&conn, root, true).is_err() {
        pinch = false;
    }
    if !pinch {
        select_events(&conn, root, false).ok()?;
    }

    let wake = conn.generate_id().ok()?;
    conn.create_window(
        0,
        wake,
        root,
        -1,
        -1,
        1,
        1,
        0,
        xproto::WindowClass::INPUT_ONLY,
        x11rb::COPY_FROM_PARENT,
        &xproto::CreateWindowAux::new(),
    )
    .ok()?
    .check()
    .ok()?;
    let wake_atom = conn
        .intern_atom(false, b"TERMINAL_BROWSER_NATIVE_SCROLL")
        .ok()?
        .reply()
        .ok()?
        .atom;
    conn.flush().ok()?;

    let shared = Arc::new(Shared {
        conn,
        root,
        wake,
        wake_atom,
        stopped: AtomicBool::new(false),
        armed: Mutex::new(false),
        resume: Condvar::new(),
        scrollers: Mutex::new(HashMap::new()),
        window: Mutex::new(WindowUnderCursor::default()),
    });
    refresh_scrollers(&shared);
    logging::info(
        "engine",
        match pinch {
            true => "native scroll reading X11 input, pinch gestures on",
            false => "native scroll reading X11 input, pinch gestures unavailable",
        },
    );

    std::thread::spawn({
        let shared = Arc::clone(&shared);
        move || {
            pump(&shared);
            let asked_to_stop = shared.stopped.swap(true, Ordering::Relaxed);
            shared.resume.notify_all();
            if !asked_to_stop {
                super::source_died();
            }
        }
    });
    std::thread::spawn({
        let shared = Arc::clone(&shared);
        move || track_positions(&shared)
    });
    Some(Handle { shared })
}

fn select_events(conn: &RustConnection, root: xproto::Window, pinch: bool) -> Result<(), ()> {
    let mut mask =
        u32::from(xinput::XIEventMask::RAW_MOTION) | u32::from(xinput::XIEventMask::DEVICE_CHANGED);
    if pinch {
        mask |= PINCH_EVENTS;
    }
    let selections = [
        // the server only takes this one for every device at once
        xinput::EventMask {
            deviceid: ALL_DEVICES,
            mask: vec![u32::from(xinput::XIEventMask::HIERARCHY).into()],
        },
        xinput::EventMask {
            deviceid: ALL_MASTER_DEVICES,
            mask: vec![mask.into()],
        },
    ];
    conn.xinput_xi_select_events(root, &selections)
        .map_err(|_| ())?
        .check()
        .map_err(|_| ())
}

fn pump(shared: &Shared) {
    let mut last_precise: Option<Instant> = None;
    let mut pinching: HashMap<u16, f32> = HashMap::new();
    loop {
        let Ok(event) = shared.conn.wait_for_event() else {
            return;
        };
        if shared.stopped.load(Ordering::Relaxed) {
            return;
        }
        match event {
            Event::XinputRawMotion(event) => on_scroll(shared, &event, &mut last_precise),
            Event::XinputGesturePinchBegin(event) => {
                pinching.insert(event.deviceid, 1.0);
                if let Some((_, window)) = pointer(shared) {
                    note_window(shared, window, true);
                }
            }
            Event::XinputGesturePinchUpdate(event) => {
                let scale = fp1616(event.scale);
                if scale <= 0.0 {
                    continue;
                }
                // the scale is relative to the start of the gesture, so a gesture already
                // under way when we connected has no size to compare against yet
                let Some(previous) = pinching.insert(event.deviceid, scale).filter(|p| *p > 0.0)
                else {
                    continue;
                };
                let magnification = scale / previous - 1.0;
                if magnification == 0.0 {
                    continue;
                }
                publish(Msg::Event(NativeEvent::Zoom {
                    magnification,
                    point: Some((fp1616(event.root_x), fp1616(event.root_y))),
                }));
            }
            Event::XinputGesturePinchEnd(event) => {
                pinching.remove(&event.deviceid);
            }
            Event::XinputHierarchy(_) | Event::XinputDeviceChanged(_) => refresh_scrollers(shared),
            _ => {}
        }
    }
}

fn on_scroll(shared: &Shared, event: &xinput::RawMotionEvent, last_precise: &mut Option<Instant>) {
    let scroller = {
        let scrollers = shared.scrollers.lock().unwrap();
        scrollers
            .get(&event.sourceid)
            .or_else(|| scrollers.get(&event.deviceid))
            .copied()
    };
    let Some(scroller) = scroller else {
        return;
    };
    let Some((delta_x, delta_y)) = scroller.deltas(event) else {
        return;
    };
    let now = Instant::now();
    let began = scroller.precise
        && last_precise.is_none_or(|at| now.saturating_duration_since(at) > NEW_GESTURE_AFTER);
    if scroller.precise {
        *last_precise = Some(now);
    }
    let cursor = pointer(shared);
    if let Some((_, window)) = cursor
        && began
    {
        note_window(shared, window, true);
    }
    // X counts up as the view moves down; the engine follows AppKit, which counts up as the
    // content does.
    publish(Msg::Event(NativeEvent::Scroll {
        delta_x: -delta_x,
        delta_y: -delta_y,
        precise: scroller.precise,
        phase: if began { PHASE_BEGAN } else { 0 },
        momentum: 0,
        point: cursor.map(|(point, _)| point),
    }));
}

fn track_positions(shared: &Shared) {
    let mut last: Option<Point> = None;
    loop {
        let mut armed = shared.armed.lock().unwrap();
        while !*armed && !shared.stopped.load(Ordering::Relaxed) {
            armed = shared.resume.wait(armed).unwrap();
        }
        drop(armed);
        if shared.stopped.load(Ordering::Relaxed) {
            return;
        }
        if let Some((point, window)) = pointer(shared) {
            if last != Some(point) {
                last = Some(point);
                publish(Msg::Event(NativeEvent::Cursor { point }));
            }
            note_window(shared, window, false);
        }
        let armed = shared.armed.lock().unwrap();
        let _ = shared.resume.wait_timeout(armed, CURSOR_INTERVAL).unwrap();
    }
}

fn pointer(shared: &Shared) -> Option<(Point, xproto::Window)> {
    let reply = shared.conn.query_pointer(shared.root).ok()?.reply().ok()?;
    Some(((reply.root_x as f32, reply.root_y as f32), reply.child))
}

/** The topmost window the cursor is over, so the engine can tell when it covers our pane. */
fn note_window(shared: &Shared, window: xproto::Window, force: bool) {
    let mut seen = shared.window.lock().unwrap();
    let fresh = seen
        .checked
        .is_some_and(|at| at.elapsed() < WINDOW_RECHECK);
    if !force && seen.window == Some(window) && fresh {
        return;
    }
    seen.window = Some(window);
    seen.checked = Some(Instant::now());
    let rect = match window {
        x11rb::NONE => None,
        window => window_rect(shared, window),
    };
    if seen.rect == rect {
        return;
    }
    seen.rect = rect;
    drop(seen);
    publish(Msg::Event(NativeEvent::Window { rect }));
}

fn window_rect(shared: &Shared, window: xproto::Window) -> Option<Rect> {
    let geometry = shared.conn.get_geometry(window).ok()?.reply().ok()?;
    let origin = shared
        .conn
        .translate_coordinates(window, shared.root, 0, 0)
        .ok()?
        .reply()
        .ok()?;
    let border = geometry.border_width as f32;
    Some((
        origin.dst_x as f32 - border,
        origin.dst_y as f32 - border,
        geometry.width as f32 + border * 2.0,
        geometry.height as f32 + border * 2.0,
    ))
}

fn refresh_scrollers(shared: &Shared) {
    let Ok(cookie) = shared.conn.xinput_xi_query_device(ALL_DEVICES) else {
        return;
    };
    let Ok(reply) = cookie.reply() else {
        return;
    };
    let mut scrollers = HashMap::new();
    for device in reply.infos {
        let name = String::from_utf8_lossy(&device.name).to_lowercase();
        let mut scroller = Scroller {
            precise: name.contains("touchpad") || name.contains("trackpad"),
            ..Scroller::default()
        };
        for class in &device.classes {
            match &class.data {
                xinput::DeviceClassData::Scroll(scroll) => {
                    let axis = Axis {
                        number: scroll.number,
                        increment: fp3232(scroll.increment),
                    };
                    match scroll.scroll_type {
                        xinput::ScrollType::VERTICAL => scroller.vertical = Some(axis),
                        xinput::ScrollType::HORIZONTAL => scroller.horizontal = Some(axis),
                        _ => {}
                    }
                }
                // only touchpads report gestures, and only they scroll by the pixel
                xinput::DeviceClassData::Gesture(_) => scroller.precise = true,
                _ => {}
            }
        }
        if scroller.vertical.is_some() || scroller.horizontal.is_some() {
            scrollers.insert(device.deviceid, scroller);
        }
    }
    *shared.scrollers.lock().unwrap() = scrollers;
}

fn axes(event: &xinput::RawMotionEvent) -> impl Iterator<Item = (u16, f32)> + '_ {
    set_bits(&event.valuator_mask).zip(event.axisvalues.iter().map(|value| fp3232(*value)))
}

fn set_bits(mask: &[u32]) -> impl Iterator<Item = u16> + '_ {
    mask.iter().enumerate().flat_map(|(word, bits)| {
        (0..32)
            .filter(move |bit| bits & (1 << bit) != 0)
            .map(move |bit| (word as u16) * 32 + bit as u16)
    })
}

fn fp3232(value: xinput::Fp3232) -> f32 {
    value.integral as f32 + value.frac as f32 / 4294967296.0
}

fn fp1616(value: xinput::Fp1616) -> f32 {
    value as f32 / 65536.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valuator_masks_name_the_axes_their_values_belong_to() {
        assert_eq!(set_bits(&[0b1011]).collect::<Vec<_>>(), vec![0, 1, 3]);
        assert_eq!(set_bits(&[0, 0b10]).collect::<Vec<_>>(), vec![33]);
    }

    #[test]
    fn a_wheel_counts_detents_and_a_touchpad_counts_pixels() {
        // the libinput driver advertises 120 per click and sends 8 per pixel of finger travel
        let axis = Axis {
            number: 3,
            increment: 120.0,
        };
        let wheel = Scroller {
            vertical: Some(axis),
            ..Scroller::default()
        };
        assert_eq!(wheel.travel(120.0, axis), 1.0, "one detent");

        let touchpad = Scroller {
            precise: true,
            ..wheel
        };
        assert_eq!(touchpad.travel(8.0 * 40.0, axis), 40.0, "40px of finger");
    }

    #[test]
    fn a_scroll_event_picks_its_axes_out_of_the_valuator_mask() {
        let scroller = Scroller {
            vertical: Some(Axis {
                number: 3,
                increment: 120.0,
            }),
            horizontal: Some(Axis {
                number: 2,
                increment: 120.0,
            }),
            precise: true,
        };
        let event = xinput::RawMotionEvent {
            response_type: 0,
            extension: 0,
            sequence: 0,
            length: 0,
            event_type: 0,
            deviceid: 11,
            time: 0,
            detail: 0,
            sourceid: 11,
            flags: 0u32.into(),
            valuator_mask: vec![0b1100],
            axisvalues: vec![fixed(8.0 * 3.0), fixed(8.0 * -5.0)],
            axisvalues_raw: vec![],
        };
        assert_eq!(scroller.deltas(&event), Some((3.0, -5.0)));
    }

    fn fixed(value: f32) -> xinput::Fp3232 {
        xinput::Fp3232 {
            integral: value as i32,
            frac: 0,
        }
    }

    #[test]
    fn fixed_point_values_keep_their_fraction() {
        assert_eq!(fp1616(65536 + 32768), 1.5);
        assert_eq!(
            fp3232(xinput::Fp3232 {
                integral: -3,
                frac: 0
            }),
            -3.0
        );
    }
}

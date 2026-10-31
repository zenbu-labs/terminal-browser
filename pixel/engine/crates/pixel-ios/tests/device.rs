#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use pixel_ios::*;

#[derive(Default)]
struct Seen {
    frames: Vec<(u32, u32, [u8; 4])>,
    events: Vec<String>,
    placed: Vec<(u32, [f32; 4])>,
}

fn seen<'a>(context: *mut c_void) -> std::sync::MutexGuard<'a, Seen> {
    unsafe { &*(context as *const Mutex<Seen>) }.lock().unwrap()
}

extern "C" fn on_event(context: *mut c_void, json: *const c_char) {
    let json = unsafe { CStr::from_ptr(json) }.to_string_lossy().into_owned();
    seen(context).events.push(json);
}

extern "C" fn on_present(context: *mut c_void, frame: *const PixelFrame) {
    let frame = unsafe { &*frame };
    let pixels = unsafe { std::slice::from_raw_parts(frame.rgba, (frame.width * frame.height * 4) as usize) };
    let at = ((10 * frame.width + 10) * 4) as usize;
    let px = [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]];
    seen(context).frames.push((frame.width, frame.height, px));
}

extern "C" fn on_write(_: *mut c_void, _: *const c_char) {}

extern "C" fn on_place(context: *mut c_void, placements: *const PixelPlacement, count: u32, _: *const PixelCover, _: u32) {
    let placements = unsafe { std::slice::from_raw_parts(placements, count as usize) };
    seen(context).placed = placements.iter().map(|p| (p.surface, p.rect)).collect();
}

struct Running {
    engine: *mut PixelEngine,
    seen: Box<Mutex<Seen>>,
}

impl Running {
    fn start(width: u32, height: u32) -> Self {
        let config = CString::new(format!(r#"{{"width":{width},"height":{height},"cellWidth":18,"cellHeight":40}}"#)).unwrap();
        let engine = pixel_engine_new(config.as_ptr());
        assert!(!engine.is_null());
        let seen = Box::new(Mutex::new(Seen::default()));
        let context = &*seen as *const Mutex<Seen> as *mut c_void;
        pixel_engine_start(engine, PixelCallbacks { context, event: on_event, present: on_present, write: on_write, place: on_place });
        Self { engine, seen }
    }

    fn apply(&self, ops: &str) {
        let ops = CString::new(format!(r#"{{"view":0,"ops":[{ops}]}}"#)).unwrap();
        pixel_engine_apply_ops(self.engine, ops.as_ptr());
    }

    fn input(&self, json: &str) {
        let json = CString::new(json).unwrap();
        pixel_engine_input(self.engine, json.as_ptr());
    }

    fn wait_for(&self, f: impl Fn(&Seen) -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if f(&self.seen.lock().unwrap()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        pixel_engine_free(self.engine);
    }
}

#[test]
fn draws_ops_and_reports_taps() {
    let running = Running::start(300, 600);
    running.apply(
        r#"{"op":"create","id":1,"props":{"style":{"width":"100%","height":"100%","background":[200,30,40,255]},"clickable":true}},
        {"op":"insertBefore","parent":0,"child":1}"#,
    );
    assert!(running.wait_for(|s| s.frames.iter().any(|f| f.2 == [200, 30, 40, 255])));
    for kind in ["down", "up"] {
        running.input(&format!(r#"{{"type":"pointer","kind":"{kind}","button":"left","x":50,"y":50}}"#));
    }
    assert!(running.wait_for(|s| s.events.iter().any(|e| e.contains("click"))));
    pixel_engine_resize(running.engine, 400, 600, 18, 40);
    assert!(running.wait_for(|s| s.frames.iter().any(|f| f.0 == 400)));
}

#[test]
fn updating_a_node_inside_a_removed_subtree_is_ignored() {
    let running = Running::start(200, 200);
    running.apply(
        r#"{"op":"create","id":10,"props":{"style":{"width":100,"height":100}}},
        {"op":"create","id":11,"props":{"style":{"width":50,"height":50,"background":[1,2,3,255]}}},
        {"op":"insertBefore","parent":10,"child":11},
        {"op":"insertBefore","parent":0,"child":10},
        {"op":"remove","id":10},
        {"op":"update","id":11,"props":{"style":{"width":60,"height":60,"background":[200,30,40,255]}}},
        {"op":"create","id":12,"props":{"style":{"width":"100%","height":"100%","background":[9,99,9,255]}}},
        {"op":"insertBefore","parent":0,"child":12}"#,
    );
    assert!(running.wait_for(|s| s.frames.iter().any(|f| f.2 == [9, 99, 9, 255])));
    assert!(!running.seen.lock().unwrap().events.iter().any(|e| e.contains("panicked")));
}

#[test]
fn sync_calls_answer_in_json() {
    let name = CString::new("highlightCaptures").unwrap();
    let args = CString::new("[]").unwrap();
    let reply = pixel_call(name.as_ptr(), args.as_ptr());
    let text = unsafe { CStr::from_ptr(reply) }.to_string_lossy().into_owned();
    pixel_string_free(reply);
    assert!(text.starts_with(r#"{"ok":["#), "{text}");
}

#[test]
fn surface_boxes_are_placed_for_native_views() {
    let running = Running::start(300, 600);
    running.apply(
        r#"{"op":"create","id":1,"props":{"style":{"width":"100%","height":"100%","padding":{"top":40,"left":20}}}},
        {"op":"create","id":2,"props":{"surface":7,"style":{"width":200,"height":120}}},
        {"op":"insertBefore","parent":1,"child":2},
        {"op":"insertBefore","parent":0,"child":1}"#,
    );
    assert!(running.wait_for(|s| s.placed == vec![(7, [20.0, 40.0, 200.0, 120.0])]), "{:?}", running.seen.lock().unwrap().placed);
}

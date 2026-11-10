mod backend;

use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow, NSWindowDidResizeNotification,
    NSWindowStyleMask, NSWindowWillCloseNotification,
};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSPoint, NSRect, NSSize, ns_string};
use pixel_bridge::{Bridge, NoHostOps};
use pixel_core::{Engine, EngineConfig, EngineEvent};

use backend::{AppKitBackend, Msg, Shared};

const WIDTH: f64 = 720.0;
const HEIGHT: f64 = 520.0;

fn main() {
    let mtm = MainThreadMarker::new().expect("AppKit runs on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);

    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(WIDTH, HEIGHT)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Resizable | NSWindowStyleMask::Miniaturizable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(ns_string!("pixel on AppKit"));
    window.setAcceptsMouseMovedEvents(true);
    let view = window.contentView().expect("a window has a content view");
    view.setWantsLayer(true);

    let scale = window.backingScaleFactor();
    let (tx, rx) = mpsc::channel::<Msg>();
    let shared = Arc::new(Shared { scale, size: Mutex::new(backend::pixel_size(&view, scale)) });
    backend::install_view(view.clone());

    let monitor = backend::forward_input(&view, scale, tx.clone());
    let observers = watch_window(&window, &shared, tx.clone());

    let engine_shared = shared.clone();
    std::thread::spawn(move || {
        if let Err(error) = run_app(AppKitBackend::new(engine_shared, tx, rx)) {
            eprintln!("pixel engine stopped: {error}");
            std::process::exit(1);
        }
    });

    window.center();
    window.makeKeyAndOrderFront(None);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    app.run();
    drop((monitor, observers));
}

fn watch_window(window: &NSWindow, shared: &Arc<Shared>, tx: mpsc::Sender<Msg>) -> Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>> {
    let center = NSNotificationCenter::defaultCenter();
    let view = window.contentView().expect("a window has a content view");
    let resize = {
        let shared = shared.clone();
        let tx = tx.clone();
        block2::RcBlock::new(move |_| {
            let size = backend::pixel_size(&view, shared.scale);
            *shared.size.lock().unwrap() = size;
            let _ = tx.send(Msg::Event(pixel_core::Event::Resize(shared.metrics(size))));
        })
    };
    let close = block2::RcBlock::new(move |_| {
        let _ = tx.send(Msg::Event(pixel_core::Event::Closed));
    });
    unsafe {
        vec![
            center.addObserverForName_object_queue_usingBlock(Some(NSWindowDidResizeNotification), Some(window), None, &resize),
            center.addObserverForName_object_queue_usingBlock(Some(NSWindowWillCloseNotification), Some(window), None, &close),
        ]
    }
}

// The app below speaks the same JSON op protocol the React reconciler sends, so no node or React is involved.
fn run_app(backend: AppKitBackend) -> std::io::Result<()> {
    let mut engine = Engine::new(EngineConfig { fonts: pixel_bridge::default_fonts(), cell_metrics_font: 0, backend: Box::new(backend) })?;
    let mut bridge = Bridge::new(&engine);
    apply(&mut bridge, &mut engine, &ui());
    let mut count = 0;
    loop {
        for event in engine.pump(None)? {
            if let Some(json) = bridge.event(&event, &engine) {
                println!("engine -> app: {json}");
            }
            match event {
                EngineEvent::Click { key: Some(key), .. } if key == "button" => {
                    count += 1;
                    apply(&mut bridge, &mut engine, &[update(3, &label(count))]);
                }
                EngineEvent::HostClosed => std::process::exit(0),
                _ => {}
            }
        }
    }
}

fn apply(bridge: &mut Bridge, engine: &mut Engine, ops: &[String]) {
    let batch = format!(r#"{{"view":0,"ops":[{}]}}"#, ops.join(","));
    if let Some(error) = bridge.apply(engine, &batch, &mut NoHostOps).error {
        eprintln!("bad op batch: {error}");
    }
}

fn create(id: u32, props: &str) -> String {
    format!(r#"{{"op":"create","id":{id},"props":{props}}}"#)
}

fn insert(parent: u32, child: u32) -> String {
    format!(r#"{{"op":"insertBefore","parent":{parent},"child":{child}}}"#)
}

fn update(id: u32, props: &str) -> String {
    format!(r#"{{"op":"update","id":{id},"props":{props}}}"#)
}

fn label(count: u32) -> String {
    format!(r#"{{"text":"clicked {count} times","style":{{"color":[255,255,255,255],"fontSize":16}}}}"#)
}

fn ui() -> Vec<String> {
    let mut ops = vec![
        create(1, r#"{"style":{"width":"100%","height":"100%","flexDirection":"column","gap":16,"padding":24,"background":[24,24,28,255]}}"#),
        insert(0, 1),
        create(2, r#"{"text":"pixel, drawn by an AppKit backend","style":{"color":[235,235,240,255],"fontSize":22}}"#),
        insert(1, 2),
        create(6, r#"{"style":{"flexDirection":"row"}}"#),
        insert(1, 6),
        create(4, r#"{"key":"button","clickable":true,"hoverEvents":true,"style":{"padding":{"left":16,"right":16,"top":10,"bottom":10},"cornerRadius":10,"background":[60,90,200,255],"hoverBackground":[85,120,240,255]}}"#),
        insert(6, 4),
        create(3, &label(0)),
        insert(4, 3),
        create(5, r#"{"style":{"flexGrow":1,"overflow":"scroll","flexDirection":"column","gap":6,"cornerRadius":10,"padding":12,"background":[34,34,40,255]}}"#),
        insert(1, 5),
    ];
    for row in 0..60u32 {
        let id = 100 + row;
        ops.push(create(id, &format!(r#"{{"text":"row {row}: scroll me with the trackpad","style":{{"color":[190,190,205,255],"fontSize":15}}}}"#)));
        ops.push(insert(5, id));
    }
    ops
}

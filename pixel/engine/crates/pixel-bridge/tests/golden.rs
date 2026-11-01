#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::{Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::time::{Duration, Instant};

use pixel_bridge::{IdMap, apply_ops};
use pixel_core::{Engine, EngineConfig};

const COLS: u16 = 100;
const ROWS: u16 = 40;
const CELL: (u16, u16) = (10, 20);
const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden.txt");

enum Step {
    Ops(String),
    Input(String),
    Resize(u16, u16),
}

fn ops(list: &[String]) -> Step {
    Step::Ops(format!(r#"{{"view":0,"ops":[{}]}}"#, list.join(",")))
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

fn remove(id: u32) -> String {
    format!(r#"{{"op":"remove","id":{id}}}"#)
}

fn scroll_to(id: u32, offset: u32) -> Step {
    ops(&[format!(r#"{{"op":"scrollTo","id":{id},"offset":{offset},"smooth":false}}"#)])
}

fn hover(col: u16, row: u16) -> Step {
    Step::Input(format!("\x1b[<35;{col};{row}M"))
}

fn click(col: u16, row: u16) -> Step {
    Step::Input(format!("\x1b[<0;{col};{row}M\x1b[<0;{col};{row}m"))
}

fn drag(from: (u16, u16), to: (u16, u16)) -> Step {
    Step::Input(format!("\x1b[<0;{};{}M\x1b[<32;{};{}M\x1b[<0;{};{}m", from.0, from.1, to.0, to.1, to.0, to.1))
}

const HIDDEN_BAR: &str = r#""scrollbar":{"thumbColor":[0,0,0,0],"trackColor":[0,0,0,0],"thumbHoverColor":[0,0,0,0]}"#;
const LINE: &str = "The ships didn't need him anymore. GPS had made the light a formality, and the coast guard sent letters every spring.";

fn transcript(bar: &str) -> Vec<String> {
    let mut list = vec![
        create(1, &format!(r#"{{"style":{{"width":"100%","height":"100%","overflow":"scroll","flexDirection":"column","padding":{{"left":12,"right":12}},"background":[25,25,27,255],{bar}}}}}"#)),
        insert(0, 1),
    ];
    for i in 0..120u32 {
        let id = 100 + i;
        let color = if i % 7 == 0 { "[120,200,255,255]" } else { "[232,232,232,255]" };
        list.push(create(id, &format!(r#"{{"text":"{i} {LINE}","style":{{"color":{color},"fontSize":15,"margin":{{"bottom":6}}}}}}"#)));
        list.push(insert(1, id));
    }
    list.push(create(5, r#"{"style":{"position":"absolute","inset":{"left":0,"right":0,"bottom":0},"height":160,"background":{"type":"linear","from":[0,0],"to":[0,1],"stops":[[0,[25,25,27,0]],[0.4,[25,25,27,235]],[1,[25,25,27,255]]]}}}"#));
    list.push(insert(0, 5));
    list.push(create(2, r#"{"style":{"position":"absolute","inset":{"left":40,"right":40,"bottom":24},"height":56,"background":[40,40,44,200],"cornerRadius":28,"border":{"top":[1,[90,90,100,255]]}}}"#));
    list.push(insert(0, 2));
    list.push(create(3, r#"{"text":"Opus 5.5  auto mode on","style":{"position":"absolute","inset":{"left":64,"bottom":40},"color":[200,200,200,255],"fontSize":16}}"#));
    list.push(insert(0, 3));
    list
}

fn scene_scroll() -> Vec<Step> {
    vec![
        ops(&transcript(HIDDEN_BAR)),
        scroll_to(1, 60),
        scroll_to(1, 400),
        scroll_to(1, 300),
        scroll_to(1, 1200),
        scroll_to(1, 1150),
        Step::Ops(format!(r#"{{"view":0,"ops":[{}]}}"#, update(3, r#"{"text":"Sonnet 5.5  plan mode","style":{"position":"absolute","inset":{"left":64,"bottom":40},"color":[200,200,200,255],"fontSize":16}}"#))),
        scroll_to(1, 900),
    ]
}

fn scene_scroll_with_bar() -> Vec<Step> {
    vec![
        ops(&transcript(r#""scrollbar":{"thumbColor":[120,120,130,255],"trackColor":[40,40,44,255],"thumbHoverColor":[200,200,210,255],"width":8}"#)),
        scroll_to(1, 120),
        hover(99, 10),
        scroll_to(1, 240),
        hover(50, 10),
    ]
}

fn to_bottom() -> Step {
    ops(&[r#"{"op":"scrollTo","id":1,"offset":1000000,"smooth":false}"#.to_string()])
}

fn scene_stream() -> Vec<Step> {
    let mut steps = vec![ops(&transcript(HIDDEN_BAR)), to_bottom()];
    let mut text = String::from("Streaming reply:");
    for step in 0..12 {
        text.push_str(if step % 4 == 3 { " lighthouse keeper\\n" } else { " lighthouse" });
        steps.push(ops(&[update(219, &format!(r#"{{"text":"{text}","style":{{"color":[232,232,232,255],"fontSize":15,"margin":{{"bottom":6}}}}}}"#))]));
        steps.push(to_bottom());
    }
    steps
}

fn scene_hover_and_toggle() -> Vec<Step> {
    let mut list = vec![
        create(1, r#"{"style":{"width":"100%","height":"100%","flexDirection":"column","gap":8,"padding":{"top":16,"left":16},"background":[18,18,22,255]}}"#),
        insert(0, 1),
    ];
    for i in 0..8u32 {
        let id = 10 + i;
        list.push(create(id, &format!(r#"{{"clickable":true,"hoverEvents":true,"style":{{"width":300,"height":40,"padding":{{"left":12,"top":10}},"cornerRadius":8,"background":[40,40,48,255],"hoverBackground":[70,90,160,255],"hoverColor":[255,255,255,255],"color":[190,190,200,255],"fontSize":15}}}}"#)));
        list.push(insert(1, id));
        list.push(create(30 + i, &format!(r#"{{"text":"button {i} with a label","style":{{"fontSize":15}}}}"#)));
        list.push(insert(id, 30 + i));
    }
    vec![
        ops(&list),
        hover(10, 2),
        hover(10, 5),
        hover(10, 9),
        hover(80, 30),
        ops(&[update(12, r#"{"clickable":true,"style":{"width":360,"height":56,"padding":{"left":12,"top":10},"cornerRadius":16,"background":[120,40,48,255],"color":[255,220,220,255],"fontSize":15}}"#)]),
        ops(&[remove(14)]),
        ops(&[create(50, r#"{"text":"appeared","style":{"color":[120,255,120,255],"fontSize":22}}"#), format!(r#"{{"op":"insertBefore","parent":1,"child":50,"before":11}}"#)]),
    ]
}

fn scene_overflow_and_selection() -> Vec<Step> {
    let long = "a line far wider than its box, so its glyphs reach past the right edge of the node that owns them";
    let list = vec![
        create(1, r#"{"style":{"width":"100%","height":"100%","overflow":"scroll","flexDirection":"column","background":[22,22,26,255],"scrollbar":{"thumbColor":[0,0,0,0],"trackColor":[0,0,0,0],"thumbHoverColor":[0,0,0,0]}}}"#),
        insert(0, 1),
        create(2, &format!(r#"{{"text":"{long}","style":{{"width":120,"wrap":false,"color":[255,200,120,255],"fontSize":18,"selectable":true}}}}"#)),
        insert(1, 2),
        create(3, r#"{"style":{"height":2000,"flexDirection":"column","background":{"type":"linear","from":[0,0],"to":[1,1],"stops":[[0,[60,20,90,255]],[1,[20,80,90,255]]]}}}"#),
        insert(1, 3),
        create(4, r#"{"text":"selectable paragraph inside the gradient block that a drag selects across several words","style":{"color":[240,240,240,255],"fontSize":20,"selectable":true,"margin":{"top":40,"left":20},"width":400}}"#),
        insert(3, 4),
        create(6, r#"{"style":{"position":"absolute","inset":{"right":20,"top":20},"width":220,"height":140,"cornerRadius":18,"background":[30,30,36,230],"border":{"width":2,"color":[200,200,255,255]}}}"#),
        insert(0, 6),
    ];
    vec![
        ops(&list),
        scroll_to(1, 40),
        drag((3, 6), (30, 8)),
        scroll_to(1, 120),
        click(60, 30),
        scroll_to(1, 60),
    ]
}

fn bordered(background: &str) -> Vec<Step> {
    let mut list = vec![
        create(1, r#"{"style":{"width":"100%","height":"100%","flexDirection":"column","padding":20,"gap":10,"background":[20,20,24,255]}}"#),
        insert(0, 1),
        create(2, &format!(r#"{{"style":{{"height":300,"overflow":"scroll","flexDirection":"column","border":{{"width":3,"color":[250,180,60,255]}},"background":{background},{HIDDEN_BAR}}}}}"#)),
        insert(1, 2),
    ];
    for i in 0..60u32 {
        list.push(create(100 + i, &format!(r#"{{"text":"row {i} of the bordered scroller","style":{{"color":[240,240,240,255],"fontSize":16}}}}"#)));
        list.push(insert(2, 100 + i));
    }
    list.push(create(3, r#"{"text":"short","style":{"width":60,"wrap":false,"color":[120,255,120,255],"fontSize":20}}"#));
    list.push(insert(1, 3));
    list.push(create(4, r#"{"clickable":true,"hoverEvents":true,"style":{"width":200,"height":40,"hoverBackground":[200,60,60,255]}}"#));
    list.push(insert(1, 4));
    vec![
        ops(&list),
        scroll_to(2, 60),
        ops(&[update(3, r#"{"text":"a much longer line that overflows its narrow box","style":{"width":60,"wrap":false,"color":[120,255,120,255],"fontSize":20}}"#)]),
        ops(&[update(3, r#"{"text":"short","style":{"width":60,"wrap":false,"color":[120,255,120,255],"fontSize":20}}"#)]),
        hover(5, 19),
        hover(60, 30),
    ]
}

fn scene_gradient_scroller() -> Vec<Step> {
    let mut list = vec![
        create(1, r#"{"style":{"width":"100%","height":"100%","flexDirection":"column","padding":20,"background":{"from":[0,0],"to":[1,1],"stops":[{"at":0,"color":[10,10,40,255]},{"at":1,"color":[40,10,10,255]}]}}}"#),
        insert(0, 1),
        create(2, &format!(r#"{{"style":{{"height":300,"overflow":"scroll","flexDirection":"column","gap":60,"background":{{"from":[0,0],"to":[0,1],"stops":[{{"at":0,"color":[200,40,90,255]}},{{"at":1,"color":[40,90,200,255]}}]}},{HIDDEN_BAR}}}}}"#)),
        insert(1, 2),
        create(3, r#"{"style":{"height":200,"overflow":"scroll","flexDirection":"column","gap":40,"margin":{"top":20}}}"#),
        insert(1, 3),
    ];
    for i in 0..30u32 {
        list.push(create(100 + i, &format!(r#"{{"text":"sparse row {i}","style":{{"color":[255,255,255,255],"fontSize":16}}}}"#)));
        list.push(insert(2, 100 + i));
        list.push(create(200 + i, &format!(r#"{{"text":"over the root gradient {i}","style":{{"color":[220,220,120,255],"fontSize":16}}}}"#)));
        list.push(insert(3, 200 + i));
    }
    vec![ops(&list), scroll_to(2, 10), scroll_to(2, 50), scroll_to(2, 400), scroll_to(2, 380), scroll_to(3, 10), scroll_to(3, 90)]
}

fn shape(id: u32, d: &str, join: &str) -> String {
    create(id, &format!(r#"{{"shape":{{"d":"{d}","stroke":{{"width":14,"color":[255,170,40,255],"cap":"butt","join":"{join}"}}}},"style":{{"width":60,"height":60}}}}"#))
}

fn scene_shapes() -> Vec<Step> {
    let mut list = vec![
        create(1, r#"{"style":{"width":"100%","height":"100%","flexDirection":"column","padding":40,"gap":40,"background":[16,16,20,255]}}"#),
        insert(0, 1),
        shape(10, "M -30 10 L 90 30 L 20 90", "miter"),
        insert(1, 10),
        create(2, &format!(r#"{{"style":{{"height":300,"overflow":"scroll","flexDirection":"column","gap":30,"background":[30,30,36,255],{HIDDEN_BAR}}}}}"#)),
        insert(1, 2),
        shape(11, "M 0 0 L 80 -40 L 160 0", "round"),
        format!(r#"{{"op":"insertBefore","parent":1,"child":11,"before":2}}"#),
    ];
    for i in 0..20u32 {
        list.push(shape(100 + i, "M -20 30 L 30 -10 L 80 30", if i % 2 == 0 { "miter" } else { "bevel" }));
        list.push(insert(2, 100 + i));
    }
    let update_shape = |d: &str| update(10, &format!(r#"{{"shape":{{"d":"{d}","stroke":{{"width":14,"color":[255,170,40,255],"cap":"butt","join":"miter"}}}},"style":{{"width":60,"height":60}}}}"#));
    vec![
        ops(&list),
        ops(&[update_shape("M 10 10 L 20 20")]),
        ops(&[update_shape("M -40 -20 L 120 70 L -10 80 Z")]),
        scroll_to(2, 40),
        scroll_to(2, 200),
        ops(&[remove(11)]),
        scroll_to(2, 120),
    ]
}

fn scene_text_reach() -> Vec<Step> {
    let tall = "a paragraph squeezed into a box that is too short for it, so the lines below the box still draw over whatever sits underneath";
    let text = |text: &str| format!(r#"{{"text":"{text}","style":{{"width":220,"height":40,"color":[230,230,250,255],"fontSize":18}}}}"#);
    let wide = |text: &str| format!(r#"{{"text":"{text}","style":{{"width":80,"wrap":false,"color":[250,140,140,255],"fontSize":18}}}}"#);
    let list = vec![
        create(1, r#"{"style":{"width":"100%","height":"100%","flexDirection":"column","padding":30,"gap":60,"background":[24,24,28,255]}}"#),
        insert(0, 1),
        create(2, &text(tall)),
        insert(1, 2),
        create(3, &wide("a line that runs far past the eighty pixel box it was given")),
        insert(1, 3),
        create(4, r#"{"style":{"flexDirection":"row","gap":10}}"#),
        insert(1, 4),
        create(5, &wide("left neighbour that overflows into the right one")),
        insert(4, 5),
        create(6, &wide("right")),
        insert(4, 6),
    ];
    vec![
        ops(&list),
        ops(&[update(2, &text("short now"))]),
        ops(&[update(2, &text(tall))]),
        ops(&[update(3, &wide("tiny"))]),
        ops(&[update(5, &wide("left"))]),
        ops(&[update(6, &wide("the right neighbour now overflows far to the right instead"))]),
        hover(5, 5),
    ]
}

fn write_png(name: &str, colors: [[u8; 4]; 2]) -> String {
    let path = std::env::temp_dir().join(name);
    image::RgbaImage::from_fn(64, 48, |x, y| image::Rgba(colors[((x / 8 + y / 8) % 2) as usize])).save(&path).unwrap();
    path.to_string_lossy().into_owned()
}

fn scene_images() -> Vec<Step> {
    let first = write_png("pixel-golden-first.png", [[220, 80, 60, 255], [40, 40, 40, 255]]);
    let second = write_png("pixel-golden-second.png", [[60, 200, 120, 255], [250, 250, 250, 255]]);
    let image = |src: &str, radius: u32| format!(r#"{{"image":{{"src":"{src}"}},"style":{{"width":128,"height":96,"cornerRadius":{radius}}}}}"#);
    let mut list = vec![
        create(1, &format!(r#"{{"style":{{"width":"100%","height":"100%","overflow":"scroll","flexDirection":"column","gap":24,"padding":24,"background":[20,20,26,255],{HIDDEN_BAR}}}}}"#)),
        insert(0, 1),
    ];
    for i in 0..12u32 {
        list.push(create(100 + i, &image(&first, if i % 3 == 0 { 0 } else { 18 })));
        list.push(insert(1, 100 + i));
        list.push(create(200 + i, &format!(r#"{{"text":"image {i}","style":{{"color":[200,200,200,255],"fontSize":16}}}}"#)));
        list.push(insert(1, 200 + i));
    }
    list.push(create(5, &format!(r#"{{"image":{{"src":"{first}"}},"style":{{"position":"absolute","inset":{{"right":30,"top":30}},"width":160,"height":120,"cornerRadius":24}}}}"#)));
    list.push(insert(0, 5));
    vec![
        ops(&list),
        scroll_to(1, 70),
        ops(&[update(101, &image(&second, 18))]),
        scroll_to(1, 300),
        ops(&[update(5, &format!(r#"{{"image":{{"src":"{second}"}},"style":{{"position":"absolute","inset":{{"right":30,"top":30}},"width":160,"height":120,"cornerRadius":24}}}}"#))]),
        scroll_to(1, 250),
    ]
}

fn scene_resize() -> Vec<Step> {
    vec![
        ops(&transcript(HIDDEN_BAR)),
        scroll_to(1, 300),
        Step::Resize(80, 30),
        scroll_to(1, 420),
        Step::Resize(11, 3),
        Step::Resize(COLS, ROWS),
        scroll_to(1, 380),
        Step::Resize(COLS, ROWS - 1),
        Step::Resize(COLS, ROWS),
    ]
}

fn scene_relayout() -> Vec<Step> {
    let strip = |id: u32| create(id, &format!(r#"{{"text":"tab {id}","style":{{"height":40,"flexShrink":0,"padding":{{"left":16,"top":10}},"background":[36,36,40,255],"color":[230,230,230,255],"fontSize":15}}}}"#));
    let mut list = vec![
        create(1, r#"{"style":{"width":"100%","height":"100%","flexDirection":"column","background":[12,12,14,255]}}"#),
        insert(0, 1),
        create(2, &format!(r#"{{"style":{{"flexGrow":1,"overflow":"scroll","flexDirection":"column","padding":{{"left":12,"right":12}},"background":[25,25,27,255],{HIDDEN_BAR}}}}}"#)),
        insert(1, 2),
    ];
    for i in 0..80u32 {
        list.push(create(100 + i, &format!(r#"{{"text":"{i} {LINE}","style":{{"color":[232,232,232,255],"fontSize":15,"margin":{{"bottom":6}}}}}}"#)));
        list.push(insert(2, 100 + i));
    }
    let before = |child: u32| format!(r#"{{"op":"insertBefore","parent":1,"child":{child},"before":2}}"#);
    vec![
        ops(&list),
        scroll_to(2, 300),
        ops(&[strip(3), before(3)]),
        scroll_to(2, 340),
        ops(&[strip(4), before(4), r#"{"op":"scrollTo","id":2,"offset":360,"smooth":false}"#.to_string()]),
        ops(&[remove(3), r#"{"op":"scrollTo","id":2,"offset":330,"smooth":false}"#.to_string()]),
        ops(&[remove(4)]),
        scroll_to(2, 300),
    ]
}

fn scenes() -> Vec<(&'static str, Vec<Step>)> {
    vec![
        ("scroll", scene_scroll()),
        ("scroll-with-bar", scene_scroll_with_bar()),
        ("stream", scene_stream()),
        ("hover-and-toggle", scene_hover_and_toggle()),
        ("overflow-and-selection", scene_overflow_and_selection()),
        ("bordered-solid", bordered("[40,60,90,255]")),
        ("bordered-gradient", bordered(r#"{"from":[0,0],"to":[0,1],"stops":[{"at":0,"color":[90,20,120,255]},{"at":1,"color":[20,90,120,255]}]}"#)),
        ("gradient-scroller", scene_gradient_scroller()),
        ("shapes", scene_shapes()),
        ("text-reach", scene_text_reach()),
        ("images", scene_images()),
        ("resize", scene_resize()),
        ("relayout", scene_relayout()),
    ]
}

struct Pty {
    master: std::fs::File,
    slave: String,
    _slave_fd: OwnedFd,
}

fn open_pty() -> Pty {
    let (mut master, mut slave) = (0, 0);
    let mut name = [0 as libc::c_char; 128];
    let mut size = libc::winsize { ws_row: ROWS, ws_col: COLS, ws_xpixel: COLS * CELL.0, ws_ypixel: ROWS * CELL.1 };
    let result = unsafe { libc::openpty(&mut master, &mut slave, name.as_mut_ptr(), std::ptr::null_mut(), &mut size) };
    assert_eq!(result, 0, "openpty failed");
    let slave_fd = unsafe { OwnedFd::from_raw_fd(slave) };
    let slave = unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) }.to_string_lossy().into_owned();
    Pty { master: unsafe { std::fs::File::from_raw_fd(master) }, slave, _slave_fd: slave_fd }
}

fn set_size(pty: &Pty, cols: u16, rows: u16) {
    use std::os::fd::AsRawFd;
    let size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: cols * CELL.0, ws_ypixel: rows * CELL.1 };
    let result = unsafe { libc::ioctl(pty.master.as_raw_fd(), libc::TIOCSWINSZ, &size) };
    assert_eq!(result, 0, "TIOCSWINSZ failed");
}

type Graphics = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

fn answer_probes(mut master: std::fs::File) -> Graphics {
    let mut writer = master.try_clone().unwrap();
    let graphics = Graphics::default();
    let seen = graphics.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 1 << 20];
        let mut tail: Vec<u8> = Vec::new();
        while let Ok(n) = master.read(&mut buf) {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buf[..n]);
            if tail.windows(5).any(|w| w == b"\x1b[16t") {
                let _ = writer.write_all(format!("\x1b[6;{};{}t", CELL.1, CELL.0).as_bytes());
            }
            let mut keep_from = tail.len().saturating_sub(8);
            let mut at = 0;
            while let Some(found) = tail[at..].windows(3).position(|w| w == b"\x1b_G") {
                let start = at + found + 3;
                let Some(len) = tail[start..].iter().position(|&b| b == b';' || b == 0x1b) else {
                    keep_from = keep_from.min(at + found);
                    break;
                };
                seen.lock().unwrap().push(String::from_utf8_lossy(&tail[start..start + len]).into_owned());
                at = start + len;
            }
            tail.drain(..keep_from);
        }
    });
    graphics
}

fn check_placements(name: &str, graphics: &[String], windows: &[(u32, u32)]) {
    for keys in graphics {
        let fields: std::collections::HashMap<&str, &str> = keys.split(',').filter_map(|kv| kv.split_once('=')).collect();
        assert!(!fields.contains_key("c") && !fields.contains_key("r"), "{name}: a placement scales its image into a cell box: {keys}");
        if fields.get("i") == Some(&"1") && fields.get("a") == Some(&"T") {
            let size = (fields["s"].parse::<u32>().unwrap(), fields["v"].parse::<u32>().unwrap());
            assert!(windows.contains(&size), "{name}: a whole frame of {size:?} doesn't match any window the scene had: {windows:?} ({keys})");
        }
    }
}

fn fnv(pixels: &[u8]) -> u64 {
    pixels.iter().fold(0xcbf29ce484222325u64, |hash, &b| (hash ^ u64::from(b)).wrapping_mul(0x100000001b3))
}

fn settle(engine: &mut Engine) -> u64 {
    let start = Instant::now();
    let mut last = 0u64;
    let mut stable_since = Instant::now();
    while start.elapsed() < Duration::from_secs(6) {
        engine.pump(Some(Duration::from_millis(4))).expect("pump");
        let hash = fnv(&engine.comp.views[0].canvas.pixels);
        if hash != last || engine.animating() {
            last = hash;
            stable_since = Instant::now();
        } else if stable_since.elapsed() > Duration::from_millis(250) {
            break;
        }
    }
    last
}

fn run(name: &str, steps: &[Step], incremental: bool) -> (Vec<u64>, Vec<u64>) {
    let pty = open_pty();
    let mut master = pty.master.try_clone().unwrap();
    let (input, typed) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for bytes in typed {
            let _ = master.write_all(bytes.as_bytes());
        }
    });
    let graphics = answer_probes(pty.master.try_clone().unwrap());
    let mut windows = vec![(u32::from(COLS * CELL.0), u32::from(ROWS * CELL.1))];
    let mut engine = Engine::new(EngineConfig {
        fonts: pixel_bridge::default_fonts(),
        cell_metrics_font: 0,
        watch_resize: false,
        tty: Some(pty.slave.clone()),
        host: None,
        wrapper: pixel_core::wrapper::Wrapper::None,
        session_env: pixel_core::SessionEnv::of_process(),
    })
    .unwrap_or_else(|e| panic!("{name}: engine failed to start: {e}"));
    engine.incremental = incremental;
    let mut ids: Vec<IdMap> = (0..engine.comp.views.len()).map(|v| IdMap::new(engine.comp.views[v].tree.root())).collect();
    settle(&mut engine);
    let mut hashes = Vec::new();
    let mut repainted = Vec::new();
    for step in steps {
        match step {
            Step::Ops(json) => {
                let outcome = apply_ops(&mut engine, &mut ids, json);
                assert!(outcome.error.is_none(), "{name}: {:?}", outcome.error);
            }
            Step::Input(bytes) => input.send(bytes.clone()).unwrap(),
            Step::Resize(cols, rows) => {
                set_size(&pty, *cols, *rows);
                windows.push((u32::from(*cols * CELL.0), u32::from(*rows * CELL.1)));
            }
        }
        hashes.push(settle(&mut engine));
        let before = engine.comp.views[0].canvas.pixels.clone();
        let clear = engine.comp.views[0].clear_color;
        engine.set_clear_color(0, [clear[0] ^ 1, clear[1], clear[2], clear[3]]);
        engine.set_clear_color(0, clear);
        repainted.push(settle(&mut engine));
        if let Some(dir) = std::env::var_os("PIXEL_GOLDEN_DUMP")
            && repainted.last() != hashes.last()
        {
            let canvas = &engine.comp.views[0].canvas;
            let dir = std::path::PathBuf::from(dir);
            let save = |pixels: &[u8], tag: &str| {
                image::RgbaImage::from_raw(canvas.width, canvas.height, pixels.to_vec())
                    .unwrap()
                    .save(dir.join(format!("{name}-{}-{}-{tag}.png", hashes.len() - 1, if incremental { "incremental" } else { "full" })))
                    .unwrap();
            };
            save(&before, "patched");
            save(&canvas.pixels, "repainted");
        }
    }
    let graphics = graphics.lock().unwrap();
    assert!(!graphics.is_empty(), "{name}: the engine sent no kitty graphics");
    check_placements(name, &graphics, &windows);
    (hashes, repainted)
}

fn render(settled: &BTreeMap<&str, Vec<u64>>, whole: &BTreeMap<&str, Vec<u64>>) -> String {
    let mut out = String::new();
    for (name, hashes) in settled {
        for (step, (hash, repainted)) in hashes.iter().zip(&whole[name]).enumerate() {
            let _ = writeln!(out, "{name} {step} {hash:016x} {repainted:016x}");
        }
    }
    out
}

fn column(rendered: &str, index: usize) -> Vec<String> {
    rendered.lines().map(|line| {
        let fields: Vec<&str> = line.split(' ').collect();
        format!("{} {} {}", fields[0], fields[1], fields[2 + index])
    }).collect()
}

#[test]
#[ignore]
fn terminal_frames_match_the_goldens() {
    let (mut full, mut full_whole) = (BTreeMap::new(), BTreeMap::new());
    let (mut patched, mut patched_whole) = (BTreeMap::new(), BTreeMap::new());
    for (name, steps) in scenes() {
        let (settled, whole) = run(name, &steps, false);
        full.insert(name, settled);
        full_whole.insert(name, whole);
        let (settled, whole) = run(name, &steps, true);
        patched.insert(name, settled);
        patched_whole.insert(name, whole);
    }
    let full = render(&full, &full_whole);
    if std::env::var_os("PIXEL_GOLDEN_WRITE").is_some() {
        std::fs::write(GOLDEN, &full).unwrap();
    }
    let golden = std::fs::read_to_string(GOLDEN).expect("tests/golden.txt is missing; generate it on main with PIXEL_GOLDEN_WRITE=1");
    let patched = render(&patched, &patched_whole);
    assert_eq!(full, golden, "with patching off, terminal frames differ from main");
    assert_eq!(column(&patched, 0), column(&patched, 1), "a patched frame differs from repainting it whole");
    assert_eq!(column(&patched, 1), column(&golden, 1), "a whole repaint differs from main's");
}

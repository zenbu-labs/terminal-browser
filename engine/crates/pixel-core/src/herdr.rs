use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use crate::canvas::Canvas;
use crate::terminal::FrameFile;

const ACK_TIMEOUT: Duration = Duration::from_secs(12);
const OPEN_TIMEOUT: Duration = Duration::from_secs(2);
const SLOTS: u64 = 3;

/// Frames handed to herdr carry the writing pid so a later start can tell whose is whose.
const FRAME_PREFIX: &str = "px-";

#[derive(Clone, Debug)]
pub(crate) struct HerdrTarget {
    pub(crate) pane: String,
    pub(crate) socket: String,
}

impl HerdrTarget {
    pub(crate) fn from_env(env: &crate::terminal::SessionEnv) -> Option<Self> {
        Some(Self {
            pane: env.var("HERDR_PANE_ID")?,
            socket: env.var("HERDR_SOCKET_PATH")?,
        })
    }
}

pub(crate) struct Herdr {
    frames: BufReader<UnixStream>,
    directory: PathBuf,
    cell: (u32, u32),
    files: Vec<FrameFile>,
    retired: Vec<FrameFile>,
    instance: u64,
    generation: u64,
    seq: u64,
}

impl Herdr {
    pub(crate) fn open(target: &HerdrTarget, instance: u64) -> Option<Self> {
        let mut herdr = Self::connect(&target.pane, &target.socket)?;
        herdr.instance = instance;
        Some(herdr)
    }

    fn connect(pane: &str, socket: &str) -> Option<Self> {
        let info = request(
            socket,
            &format!(
                r#"{{"id":"info","method":"pane.graphics.info","params":{{"pane_id":{}}}}}"#,
                quote(pane)
            ),
        )
        .ok()?;

        if field_str(&info, "file_frame_transport")? != "direct-kitty" {
            return None;
        }
        let directory = PathBuf::from(field_str(&info, "file_frame_directory")?);
        let cell = (
            field_u32(&info, "cell_width_px")?,
            field_u32(&info, "cell_height_px")?,
        );
        if cell.0 == 0 || cell.1 == 0 {
            return None;
        }

        let stream = UnixStream::connect(socket).ok()?;
        stream.set_read_timeout(Some(OPEN_TIMEOUT)).ok()?;
        let mut frames = BufReader::new(stream);
        write_line(
            frames.get_mut(),
            &format!(
                r#"{{"id":"stream","method":"pane.graphics.stream","params":{{"pane_id":{},"layer_id":"primary","z_index":0}}}}"#,
                // checkme: how does pane get here? 
                quote(pane)
            ),
        )
        .ok()?;
        if !accepted(&read_line(&mut frames).ok()?) {
            return None;
        }
        frames.get_ref().set_read_timeout(Some(ACK_TIMEOUT)).ok()?;

        // Frames in herdr's directory leak exactly the way ours in TMPDIR do when a process is
        // killed, and they are just as large; clear out the ones nobody owns before adding more.
        crate::terminal::sweep_dead_frame_files(&directory, FRAME_PREFIX, "");
        crate::logging::info("herdr", "frames go straight to herdr as files");
        Some(Self {
            frames,
            directory,
            cell,
            files: Vec::new(),
            retired: Vec::new(),
            instance: 0,
            generation: 0,
            seq: 0,
        })
    }

    pub(crate) fn cell(&self) -> (u32, u32) {
        self.cell
    }

    pub(crate) fn mouse_position_px(
        &self,
        kind: crate::terminal::MouseKind,
        x: u32,
        y: u32,
        focused: bool,
        pixel_mouse: bool,
        grid: impl FnOnce() -> Option<crate::terminal::WindowSize>,
    ) -> (u32, u32) {
        let (cell_w, cell_h) = self.cell;
        let cell_center =
            |x: u32, y: u32| ((x - 1) * cell_w + cell_w / 2, (y - 1) * cell_h + cell_h / 2);
        if !pixel_mouse {
            return cell_center(x, y);
        }
        if !focused && is_wheel(kind) && grid().is_some_and(|ws| within_grid(&ws, x, y)) {
            return cell_center(x, y);
        }
        (x.saturating_sub(1), y.saturating_sub(1))
    }

    pub(crate) fn present(&mut self, canvas: &Canvas) -> io::Result<usize> {
        let path = crate::profiler::span("herdr.handoff", || self.write_frame(&canvas.pixels))?;
        let header = format!(
            r#"{{"format":"rgba","image_width":{},"image_height":{},"file":{{"path":{}}},"sequence":{},"revision":0,"placement":{{"viewport_col":0,"viewport_row":0,"grid_cols":{},"grid_rows":{}}}}}"#,
            canvas.width,
            canvas.height,
            quote(&path),
            self.seq,
            canvas.width.div_ceil(self.cell.0).max(1),
            canvas.height.div_ceil(self.cell.1).max(1),
        );
        self.seq += 1;
        write_line(self.frames.get_mut(), &header)?;

        let ack = crate::profiler::span("herdr.ack", || read_line(&mut self.frames))?;
        if !accepted(&ack) {
            return Err(io::Error::other(format!("herdr rejected a frame: {ack}")));
        }
        self.retired.clear();
        Ok(header.len())
    }

    fn write_frame(&mut self, pixels: &[u8]) -> io::Result<String> {
        if self.files.first().is_none_or(|file| file.len() != pixels.len()) {
            self.generation += 1;
            self.retired = std::mem::take(&mut self.files);
            for slot in 0..SLOTS {
                self.files.push(FrameFile::create(
                    self.directory.join(format!(
                        "{FRAME_PREFIX}{}-{}-{}-{slot}",
                        std::process::id(),
                        self.instance,
                        self.generation
                    )),
                    pixels.len(),
                )?);
            }
        }
        let file = &mut self.files[(self.seq % SLOTS) as usize];
        file.write(pixels);
        Ok(file.path().to_string_lossy().into_owned())
    }
}

fn is_wheel(kind: crate::terminal::MouseKind) -> bool {
    use crate::terminal::MouseKind;
    matches!(
        kind,
        MouseKind::ScrollUp
            | MouseKind::ScrollDown
            | MouseKind::ScrollLeft
            | MouseKind::ScrollRight
    )
}

fn within_grid(ws: &crate::terminal::WindowSize, x: u32, y: u32) -> bool {
    x >= 1 && y >= 1 && x <= ws.cols && y <= ws.rows
}

fn request(socket: &str, line: &str) -> io::Result<String> {
    let stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(OPEN_TIMEOUT))?;
    let mut reader = BufReader::new(stream);
    write_line(reader.get_mut(), line)?;
    read_line(&mut reader)
}

fn write_line(stream: &mut UnixStream, line: &str) -> io::Result<()> {
    stream.write_all(line.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

fn read_line(reader: &mut BufReader<UnixStream>) -> io::Result<String> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Err(io::Error::other("herdr closed the connection"));
    }
    Ok(line)
}

fn accepted(response: &str) -> bool {
    response.contains(r#""result""#) && !response.contains(r#""error""#)
}

fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn value_after<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let at = json.find(&format!("\"{key}\":"))? + key.len() + 3;
    Some(json[at..].trim_start())
}

fn field_str(json: &str, key: &str) -> Option<String> {
    let rest = value_after(json, key)?.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(out),
            '\\' => out.push(chars.next()?),
            _ => out.push(ch),
        }
    }
    None
}

fn field_u32(json: &str, key: &str) -> Option<u32> {
    let rest = value_after(json, key)?;
    let end = rest.find(|c: char| !c.is_ascii_digit())?;
    rest[..end].parse().ok()
}

#[cfg_attr(not(test), expect(dead_code, reason = "herdr reports pane_visible; nothing skips rendering on it yet"))]
fn field_bool(json: &str, key: &str) -> Option<bool> {
    match value_after(json, key)? {
        rest if rest.starts_with("true") => Some(true),
        rest if rest.starts_with("false") => Some(false),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const INFO: &str = r#"{"id":"info","result":{"type":"pane_graphics_info","cell_width_px":9,"cell_height_px":19,"pane_visible":true,"file_frame_directory":"/tmp/herdr/frames/source","file_frame_formats":["rgba","bgra"],"max_layers_per_pane":16,"pixel_mouse":false,"file_frame_transport":"direct-kitty"}}"#;

    #[test]
    fn reads_the_fields_an_info_reply_carries() {
        assert_eq!(field_u32(INFO, "cell_width_px"), Some(9));
        assert_eq!(field_u32(INFO, "cell_height_px"), Some(19));
        assert_eq!(field_bool(INFO, "pane_visible"), Some(true));
        assert_eq!(
            field_str(INFO, "file_frame_directory").as_deref(),
            Some("/tmp/herdr/frames/source")
        );
        assert_eq!(
            field_str(INFO, "file_frame_transport").as_deref(),
            Some("direct-kitty")
        );
    }

    #[test]
    fn a_missing_field_is_absent_rather_than_wrong() {
        assert_eq!(field_u32(INFO, "nope"), None);
        assert_eq!(field_str(INFO, "nope"), None);
        assert_eq!(field_bool(INFO, "nope"), None);
        assert_eq!(field_bool(INFO, "file_frame_transport"), None);
    }

    #[test]
    fn an_info_reply_without_file_transport_is_not_ours_to_use() {
        let plain = r#"{"id":"info","result":{"cell_width_px":9,"cell_height_px":19,"pane_visible":true}}"#;
        assert_eq!(field_str(plain, "file_frame_transport"), None);
    }

    #[test]
    fn only_a_result_counts_as_accepted() {
        assert!(accepted(
            r#"{"id":"stream","result":{"type":"pane_graphics_frame_ack","sequence":0,"revision":0}}"#
        ));
        assert!(!accepted(
            r#"{"id":"stream","error":{"code":"feature_disabled","message":"nope"}}"#
        ));
    }

    /// Answers like herdr does: one info reply per connection, then a stream
    /// that acks every frame. Collects the frame headers it was sent.
    pub(crate) fn fake_herdr(
        directory: &std::path::Path,
        transport: &str,
    ) -> (PathBuf, std::sync::mpsc::Receiver<String>) {
        let socket = directory.join("herdr.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let info = format!(
            r#"{{"id":"info","result":{{"cell_width_px":10,"cell_height_px":20,"pane_visible":true,"file_frame_directory":{},"file_frame_transport":"{transport}"}}}}"#,
            quote(&directory.to_string_lossy())
        );
        std::thread::spawn(move || {
            for connection in listener.incoming().take(2) {
                let mut reader = BufReader::new(connection.unwrap());
                let mut opening = String::new();
                reader.read_line(&mut opening).unwrap();
                if opening.contains("pane.graphics.info") {
                    write_line(reader.get_mut(), &info).unwrap();
                    continue;
                }
                write_line(reader.get_mut(), r#"{"id":"stream","result":{"type":"ok"}}"#).unwrap();
                let mut frame = String::new();
                while reader.read_line(&mut frame).map(|n| n > 0).unwrap_or(false) {
                    tx.send(frame.clone()).unwrap();
                    let ack = r#"{"id":"stream","result":{"type":"pane_graphics_frame_ack"}}"#;
                    if write_line(reader.get_mut(), ack).is_err() {
                        break;
                    }
                    frame.clear();
                }
            }
        });
        (socket, rx)
    }

    pub(crate) fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pixel-herdr-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_frame_reaches_herdr_as_a_file_the_header_points_at() {
        let dir = scratch("present");
        let (socket, frames) = fake_herdr(&dir, "direct-kitty");
        let mut herdr =
            Herdr::connect("w1:p1", &socket.to_string_lossy()).expect("herdr offered files");

        assert_eq!(herdr.cell(), (10, 20));
        let canvas = Canvas::new(40, 40);
        herdr.present(&canvas).unwrap();

        let header = frames.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(header.contains(r#""format":"rgba""#));
        assert!(header.contains(r#""image_width":40,"image_height":40"#));
        assert!(header.contains(r#""grid_cols":4,"grid_rows":2"#));

        let path = PathBuf::from(field_str(&header, "path").unwrap());
        assert_eq!(path.parent(), Some(dir.as_path()));
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 40 * 40 * 4);
    }

    #[test]
    fn a_resize_keeps_the_previous_pixels_until_the_next_frame_is_taken() {
        let dir = scratch("resize");
        let (socket, frames) = fake_herdr(&dir, "direct-kitty");
        let mut herdr = Herdr::connect("w1:p1", &socket.to_string_lossy()).unwrap();

        let before = PathBuf::from(herdr.write_frame(&vec![0; 40 * 40 * 4]).unwrap());
        let after = PathBuf::from(herdr.write_frame(&vec![0; 60 * 60 * 4]).unwrap());

        assert_ne!(before, after, "a stale path must never find new pixels");
        assert!(before.exists(), "herdr may still replay the placement it has");
        assert_eq!(std::fs::metadata(&after).unwrap().len(), 60 * 60 * 4);

        herdr.present(&Canvas::new(60, 60)).unwrap();
        frames.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!before.exists(), "herdr has the new frame, so it can go");
    }

    #[test]
    fn frames_cycle_through_slots_so_herdr_reads_one_we_are_not_writing() {
        let dir = scratch("slots");
        let (socket, frames) = fake_herdr(&dir, "direct-kitty");
        let mut herdr = Herdr::connect("w1:p1", &socket.to_string_lossy()).unwrap();

        let canvas = Canvas::new(40, 40);
        let mut paths = Vec::new();
        for _ in 0..SLOTS {
            herdr.present(&canvas).unwrap();
            let header = frames.recv_timeout(Duration::from_secs(5)).unwrap();
            paths.push(field_str(&header, "path").unwrap());
        }

        paths.dedup();
        assert_eq!(paths.len(), SLOTS as usize, "consecutive frames shared a file");
    }

    #[test]
    fn attaching_clears_frames_herdr_still_holds_for_a_dead_process() {
        let dir = scratch("dead-frames");
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .spawn()
            .unwrap();
        let dead = child.id();
        child.wait().unwrap();

        // A session killed mid-frame leaves its mapped files behind in herdr's own directory,
        // at a whole frame each; a later attach is what finally clears them.
        let stale = dir.join(format!("{FRAME_PREFIX}{dead}-0-1-0"));
        let live = dir.join(format!("{FRAME_PREFIX}{}-0-1-0", std::process::id()));
        std::fs::write(&stale, [0u8; 4]).unwrap();
        std::fs::write(&live, [0u8; 4]).unwrap();

        let (socket, _frames) = fake_herdr(&dir, "direct-kitty");
        let _herdr = Herdr::connect("w1:p1", &socket.to_string_lossy()).unwrap();

        assert!(!stale.exists(), "frames whose writer is gone must not outlive it");
        assert!(live.exists(), "panes share a process, so a live pid keeps its frames");
    }

    #[test]
    fn a_terminal_without_file_frames_is_left_to_the_caller() {
        let dir = scratch("inline");
        let (socket, _frames) = fake_herdr(&dir, "");
        assert!(Herdr::connect("w1:p1", &socket.to_string_lossy()).is_none());
    }

    #[test]
    fn nothing_listening_is_simply_not_herdr() {
        let dir = scratch("absent");
        let socket = dir.join("missing.sock");
        assert!(Herdr::connect("w1:p1", &socket.to_string_lossy()).is_none());
    }

    #[test]
    fn quoting_survives_a_path_with_characters_json_cares_about() {
        assert_eq!(quote(r#"/tmp/a"b\c"#), r#""/tmp/a\"b\\c""#);
        assert_eq!(field_str(&format!(r#"{{"p":{}}}"#, quote(r#"/a"b\c"#)), "p").as_deref(), Some(r#"/a"b\c"#));
    }
}

#[cfg(test)]
mod shared_process_tests {
    use super::*;
    use crate::canvas::Canvas;

    #[test]
    fn engines_sharing_a_process_use_distinct_frame_files() {
        let dir = tests::scratch("shared-process");
        let dir_b = tests::scratch("shared-process-b");
        let (socket_a, _frames_a) = tests::fake_herdr(&dir, "direct-kitty");
        let (socket_b, _frames_b) = tests::fake_herdr(&dir_b, "direct-kitty");
        let mut a = Herdr::connect("w1:p1", &socket_a.to_string_lossy()).unwrap();
        let mut b = Herdr::connect("w1:p2", &socket_b.to_string_lossy()).unwrap();
        // Both engines share one process and one frame directory, as when
        // the daemon hosts two herdr sessions.
        b.directory = dir.clone();
        b.instance = 1;

        let canvas = Canvas::new(40, 40);
        a.present(&canvas).unwrap();
        let path_a = a.files[0].path().to_owned();
        b.present(&canvas).unwrap();
        let path_b = b.files[0].path().to_owned();

        assert_ne!(path_a, path_b, "same-process engines must not share frame files");
        // Writing B's frames must leave A's mapped file fully intact; a
        // truncated file here means A's next frame copy dies of SIGBUS.
        assert_eq!(std::fs::metadata(&path_a).unwrap().len(), 40 * 40 * 4);
        assert_eq!(std::fs::metadata(&path_b).unwrap().len(), 40 * 40 * 4);
        a.present(&canvas).unwrap();
    }
}

#[cfg(test)]
mod degraded_wheel_tests {
    use super::*;
    use crate::terminal::{MouseKind, WindowSize};

    fn grid() -> Option<WindowSize> {
        Some(WindowSize {
            cols: 120,
            rows: 40,
            width_px: 1200,
            height_px: 800,
        })
    }

    #[test]
    fn unfocused_in_grid_wheel_rescales_to_cell_centers() {
        let dir = tests::scratch("degraded-wheel");
        let (socket, _frames) = tests::fake_herdr(&dir, "direct-kitty");
        // fake_herdr advertises a 10x20 cell size.
        let herdr = Herdr::connect("w1:p1", &socket.to_string_lossy()).unwrap();

        // The bug case: an unfocused wheel arrives as cells (8, 9) and is
        // rescaled to the cell center.
        assert_eq!(
            herdr.mouse_position_px(MouseKind::ScrollUp, 8, 9, false, true, grid),
            (75, 170)
        );
        // Focused wheels are honest pixels; pass them through 0-based.
        assert_eq!(
            herdr.mouse_position_px(MouseKind::ScrollUp, 8, 9, true, true, grid),
            (7, 8)
        );
        // Coordinates beyond the cell grid can only be pixels.
        assert_eq!(
            herdr.mouse_position_px(MouseKind::ScrollDown, 640, 9, false, true, grid),
            (639, 8)
        );
        // Without pixel mouse mode every report is cells.
        assert_eq!(
            herdr.mouse_position_px(MouseKind::ScrollUp, 8, 9, false, false, grid),
            (75, 170)
        );
        // Only wheels: clicks focus the pane first, so they stay untouched.
        assert_eq!(
            herdr.mouse_position_px(MouseKind::Down, 8, 9, false, true, grid),
            (7, 8)
        );
    }
}

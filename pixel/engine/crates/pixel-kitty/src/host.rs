use serde_json::{Value, json};

pub(crate) fn placed(image_id: u32, cols: u32, rows: u32, cell: Option<(u32, u32)>) -> Value {
    json!({ "type": "placed", "imageId": image_id, "cols": cols, "rows": rows, "cell": cell.map(|(w, h)| [w, h]) })
}

pub(crate) struct HostFrame<'a> {
    pub(crate) shm: &'a str,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) generation: u64,
    pub(crate) cols: u32,
    pub(crate) rows: u32,
    pub(crate) cell: Option<(u32, u32)>,
}

pub(crate) fn frame(frame: HostFrame<'_>) -> Value {
    json!({
        "type": "frame",
        "shm": frame.shm,
        "format": "rgba",
        "width": frame.width,
        "height": frame.height,
        "generation": frame.generation,
        "cols": frame.cols,
        "rows": frame.rows,
        "cell": frame.cell.map(|(w, h)| [w, h]),
    })
}

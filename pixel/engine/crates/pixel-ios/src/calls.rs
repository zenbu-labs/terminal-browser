use serde_json::Value;

pub(crate) fn call(name: &str, args: &[Value]) -> Result<Value, String> {
    let string = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default().to_string();
    let value = match name {
        "parseMarkdown" => serde_json::to_value(pixel_bridge::markdown::parse_markdown(string(0), args.get(1).and_then(Value::as_bool))),
        "highlight" => serde_json::to_value(pixel_bridge::highlight::highlight(string(0), string(1))),
        "highlightCaptures" => serde_json::to_value(pixel_bridge::highlight::highlight_captures()),
        "diff" => serde_json::to_value(pixel_bridge::diff::diff(
            string(0),
            string(1),
            args.get(2).and_then(Value::as_u64).map(|v| v as u32),
        )),
        other => return Err(format!("unknown call {other}")),
    };
    value.map_err(|e| e.to_string())
}

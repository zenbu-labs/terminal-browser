use std::io;
use std::time::{Duration, Instant};

use super::EngineEvent;
use crate::clipboard_image::PastedImage;
use crate::logging;
use super::Io;
use crate::text_input::MARK_CHAR;
use crate::tree::NodeId;

pub const MARK_TOKEN_OPEN: char = '⟦';
pub const MARK_TOKEN_CLOSE: char = '⟧';

/**
 * meh this is not great, the mime type we prefer in the clipboard
 */
const PASTE_IMAGE_MIMES: [(&str, &str); 4] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];

struct OscPaste {
    view: usize,
    node: NodeId,
    stage: OscPasteStage,
    deadline: Instant,
}

enum OscPasteStage {
    Types,
    Data { ext: &'static str },
}

struct RichClip {
    token: u64,
    text: String,
    slots: Vec<RichSlot>,
}

struct RichSlot {
    offset: usize,
    data: Option<String>,
}

fn enrich_clipboard_text(text: &str, slots: &[RichSlot]) -> Option<String> {
    if !slots.iter().any(|s| s.data.is_some()) {
        return None;
    }
    let mut out = String::with_capacity(text.len() * 2);
    for (i, ch) in text.char_indices() {
        if ch == MARK_CHAR {
            let data = slots
                .iter()
                .find(|s| s.offset == i)
                .and_then(|s| s.data.as_deref());
            if let Some(data) = data {
                out.push(MARK_TOKEN_OPEN);
                out.push_str(data);
                out.push(MARK_TOKEN_CLOSE);
            }
        } else {
            out.push(ch);
        }
    }
    Some(out)
}

pub(super) fn parse_rich_paste(text: &str) -> Option<(String, Vec<(usize, String)>)> {
    if !text.contains(MARK_TOKEN_OPEN) {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut marks = Vec::new();
    let mut rest = text;
    loop {
        let Some(open) = rest.find(MARK_TOKEN_OPEN) else {
            out.push_str(rest);
            break;
        };
        let after = &rest[open + MARK_TOKEN_OPEN.len_utf8()..];
        let Some(close) = after.find(MARK_TOKEN_CLOSE) else {
            out.push_str(&rest[..open + MARK_TOKEN_OPEN.len_utf8()]);
            rest = after;
            continue;
        };
        out.push_str(&rest[..open]);
        marks.push((out.len(), after[..close].to_string()));
        out.push(MARK_CHAR);
        rest = &after[close + MARK_TOKEN_CLOSE.len_utf8()..];
    }
    (!marks.is_empty()).then_some((out, marks))
}

fn request_text_clipboard(io: &mut Io) {
    if let Err(error) = io.request_clipboard() {
        logging::warn("engine", format!("clipboard request failed: {error}"));
    }
}

pub(super) struct ClipboardFlows {
    rich: Option<RichClip>,
    rich_token: u64,
    osc: Option<OscPaste>,
    pending_pastes: Vec<(u64, usize, NodeId)>,
}

impl ClipboardFlows {
    pub fn new() -> Self {
        Self {
            rich: None,
            rich_token: 0,
            osc: None,
            pending_pastes: Vec::new(),
        }
    }

    pub fn begin_rich_capture(
        &mut self,
        io: &mut Io,
        view: usize,
        text: String,
        marks: Vec<(NodeId, crate::text_input::Mark)>,
    ) -> io::Result<Option<EngineEvent>> {
        let projection: String = text.chars().filter(|&c| c != MARK_CHAR).collect();
        io.set_clipboard(&projection)?;
        if marks.is_empty() {
            self.rich = None;
            return Ok(None);
        }
        self.rich_token += 1;
        let slots = marks
            .iter()
            .map(|(_, m)| RichSlot {
                offset: m.offset,
                data: m.data.clone(),
            })
            .collect();
        let request = marks
            .iter()
            .enumerate()
            .map(|(index, (node, m))| (*node, m.id, index))
            .collect();
        self.rich = Some(RichClip {
            token: self.rich_token,
            text,
            slots,
        });
        Ok(Some(EngineEvent::SerializeMarks {
            view,
            token: self.rich_token,
            marks: request,
        }))
    }

    pub fn attach_rich(&mut self, io: &mut Io, token: u64, marks: Vec<(usize, String)>) {
        let Some(rich) = self.rich.as_mut().filter(|r| r.token == token) else {
            return;
        };
        for (index, data) in marks {
            if let Some(slot) = rich.slots.get_mut(index) {
                slot.data = Some(data);
            }
        }
        let rich = self.rich.take().expect("checked above");
        if let Some(enriched) = enrich_clipboard_text(&rich.text, &rich.slots)
            && let Err(error) = io.set_clipboard(&enriched)
        {
            logging::warn("engine", format!("clipboard write failed: {error}"));
        }
    }

    pub fn request_paste(&mut self, view: usize, node: NodeId) {
        let seq = crate::image_cache::queue_clipboard_read();
        self.pending_pastes.push((seq, view, node));
    }

    pub fn resolve_pastes(
        &mut self,
        io: &mut Io,
        pastes: Vec<(u64, Option<PastedImage>)>,
    ) -> Vec<(usize, NodeId, PastedImage)> {
        let mut delivered = Vec::new();
        for (seq, pasted) in pastes {
            let Some(i) = self.pending_pastes.iter().position(|(s, ..)| *s == seq) else {
                continue;
            };
            let (_, view, node) = self.pending_pastes.remove(i);
            match pasted {
                Some(image) => delivered.push((view, node, image)),
                None => {
                    if self.osc.is_none()
                        && io.clipboard_data_supported()
                        && io.request_clipboard_types().is_ok()
                    {
                        self.osc = Some(OscPaste {
                            view,
                            node,
                            stage: OscPasteStage::Types,
                            deadline: Instant::now() + Duration::from_secs(3),
                        });
                    } else {
                        request_text_clipboard(io);
                    }
                }
            }
        }
        if let Some(paste) = &self.osc
            && Instant::now() > paste.deadline
        {
            self.osc = None;
            request_text_clipboard(io);
        }
        delivered
    }

    pub fn handle_clipboard_data(
        &mut self,
        io: &mut Io,
        items: Vec<(String, Vec<u8>)>,
        ok: bool,
    ) {
        let Some(paste) = self.osc.take() else {
            return;
        };
        if !ok {
            request_text_clipboard(io);
            return;
        }
        match paste.stage {
            OscPasteStage::Types => {
                let offered = items
                    .iter()
                    .find(|(mime, _)| mime == "." || mime.is_empty())
                    .map(|(_, data)| String::from_utf8_lossy(data).into_owned())
                    .unwrap_or_default();
                let pick = PASTE_IMAGE_MIMES
                    .iter()
                    .find(|(mime, _)| offered.split_whitespace().any(|o| o == *mime));
                match pick {
                    Some(&(mime, ext)) if io.request_clipboard_data(mime).is_ok() => {
                        self.osc = Some(OscPaste {
                            stage: OscPasteStage::Data { ext },
                            deadline: Instant::now() + Duration::from_secs(20),
                            ..paste
                        });
                    }
                    _ => request_text_clipboard(io),
                }
            }
            OscPasteStage::Data { ext } => {
                let data = items
                    .into_iter()
                    .find(|(mime, data)| mime.starts_with("image/") && !data.is_empty())
                    .map(|(_, data)| data);
                match data {
                    Some(data) => {
                        let seq = crate::image_cache::queue_pasted_bytes(
                            data,
                            ext,
                            crate::clipboard_image::PasteSource::Osc,
                        );
                        self.pending_pastes.push((seq, paste.view, paste.node));
                    }
                    None => request_text_clipboard(io),
                }
            }
        }
    }

    pub fn osc_deadline(&self) -> Option<Instant> {
        self.osc.as_ref().map(|paste| paste.deadline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrich_inlines_data_and_strips_dataless_sentinels() {
        let m = MARK_CHAR;
        let text = format!("a{m}b{m}c");
        let slots = vec![
            RichSlot {
                offset: 1,
                data: Some("one".into()),
            },
            RichSlot {
                offset: 1 + m.len_utf8() + 1,
                data: None,
            },
        ];
        assert_eq!(
            enrich_clipboard_text(&text, &slots).unwrap(),
            format!("a{MARK_TOKEN_OPEN}one{MARK_TOKEN_CLOSE}bc")
        );
        let none = vec![RichSlot {
            offset: 1,
            data: None,
        }];
        assert!(enrich_clipboard_text(&text, &none).is_none());
    }

    #[test]
    fn parse_round_trips_and_tolerates_unmatched_delimiters() {
        let m = MARK_CHAR;
        let pasted = format!("x{MARK_TOKEN_OPEN}one{MARK_TOKEN_CLOSE}y{MARK_TOKEN_OPEN}two{MARK_TOKEN_CLOSE}");
        let (text, marks) = parse_rich_paste(&pasted).unwrap();
        assert_eq!(text, format!("x{m}y{m}"));
        assert_eq!(marks, vec![(1, "one".into()), (2 + m.len_utf8(), "two".into())]);

        assert!(parse_rich_paste("plain text").is_none());
        let unmatched = format!("a{MARK_TOKEN_OPEN}never closed");
        assert!(parse_rich_paste(&unmatched).is_none(), "unmatched keeps text plain");
    }
}

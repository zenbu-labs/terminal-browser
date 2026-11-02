use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::mend::{INCOMPLETE_LINK, fence_open, mend};

#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone, Debug, PartialEq)]
pub struct MarkdownSpan {
    pub start: u32,
    pub end: u32,
    pub bold: bool,
    pub italic: bool,
    pub strikethrough: bool,
    pub code: bool,
    pub link: Option<String>,
    pub incomplete_link: bool,
}

#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone, Debug)]
pub struct MarkdownCell {
    pub text: String,
    pub spans: Vec<MarkdownSpan>,
}

#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone, Debug)]
pub struct MarkdownRow {
    pub cells: Vec<MarkdownCell>,
}

#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone, Debug)]
pub struct MarkdownBlock {
    pub kind: String, // paragraph | heading | code | rule | image | table
    pub text: String,
    pub spans: Vec<MarkdownSpan>,
    pub level: u32,       
    pub language: String, 
    pub closed: bool,     
    pub quote: u32,       
    pub list_depth: Option<u32>,
    pub ordinal: Option<u32>, 
    pub task: Option<bool>,   
    pub item_start: bool,     
    pub src: String,          
    pub rows: Vec<MarkdownRow>, 
    pub aligns: Vec<String>,    
    pub source_start: u32,
    pub source_end: u32,
}

struct ListCtx {
    next_ordinal: Option<u64>,
    current: Option<u64>,
    task: Option<bool>,
}

#[derive(Default)]
struct Builder {
    blocks: Vec<MarkdownBlock>,
    kind: Option<&'static str>,
    text: String,
    spans: Vec<MarkdownSpan>,
    level: u32,
    language: String,
    item_start: bool,
    source: (u32, u32),
    quote: u32,
    lists: Vec<ListCtx>,
    pending_item: bool,
    bold: u32,
    italic: u32,
    strike: u32,
    links: Vec<String>,
    image: Option<String>,
    image_alt: String,
    rows: Vec<MarkdownRow>,
    row: Option<Vec<MarkdownCell>>,
    aligns: Vec<String>,
}

impl Builder {
    fn open(&mut self, kind: &'static str, source: &std::ops::Range<usize>) {
        self.close();
        self.kind = Some(kind);
        self.source = (source.start as u32, source.end as u32);
        self.item_start = std::mem::take(&mut self.pending_item);
    }

    fn ensure_inline(&mut self, source: &std::ops::Range<usize>) {
        if self.kind.is_none() {
            self.open("paragraph", source);
        }
    }

    fn close(&mut self) {
        let Some(kind) = self.kind.take() else {
            return;
        };
        let text = std::mem::take(&mut self.text);
        let spans = std::mem::take(&mut self.spans);
        let level = std::mem::take(&mut self.level);
        let language = std::mem::take(&mut self.language);
        let item_start = std::mem::take(&mut self.item_start);
        if kind == "paragraph" && text.trim().is_empty() {
            return;
        }
        let depth = self.lists.len().checked_sub(1).map(|d| d as u32);
        let ctx = self.lists.last_mut();
        self.blocks.push(MarkdownBlock {
            kind: kind.to_string(),
            text,
            spans,
            level,
            language,
            closed: true,
            quote: self.quote,
            list_depth: depth,
            ordinal: ctx.as_ref().and_then(|c| c.current.map(|n| n as u32)),
            task: ctx.and_then(|c| match item_start {
                true => c.task.take(),
                false => None,
            }),
            item_start,
            src: String::new(),
            rows: std::mem::take(&mut self.rows),
            aligns: std::mem::take(&mut self.aligns),
            source_start: self.source.0,
            source_end: self.source.1,
        });
    }

    fn styled(&self) -> bool {
        self.bold > 0 || self.italic > 0 || self.strike > 0 || !self.links.is_empty()
    }

    fn push_text(&mut self, chunk: &str, code: bool, source: &std::ops::Range<usize>) {
        if self.image.is_some() {
            self.image_alt.push_str(chunk);
            return;
        }
        self.ensure_inline(source);
        // implicit paragraphs (tight list items) grow with their content
        if self.kind == Some("paragraph") && source.end as u32 > self.source.1 {
            self.source.1 = source.end as u32;
        }
        let start = self.text.len() as u32;
        self.text.push_str(chunk);
        if !code && !self.styled() {
            return;
        }
        let href = self.links.last().cloned();
        let incomplete = href.as_deref() == Some(INCOMPLETE_LINK);
        let span = MarkdownSpan {
            start,
            end: self.text.len() as u32,
            bold: self.bold > 0,
            italic: self.italic > 0,
            strikethrough: self.strike > 0,
            code,
            link: match incomplete {
                true => None,
                false => href,
            },
            incomplete_link: incomplete,
        };
        if let Some(last) = self.spans.last_mut()
            && last.end == span.start
            && (last.bold, last.italic, last.strikethrough, last.code) == (span.bold, span.italic, span.strikethrough, span.code)
            && last.link == span.link
            && last.incomplete_link == span.incomplete_link
        {
            last.end = span.end;
            return;
        }
        self.spans.push(span);
    }

    fn emit_image(&mut self, src: String, alt: String, source: &std::ops::Range<usize>) {
        self.close();
        let source = (source.start as u32, source.end as u32);
        let item_start = std::mem::take(&mut self.pending_item);
        self.blocks.push(MarkdownBlock {
            kind: "image".to_string(),
            text: alt,
            spans: Vec::new(),
            level: 0,
            language: String::new(),
            closed: true,
            quote: self.quote,
            list_depth: self
                .lists
                .last()
                .map(|_| self.lists.len() as u32 - 1),
            ordinal: self.lists.last().and_then(|c| c.current.map(|n| n as u32)),
            task: None,
            item_start,
            src,
            rows: Vec::new(),
            aligns: Vec::new(),
            source_start: source.0,
            source_end: source.1,
        });
    }
}

fn heading_level(level: HeadingLevel) -> u32 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

pub fn parse_markdown(source: String, streaming: Option<bool>) -> Vec<MarkdownBlock> {
    let streaming = streaming.unwrap_or(false);
    let mended;
    let input = match streaming {
        true => {
            mended = mend(&source);
            &mended
        }
        false => &source,
    };
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_TABLES;
    let mut b = Builder::default();
    for (event, range) in Parser::new_ext(input, options).into_offset_iter() {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => b.open("paragraph", &range),
                Tag::Heading { level, .. } => {
                    b.open("heading", &range);
                    b.level = heading_level(level);
                }
                Tag::CodeBlock(kind) => {
                    b.open("code", &range);
                    if let CodeBlockKind::Fenced(info) = kind {
                        b.language = info.split_whitespace().next().unwrap_or("").to_string();
                    }
                }
                Tag::BlockQuote(_) => {
                    b.close();
                    b.quote += 1;
                }
                Tag::List(start) => {
                    b.close();
                    b.lists.push(ListCtx {
                        next_ordinal: start,
                        current: None,
                        task: None,
                    });
                }
                Tag::Item => {
                    b.close();
                    if let Some(ctx) = b.lists.last_mut() {
                        ctx.current = ctx.next_ordinal;
                        ctx.next_ordinal = ctx.next_ordinal.map(|n| n + 1);
                    }
                    b.pending_item = true;
                }
                Tag::Table(aligns) => {
                    b.open("table", &range);
                    b.aligns = aligns
                        .iter()
                        .map(|a| {
                            match a {
                                Alignment::Left => "left",
                                Alignment::Center => "center",
                                Alignment::Right => "right",
                                Alignment::None => "none",
                            }
                            .to_string()
                        })
                        .collect();
                }
                Tag::TableHead | Tag::TableRow => b.row = Some(Vec::new()),
                Tag::TableCell => {}
                Tag::Emphasis => b.italic += 1,
                Tag::Strong => b.bold += 1,
                Tag::Strikethrough => b.strike += 1,
                Tag::Link { dest_url, .. } => b.links.push(dest_url.to_string()),
                Tag::Image { dest_url, .. } => b.image = Some(dest_url.to_string()),
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph | TagEnd::Heading(_) => b.close(),
                TagEnd::CodeBlock => {
                    if b.text.ends_with('\n') {
                        b.text.pop();
                    }
                    b.close();
                }
                TagEnd::BlockQuote(_) => {
                    b.close();
                    b.quote = b.quote.saturating_sub(1);
                }
                TagEnd::List(_) => {
                    b.close();
                    b.lists.pop();
                }
                TagEnd::Item => {
                    b.close();
                    if let Some(ctx) = b.lists.last_mut() {
                        ctx.current = None;
                    }
                    b.pending_item = false;
                }
                TagEnd::Table => b.close(),
                TagEnd::TableHead | TagEnd::TableRow => {
                    if let Some(cells) = b.row.take() {
                        b.rows.push(MarkdownRow { cells });
                    }
                }
                TagEnd::TableCell => {
                    let cell = MarkdownCell {
                        text: std::mem::take(&mut b.text),
                        spans: std::mem::take(&mut b.spans),
                    };
                    if let Some(row) = b.row.as_mut() {
                        row.push(cell);
                    }
                }
                TagEnd::Emphasis => b.italic = b.italic.saturating_sub(1),
                TagEnd::Strong => b.bold = b.bold.saturating_sub(1),
                TagEnd::Strikethrough => b.strike = b.strike.saturating_sub(1),
                TagEnd::Link => {
                    b.links.pop();
                }
                TagEnd::Image => {
                    if let Some(src) = b.image.take() {
                        let alt = std::mem::take(&mut b.image_alt);
                        b.emit_image(src, alt, &range);
                    }
                }
                _ => {}
            },
            Event::Text(t) => b.push_text(&t, false, &range),
            Event::Code(t) => b.push_text(&t, true, &range),
            Event::SoftBreak => b.push_text(" ", false, &range),
            Event::HardBreak => b.push_text("\n", false, &range),
            Event::Html(t) | Event::InlineHtml(t) => b.push_text(&t, false, &range),
            Event::Rule => {
                b.close();
                b.open("rule", &range);
                b.close();
            }
            Event::TaskListMarker(checked) => {
                if let Some(ctx) = b.lists.last_mut() {
                    ctx.task = Some(checked);
                }
            }
            Event::FootnoteReference(name) => b.push_text(&format!("[{name}]"), false, &range),
            Event::DisplayMath(t) | Event::InlineMath(t) => b.push_text(&t, true, &range),
        }
    }
    b.close();
    if streaming
        && fence_open(&source)
        && let Some(block) = b.blocks.iter_mut().rev().find(|b| b.kind == "code")
    {
        block.closed = false;
    }
    b.blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(source: &str) -> Vec<MarkdownBlock> {
        parse_markdown(source.to_string(), None)
    }

    fn parse_streaming(source: &str) -> Vec<MarkdownBlock> {
        parse_markdown(source.to_string(), Some(true))
    }

    #[test]
    fn splits_paragraphs_headings_and_code() {
        let blocks = parse("# Title\n\nsome prose\n\n```rust\nfn main() {}\n```");
        assert_eq!(
            blocks.iter().map(|b| b.kind.as_str()).collect::<Vec<_>>(),
            ["heading", "paragraph", "code"]
        );
        assert_eq!((blocks[0].level, blocks[0].text.as_str()), (1, "Title"));
        assert_eq!(blocks[2].language, "rust");
        assert_eq!(blocks[2].text, "fn main() {}");
        assert!(blocks[2].closed);
    }

    #[test]
    fn inline_styles_map_to_display_text_offsets() {
        let blocks = parse("plain **bold** and `code` and *it*");
        let block = &blocks[0];
        assert_eq!(block.text, "plain bold and code and it");
        let at = |needle: &str| {
            let start = block.text.find(needle).unwrap() as u32;
            block
                .spans
                .iter()
                .find(|s| s.start == start)
                .unwrap_or_else(|| panic!("no span at {needle}"))
        };
        assert!(at("bold").bold);
        assert!(at("code").code);
        assert!(at("it").italic);
    }

    #[test]
    fn links_carry_their_href() {
        let blocks = parse("see [docs](https://example.com) now");
        let span = blocks[0].spans.iter().find(|s| s.link.is_some()).unwrap();
        assert_eq!(span.link.as_deref(), Some("https://example.com"));
        assert_eq!(
            &blocks[0].text[span.start as usize..span.end as usize],
            "docs"
        );
    }

    #[test]
    fn lists_carry_depth_ordinal_and_task_state() {
        let blocks = parse("1. first\n2. second\n   - inner\n\n- [x] done\n- [ ] todo");
        let first = &blocks[0];
        assert_eq!(
            (first.list_depth, first.ordinal, first.item_start),
            (Some(0), Some(1), true)
        );
        let inner = blocks.iter().find(|b| b.text == "inner").unwrap();
        assert_eq!(inner.list_depth, Some(1));
        assert_eq!(inner.ordinal, None);
        let done = blocks.iter().find(|b| b.text == "done").unwrap();
        assert_eq!(done.task, Some(true));
        let todo = blocks.iter().find(|b| b.text == "todo").unwrap();
        assert_eq!(todo.task, Some(false));
    }

    #[test]
    fn blockquotes_nest_and_rules_emit() {
        let blocks = parse("> quoted\n\n---\n\nafter");
        assert_eq!(blocks[0].quote, 1);
        assert_eq!(blocks[1].kind, "rule");
        assert_eq!(blocks[2].quote, 0);
    }

    #[test]
    fn images_become_their_own_block() {
        let blocks = parse("![diagram](/tmp/pic.png)");
        assert_eq!(blocks[0].kind, "image");
        assert_eq!(blocks[0].src, "/tmp/pic.png");
        assert_eq!(blocks[0].text, "diagram");
    }

    #[test]
    fn streaming_repairs_trailing_bold_and_marks_incomplete_links() {
        let blocks = parse_streaming("some **bol");
        let block = &blocks[0];
        assert_eq!(block.text, "some bol");
        assert!(block.spans.iter().any(|s| s.bold));

        let blocks = parse_streaming("see [docs](https://exam");
        let span = blocks[0].spans.iter().find(|s| s.incomplete_link).unwrap();
        assert_eq!(span.link, None);
        assert_eq!(
            &blocks[0].text[span.start as usize..span.end as usize],
            "docs"
        );
    }

    #[test]
    fn streaming_marks_open_fence_as_unclosed() {
        let blocks = parse_streaming("```rust\nfn main(");
        let block = blocks.last().unwrap();
        assert_eq!(block.kind, "code");
        assert!(!block.closed);
        assert_eq!(block.text, "fn main(");
    }

    #[test]
    fn finished_text_is_not_repaired() {
        let blocks = parse("a ** b");
        assert_eq!(blocks[0].text, "a ** b");
        assert!(blocks[0].spans.is_empty());
    }

    #[test]
    fn tables_parse_into_rows_with_alignment() {
        let blocks = parse("| Name | Score |\n|:-----|------:|\n| **bold** | 42 |\n| b | 7 |");
        let table = &blocks[0];
        assert_eq!(table.kind, "table");
        assert_eq!(table.aligns, ["left", "right"]);
        assert_eq!(table.rows.len(), 3);
        assert_eq!(table.rows[0].cells[0].text, "Name");
        assert_eq!(table.rows[1].cells[1].text, "42");
        assert!(table.rows[1].cells[0].spans[0].bold);
    }

    #[test]
    fn table_between_paragraphs_keeps_block_order() {
        let blocks = parse("before\n\n| a |\n|---|\n| 1 |\n\nafter");
        assert_eq!(
            blocks.iter().map(|b| b.kind.as_str()).collect::<Vec<_>>(),
            ["paragraph", "table", "paragraph"]
        );
        assert!(blocks[0].rows.is_empty());
        assert!(blocks[2].rows.is_empty());
    }

    #[test]
    fn streaming_partial_table_parses_without_panic() {
        for cut in 0.."| a | b |\n|---|---|\n| 1 | 2".len() {
            parse_streaming(&"| a | b |\n|---|---|\n| 1 | 2"[..cut]);
        }
    }

    #[test]
    fn blocks_carry_their_source_byte_ranges() {
        let source = "# Title\n\nsome **bold** prose\n\n```rust\nlet x = 1;\n```";
        let blocks = parse(source);
        let slice = |b: &MarkdownBlock| &source[b.source_start as usize..b.source_end as usize];
        assert_eq!(slice(&blocks[0]).trim_end(), "# Title");
        assert_eq!(slice(&blocks[1]).trim_end(), "some **bold** prose");
        assert_eq!(slice(&blocks[2]), "```rust\nlet x = 1;\n```");
    }

    #[test]
    fn soft_breaks_join_with_spaces_hard_breaks_keep_lines() {
        let blocks = parse("one\ntwo  \nthree");
        assert_eq!(blocks[0].text, "one two\nthree");
    }
}

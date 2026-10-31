use std::time::Duration;

use similar::{Algorithm, ChangeTag, DiffTag, InlineChangeOptions, TextDiff};

#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEmphasis {
    pub start: u32,
    pub end: u32,
}

#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub kind: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
    pub side_start: u32,
    pub emphasis: Vec<DiffEmphasis>,
    pub count: Option<u32>,
}

fn line_starts(source: &str) -> Vec<u32> {
    let mut starts = Vec::new();
    let mut offset = 0u32;
    for segment in source.split_inclusive('\n') {
        starts.push(offset);
        offset += segment.len() as u32;
    }
    if starts.is_empty() {
        starts.push(0);
    }
    starts
}

fn line_range(source: &str, starts: &[u32], index: usize) -> (u32, u32) {
    let start = starts[index];
    let mut end = starts
        .get(index + 1)
        .copied()
        .unwrap_or(source.len() as u32);
    let bytes = source.as_bytes();
    if end > start && bytes[end as usize - 1] == b'\n' {
        end -= 1;
    }
    if end > start && bytes[end as usize - 1] == b'\r' {
        end -= 1;
    }
    (start, end)
}

fn gap_row(count: u32) -> DiffRow {
    DiffRow {
        kind: "gap".into(),
        old_line: None,
        new_line: None,
        text: String::new(),
        side_start: 0,
        emphasis: Vec::new(),
        count: Some(count),
    }
}

pub fn diff(old_source: String, new_source: String, context_lines: Option<u32>) -> Vec<DiffRow> {
    let context = context_lines.unwrap_or(3) as usize;
    let text_diff = TextDiff::configure()
    /*
      todo: we need to see which algorithm we like the best (configurable ideally) 
      and if there are perf issues we should probably be able to make it just work
     */
        .algorithm(Algorithm::Myers)
        .timeout(Duration::from_millis(500))
        .diff_lines(old_source.as_str(), new_source.as_str());
    let old_starts = line_starts(&old_source);
    let new_starts = line_starts(&new_source);
    let old_line_count = old_source.split_inclusive('\n').count();
    let mut inline_options = InlineChangeOptions::new();
    inline_options.semantic_cleanup(true);

    let mut rows = Vec::new();
    let mut previous_old_end = 0usize;
    for group in text_diff.grouped_ops(context) {
        let Some(first) = group.first() else {
            continue;
        };
        let group_old_start = first.old_range().start;
        if group_old_start > previous_old_end {
            rows.push(gap_row((group_old_start - previous_old_end) as u32));
        }
        for op in &group {
            if op.tag() == DiffTag::Equal {
                let old_range = op.old_range();
                let new_range = op.new_range();
                for at in 0..old_range.len() {
                    let old_index = old_range.start + at;
                    let new_index = new_range.start + at;
                    let (start, end) = line_range(&new_source, &new_starts, new_index);
                    rows.push(DiffRow {
                        kind: "context".into(),
                        old_line: Some(old_index as u32 + 1),
                        new_line: Some(new_index as u32 + 1),
                        text: new_source[start as usize..end as usize].to_string(),
                        side_start: start,
                        emphasis: Vec::new(),
                        count: None,
                    });
                }
                continue;
            }
            for change in text_diff.iter_inline_changes_with_options(op, inline_options) {
                let (kind, source, starts, index) = match change.tag() {
                    ChangeTag::Delete => {
                        ("del", &old_source, &old_starts, change.old_index().unwrap())
                    }
                    ChangeTag::Insert => {
                        ("add", &new_source, &new_starts, change.new_index().unwrap())
                    }
                    ChangeTag::Equal => {
                        ("context", &new_source, &new_starts, change.new_index().unwrap())
                    }
                };
                let (start, end) = line_range(source, starts, index);
                let text_len = end - start;
                let mut emphasis = Vec::new();
                let mut cursor = 0u32;
                for (emphasized, value) in change.values() {
                    let value_len = value.len() as u32;
                    if *emphasized {
                        let run_start = cursor;
                        let run_end = (cursor + value_len).min(text_len);
                        if run_start < run_end {
                            emphasis.push(DiffEmphasis {
                                start: run_start,
                                end: run_end,
                            });
                        }
                    }
                    cursor += value_len;
                }
                rows.push(DiffRow {
                    kind: kind.into(),
                    old_line: change.old_index().map(|i| i as u32 + 1),
                    new_line: change.new_index().map(|i| i as u32 + 1),
                    text: source[start as usize..end as usize].to_string(),
                    side_start: start,
                    emphasis,
                    count: None,
                });
            }
        }
        previous_old_end = group.last().map_or(previous_old_end, |op| op.old_range().end);
    }
    if old_line_count > previous_old_end {
        rows.push(gap_row((old_line_count - previous_old_end) as u32));
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(rows: &[DiffRow]) -> String {
        rows.iter()
            .map(|r| match r.kind.as_str() {
                "context" => ' ',
                "del" => '-',
                "add" => '+',
                "gap" => '~',
                _ => '?',
            })
            .collect()
    }

    #[test]
    fn produces_context_del_add_and_gap_rows() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n";
        let new = "a\nb\nc\nd\nE\nf\ng\nh\ni\nj\nk\n";
        let rows = diff(old.into(), new.into(), Some(2));
        assert_eq!(kinds(&rows), "~  -+  ~");
        let del = rows.iter().find(|r| r.kind == "del").unwrap();
        assert_eq!(del.text, "e");
        assert_eq!(del.old_line, Some(5));
        assert_eq!(&old[del.side_start as usize..][..1], "e");
        let add = rows.iter().find(|r| r.kind == "add").unwrap();
        assert_eq!(add.text, "E");
        assert_eq!(add.new_line, Some(5));
        assert_eq!(&new[add.side_start as usize..][..1], "E");
        assert_eq!(rows[0].count, Some(2));
        assert_eq!(rows.last().unwrap().count, Some(4));

        let rows = diff("a\nx\nb\n".into(), "a\nb\nc\n".into(), None);
        let del = rows.iter().find(|r| r.kind == "del").unwrap();
        assert_eq!((del.old_line, del.new_line), (Some(2), None));
        let add = rows.iter().find(|r| r.kind == "add").unwrap();
        assert_eq!((add.old_line, add.new_line), (None, Some(3)));
    }

    #[test]
    fn emphasis_marks_the_changed_word_only() {
        let old = "let count = old_value + 1;\n";
        let new = "let count = new_value + 1;\n";
        let rows = diff(old.into(), new.into(), None);
        let del = rows.iter().find(|r| r.kind == "del").unwrap();
        assert_eq!(del.emphasis.len(), 1);
        let e = &del.emphasis[0];
        assert_eq!(&del.text[e.start as usize..e.end as usize], "old_value");
        let add = rows.iter().find(|r| r.kind == "add").unwrap();
        let e = &add.emphasis[0];
        assert_eq!(&add.text[e.start as usize..e.end as usize], "new_value");

        let old = "completely different content here\n";
        let new = "nothing shared with that line\n";
        let rows = diff(old.into(), new.into(), None);
        for row in rows {
            assert!(row.emphasis.is_empty(), "no emphasis on unrelated lines");
        }
    }

    #[test]
    fn new_file_is_all_additions() {
        let rows = diff(String::new(), "one\ntwo\n".into(), None);
        assert_eq!(kinds(&rows), "++");
        assert_eq!(rows[0].text, "one");
        assert_eq!(rows[1].new_line, Some(2));
    }
}


pub const INCOMPLETE_LINK: &str = "#__incomplete__";

pub fn fence_open(source: &str) -> bool {
    scan_lines(source, |_, _| {}).is_some()
}

fn scan_lines(
    source: &str,
    mut visit: impl FnMut(std::ops::Range<usize>, bool),
) -> Option<(u8, usize)> {
    let mut fence: Option<(u8, usize)> = None;
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        let end = offset + line.len();
        let stripped = line.trim_start_matches(' ');
        let indent = line.len() - stripped.len();
        let run_char = stripped.as_bytes().first().copied();
        let run_len = match run_char {
            Some(c @ (b'`' | b'~')) => stripped.bytes().take_while(|&b| b == c).count(),
            _ => 0,
        };
        let fence_marker = indent <= 3 && run_len >= 3;
        match fence {
            Some((c, len)) => {
                visit(offset..end, true);
                if fence_marker
                    && run_char == Some(c)
                    && run_len >= len
                    && stripped[run_len..].trim().is_empty()
                {
                    fence = None;
                }
            }
            None => {
                visit(offset..end, fence_marker);
                if fence_marker {
                    fence = Some((run_char.expect("fence marker has a first byte"), run_len));
                }
            }
        }
        offset = end;
    }
    fence
}

pub fn mend(source: &str) -> String {
    if fence_open(source) {
        return source.to_string();
    }
    let mut text = match source.ends_with(' ') && !source.ends_with("  ") {
        true => source[..source.len() - 1].to_string(),
        false => source.to_string(),
    };
    let mut mask = vec![false; text.len()];
    let mut tail_start = 0;
    let snapshot = text.clone();
    scan_lines(&snapshot, |range, in_fence| {
        if in_fence {
            mask[range].fill(true);
        } else if snapshot[range.clone()].trim().is_empty() {
            tail_start = range.end;
        }
    });
    close_inline_code(&mut text, &mut mask, tail_start);
    repair_link(&mut text, &mut mask, tail_start);
    repair_emphasis(&mut text, &mut mask, tail_start);
    text
}

fn push_masked(text: &mut String, mask: &mut Vec<bool>, s: &str) {
    text.push_str(s);
    mask.resize(text.len(), true);
}

fn truncate_trim(text: &mut String, mask: &mut Vec<bool>, at: usize) {
    text.truncate(at);
    while text.ends_with(' ') {
        text.pop();
    }
    mask.truncate(text.len());
}

fn close_inline_code(text: &mut String, mask: &mut Vec<bool>, tail_start: usize) {
    let bytes = text.as_bytes();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut i = tail_start;
    while i < bytes.len() {
        if mask[i] || bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && !mask[i] && bytes[i] == b'`' {
            i += 1;
        }
        runs.push((start, i - start));
    }
    let mut open: Option<(usize, usize)> = None;
    for (pos, len) in runs {
        match open {
            None => open = Some((pos, len)),
            Some((opener, opener_len)) if len == opener_len => {
                mask[opener..pos + len].fill(true);
                open = None;
            }
            Some(_) => {}
        }
    }
    if let Some((opener, opener_len)) = open {
        if text[opener + opener_len..].trim().is_empty() {
            truncate_trim(text, mask, opener);
        } else {
            mask[opener..].fill(true);
            push_masked(text, mask, &"`".repeat(opener_len));
        }
    }
}

fn repair_link(text: &mut String, mask: &mut Vec<bool>, tail_start: usize) {
    let bytes = text.as_bytes().to_vec();
    let find =
        |from: usize, target: u8| (from..bytes.len()).find(|&i| !mask[i] && bytes[i] == target);
    let Some(open) = (tail_start..bytes.len())
        .rev()
        .find(|&i| !mask[i] && bytes[i] == b'[')
    else {
        return;
    };
    let image_start = (open > 0 && bytes[open - 1] == b'!' && !mask[open - 1]).then(|| open - 1);
    match find(open + 1, b']') {
        None => {
            if let Some(bang) = image_start {
                truncate_trim(text, mask, bang);
            } else if text[open + 1..].trim().is_empty() {
                truncate_trim(text, mask, open);
            } else {
                push_masked(text, mask, &format!("]({INCOMPLETE_LINK})"));
            }
        }
        Some(close) => {
            if bytes.get(close + 1) == Some(&b'(') && find(close + 2, b')').is_none() {
                if let Some(bang) = image_start {
                    truncate_trim(text, mask, bang);
                } else {
                    text.truncate(close + 2);
                    mask.truncate(close + 2);
                    push_masked(text, mask, &format!("{INCOMPLETE_LINK})"));
                }
            }
        }
    }
}

fn repair_emphasis(text: &mut String, mask: &mut Vec<bool>, tail_start: usize) {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut stack: Vec<(String, usize, usize)> = Vec::new();
    let mut strip_at: Option<usize> = None;
    let mut k = chars
        .iter()
        .position(|&(i, _)| i >= tail_start)
        .unwrap_or(chars.len());
    while k < chars.len() {
        let (i, c) = chars[k];
        if mask[i] || !matches!(c, '*' | '_' | '~') {
            k += 1;
            continue;
        }
        let mut j = k;
        while j < chars.len() && chars[j].1 == c && !mask[chars[j].0] {
            j += 1;
        }
        let prev = (k > 0).then(|| chars[k - 1].1);
        let next = (j < chars.len()).then(|| chars[j].1);
        let can_open = next.is_some_and(|ch| !ch.is_whitespace())
            && (c != '_' || prev.is_none_or(|p| !p.is_alphanumeric()));
        let can_close = prev.is_some_and(|ch| !ch.is_whitespace())
            && (c != '_' || next.is_none_or(|n| !n.is_alphanumeric()));
        let mut remaining = j - k;
        let mut offset = i;
        // single ~ is left alone: too likely to be literal (~5ms, ~/path)
        while remaining > 0 && !(c == '~' && remaining < 2) {
            let width = if remaining >= 2 { 2 } else { 1 };
            let unit: String = std::iter::repeat_n(c, width).collect();
            let closed = can_close
                && stack
                    .iter()
                    .rposition(|(u, _, _)| *u == unit)
                    .map(|idx| stack.truncate(idx))
                    .is_some();
            if !closed {
                if can_open {
                    stack.push((unit, offset, offset + width));
                } else if next.is_none() {
                    strip_at.get_or_insert(offset);
                }
            }
            remaining -= width;
            offset += width;
        }
        k = j;
    }
    if let Some(at) = strip_at {
        truncate_trim(text, mask, at);
    }
    let mut closers = String::new();
    while let Some((unit, start, end)) = stack.pop() {
        if closers.is_empty() && text[end.min(text.len())..].trim().is_empty() {
            truncate_trim(text, mask, start.min(text.len()));
        } else {
            closers.push_str(&unit);
        }
    }
    text.push_str(&closers);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_unclosed_bold() {
        assert_eq!(mend("**This is bol"), "**This is bol**");
    }

    #[test]
    fn completes_nested_emphasis_innermost_first() {
        assert_eq!(mend("**bold *ital"), "**bold *ital***");
    }

    #[test]
    fn completes_bold_italic_run() {
        assert_eq!(mend("***both"), "***both***");
    }

    #[test]
    fn completes_strikethrough_and_inline_code() {
        assert_eq!(mend("~~gone"), "~~gone~~");
        assert_eq!(mend("`const x ="), "`const x =`");
    }

    #[test]
    fn markers_inside_code_are_untouched() {
        assert_eq!(mend("`a ** b"), "`a ** b`");
        assert_eq!(
            mend("```\n** not emphasis\n```"),
            "```\n** not emphasis\n```"
        );
    }

    #[test]
    fn open_fence_passes_through_unchanged() {
        assert_eq!(mend("```js\nlet a = 1;"), "```js\nlet a = 1;");
    }

    #[test]
    fn word_internal_underscores_are_literal() {
        assert_eq!(mend("use snake_case here"), "use snake_case here");
    }

    #[test]
    fn single_tilde_is_literal() {
        assert_eq!(mend("takes ~5ms"), "takes ~5ms");
    }

    #[test]
    fn list_bullets_are_not_emphasis() {
        assert_eq!(mend("* item one\n* item two"), "* item one\n* item two");
    }

    #[test]
    fn trailing_bare_marker_is_hidden() {
        assert_eq!(mend("done. **"), "done.");
        assert_eq!(mend("done. ~~"), "done.");
        assert_eq!(mend("real `"), "real");
        assert_eq!(mend("**a****"), "**a**");
    }

    #[test]
    fn trailing_space_is_stripped_so_closers_bind() {
        assert_eq!(mend("**bold "), "**bold**");
        assert_eq!(mend("**bold x "), "**bold x**");
    }

    #[test]
    fn incomplete_link_gets_placeholder_href() {
        assert_eq!(
            mend("[click here"),
            format!("[click here]({INCOMPLETE_LINK})")
        );
        assert_eq!(
            mend("[click](https://exam"),
            format!("[click]({INCOMPLETE_LINK})")
        );
    }

    #[test]
    fn complete_link_is_untouched() {
        assert_eq!(mend("[a](https://b.c) tail"), "[a](https://b.c) tail");
    }

    #[test]
    fn incomplete_image_is_removed() {
        assert_eq!(mend("look: ![alt tex"), "look:");
        assert_eq!(mend("look: ![alt](/tmp/x.pn"), "look:");
    }

    #[test]
    fn earlier_paragraphs_are_not_repaired() {
        assert_eq!(mend("a ** b\n\nnew tail"), "a ** b\n\nnew tail");
    }

    #[test]
    fn complete_fence_in_tail_is_not_inline_code() {
        let doc = "intro\n```js\nlet a = 1;\n```\nafter **bol";
        assert_eq!(mend(doc), format!("{doc}**"));
    }
}

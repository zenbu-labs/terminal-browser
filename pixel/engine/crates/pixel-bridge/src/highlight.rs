use std::collections::HashMap;
use std::sync::OnceLock;

use tree_sitter_highlight::{Highlight, HighlightConfiguration, HighlightEvent, Highlighter};

pub const CAPTURE_NAMES: &[&str] = &[
    "attribute",
    "comment",
    "constant",
    "constructor",
    "embedded",
    "escape",
    "function",
    "keyword",
    "number",
    "operator",
    "property",
    "punctuation",
    "string",
    "tag",
    "type",
    "variable",
];
/**
 * we eventually will lazily download this
 */
fn canonical(language: &str) -> Option<&'static str> {
    Some(match language.to_ascii_lowercase().as_str() {
        "js" | "jsx" | "javascript" | "mjs" | "cjs" => "javascript",
        "ts" | "typescript" => "typescript",
        "tsx" => "tsx",
        "rs" | "rust" => "rust",
        "py" | "python" => "python",
        "json" | "jsonc" => "json",
        "sh" | "bash" | "shell" | "zsh" => "bash",
        _ => return None,
    })
}

fn configs() -> &'static HashMap<&'static str, HighlightConfiguration> {
    static CONFIGS: OnceLock<HashMap<&'static str, HighlightConfiguration>> = OnceLock::new();
    CONFIGS.get_or_init(|| {
        let mut map = HashMap::new();
        let mut add = |name: &'static str,
                       language: tree_sitter::Language,
                       highlights: &str,
                       injections: &str,
                       locals: &str| {
            match HighlightConfiguration::new(language, name, highlights, injections, locals) {
                Ok(mut config) => {
                    config.configure(CAPTURE_NAMES);
                    map.insert(name, config);
                }
                Err(e) => pixel_core::logging::error("highlight", format!("{name}: {e}")),
            }
        };
        let js = format!(
            "{}\n{}",
            tree_sitter_javascript::HIGHLIGHT_QUERY,
            tree_sitter_javascript::JSX_HIGHLIGHT_QUERY
        );
        let ts = format!(
            "{}\n{}",
            tree_sitter_javascript::HIGHLIGHT_QUERY,
            tree_sitter_typescript::HIGHLIGHTS_QUERY
        );
        let tsx = format!("{js}\n{}", tree_sitter_typescript::HIGHLIGHTS_QUERY);
        add(
            "javascript",
            tree_sitter_javascript::LANGUAGE.into(),
            &js,
            tree_sitter_javascript::INJECTIONS_QUERY,
            tree_sitter_javascript::LOCALS_QUERY,
        );
        add(
            "typescript",
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            &ts,
            "",
            tree_sitter_typescript::LOCALS_QUERY,
        );
        add(
            "tsx",
            tree_sitter_typescript::LANGUAGE_TSX.into(),
            &tsx,
            "",
            tree_sitter_typescript::LOCALS_QUERY,
        );
        add(
            "rust",
            tree_sitter_rust::LANGUAGE.into(),
            tree_sitter_rust::HIGHLIGHTS_QUERY,
            tree_sitter_rust::INJECTIONS_QUERY,
            "",
        );
        add(
            "python",
            tree_sitter_python::LANGUAGE.into(),
            tree_sitter_python::HIGHLIGHTS_QUERY,
            "",
            "",
        );
        add(
            "json",
            tree_sitter_json::LANGUAGE.into(),
            tree_sitter_json::HIGHLIGHTS_QUERY,
            "",
            "",
        );
        add(
            "bash",
            tree_sitter_bash::LANGUAGE.into(),
            tree_sitter_bash::HIGHLIGHT_QUERY,
            "",
            "",
        );
        map
    })
}

#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightSpan {
    pub start: u32,
    pub end: u32,
    pub capture: u32,
}

pub fn highlight(source: String, language: String) -> Vec<HighlightSpan> {
    let Some(name) = canonical(&language) else {
        return Vec::new();
    };
    let Some(config) = configs().get(name) else {
        return Vec::new();
    };
    let mut highlighter = Highlighter::new();
    let Ok(events) = highlighter.highlight(config, source.as_bytes(), None, |lang| {
        canonical(lang).and_then(|n| configs().get(n))
    }) else {
        return Vec::new();
    };
    let mut spans = Vec::new();
    let mut active: Vec<u32> = Vec::new();
    for event in events {
        match event {
            Ok(HighlightEvent::HighlightStart(Highlight(i))) => active.push(i as u32),
            Ok(HighlightEvent::HighlightEnd) => {
                active.pop();
            }
            Ok(HighlightEvent::Source { start, end }) => {
                if let Some(&capture) = active.last() {
                    spans.push(HighlightSpan {
                        start: start as u32,
                        end: end as u32,
                        capture,
                    });
                }
            }
            Err(_) => break,
        }
    }
    spans
}

#[cfg_attr(test, allow(dead_code))]
pub fn highlight_captures() -> Vec<String> {
    CAPTURE_NAMES.iter().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture_of(source: &str, language: &str, token: &str) -> Option<&'static str> {
        let at = source.find(token).unwrap() as u32;
        let spans = highlight(source.into(), language.into());
        assert!(!spans.is_empty(), "no spans for {language}");
        spans
            .iter()
            .find(|s| s.start <= at && at < s.end)
            .map(|s| CAPTURE_NAMES[s.capture as usize])
    }

    #[test]
    fn highlights_common_tokens_per_language() {
        let rust = "fn main() { let s = \"hi\"; } // done";
        assert_eq!(capture_of(rust, "rust", "fn"), Some("keyword"));
        assert_eq!(capture_of(rust, "rust", "\"hi\""), Some("string"));
        assert_eq!(capture_of(rust, "rust", "// done"), Some("comment"));

        let ts = "const n: number = 42;";
        assert_eq!(capture_of(ts, "ts", "const"), Some("keyword"));
        assert_eq!(capture_of(ts, "ts", "number"), Some("type"));
        assert_eq!(capture_of(ts, "ts", "42"), Some("number"));

        let py = "def greet():\n    return 'hey'\n";
        assert_eq!(capture_of(py, "python", "def"), Some("keyword"));
        assert_eq!(capture_of(py, "python", "greet"), Some("function"));

        assert_eq!(capture_of("{\"a\": 1}", "json", "\"a\""), Some("string"));
        assert_eq!(capture_of("echo $HOME", "bash", "echo"), Some("function"));

        assert!(highlight("fn main() {}".into(), "brainfuck".into()).is_empty());
    }
}

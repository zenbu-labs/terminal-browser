use pixel_bridge::{highlight::highlight, markdown::parse_markdown};

const SAMPLES: &[&str] = &[
    "Hi again, Rob! (｡•̀ᴗ-)✧ What are we building today? ヽ(・∀・)ﾉ",
    "Here's the plan (◕‿◕✿):\n\n1. **Fix** the `crash` — *now*\n2. Ship 🚀\n\n```rust\nfn main() { println!(\"héllo — 世界\"); }\n```\n\n| a | b |\n|---|---|\n| ✓ | ✗ |\n> quote ¯\\_(ツ)_/¯ [link](https://ex.com/ü)",
    "- [x] done ✅\n- [ ] todo\n\n~~strike~~ __bold__ _it_ `code` \u{202f}AM\n\n```ts\nconst s = `${\"ü\"}`; // 💥\n```",
];

#[test]
fn every_prefix_parses() {
    for sample in SAMPLES {
        let mut cut = 0;
        while cut <= sample.len() {
            if sample.is_char_boundary(cut) {
                let _ = parse_markdown(sample[..cut].to_string(), Some(true));
                let _ = parse_markdown(sample[..cut].to_string(), Some(false));
            }
            cut += 1;
        }
        for lang in ["rust", "ts", "typescript", "js", "python", "json", "bash", "tsx"] {
            let _ = highlight(sample.to_string(), lang.to_string());
        }
    }
}

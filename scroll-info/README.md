<!-- fixme: placeholder copy (whole file) -->

# Scroll changes from the pixelcode pixel fork

Reference material for porting pixel's scroll fixes from pixelcode's fork of pixel into `main`.
Nothing in this folder is meant to be merged as is. Read it, then write a clean implementation on top of current `main`.

## Where this came from

- pixelcode vendors pixel from a terminal-browser checkout at `pixelcode/.local/terminal-browser`, branch `pixelcode-patches` (head `9781d044`).
- That branch split from `main` at `c2a7e27c` (Oct 26, 2026). This branch was cut from `main` at `79c1f79f`.
- Since the split, `main` has not touched pixel's own scroll code (`engine/scroll.rs`, `engine/pointer.rs`, `native_pairing.rs`, the wheel parsing in `terminal.rs`). Its only wheel change is the Electron patch `pixel/electron/patches/0004-osr-wheel-phase.patch`, which is about wheel events inside web pages and is unrelated. So every difference below goes one way: fork → main.

## What's in this folder

| Path | What it is |
| --- | --- |
| `patches/0001`–`0005` | The fork's scroll commits, as `git format-patch` output. The most precise source; each commit message explains its reason. |
| `pixelcode-files/` | Full copies of the affected files as they are on the fork, paths relative to `pixel/`. Use these to read the code in context. |
| `main-vs-pixelcode.diff` | `git diff main pixelcode-patches` for those same files. It also contains unrelated fork work (video import, root APIs, guests), so prefer the patches when deciding what belongs to scrolling. |

## How pixel's scrolling works (same on both branches)

1. **Terminal wheel ticks.** The terminal reports each wheel step as an SGR mouse report (buttons 64/65/66/67). `terminal.rs` parses them into `Mouse { kind: ScrollUp | ScrollDown | ScrollLeft | ScrollRight, x, y, mods }`. Coordinates are cells, or pixels when the terminal accepted mode 1016 (SGR pixel mouse).
2. **Native trackpad deltas (macOS).** `native.rs` runs a helper that reads real trackpad scroll events with phases and momentum. These are much smoother than terminal ticks, but they carry no pane identity.
3. **Pairing.** `engine/native_pairing.rs` decides whether a burst of native deltas belongs to this pane: it holds native deltas until a terminal wheel tick arrives in the same window (`PAIR_WINDOW` 250 ms), proving that the scroll is happening over us. Once paired, native deltas drive scrolling and the terminal ticks are swallowed. `engine/hover.rs` (the hover oracle) helps by tracking where the pointer is.
4. **Delivery.** `engine/pointer.rs::handle_mouse` routes ticks: into pairing when native scroll is on, otherwise straight to the tree. `engine/scroll.rs::drain_native` turns paired deltas into either a JS `onWheel` event (`emit_wheel`) or movement of the scroll area under the pointer (`scroll_area_at`). It also handles smooth scrolling, scrollbars and `scroll_into_view`.

## The changes to port

### 1. `aa035b0d`: stop dropping every other wheel tick (patch 0002), the biggest user-visible one

`main` still has a 2 ms "kitty echo" filter in `pointer.rs` (`WHEEL_ECHO_WINDOW`, `last_wheel_tick`, `wheel_echo_consumed`). It drops a tick that repeats the previous one at the same spot. kitty, Ghostty and the iOS terminal send one tick per line of travel, so those repeats are real distance, and the filter halves fast scrolls. The original pixel had already removed it (`bf7fc3e`).

The fix deletes the filter. It also stops caching `pixel_mouse` once in `Engine::new` / retarget, and asks `self.term.reports_pixel_mouse()` live at each use (`pointer.rs`, `scroll.rs`). Change 2 depends on that.

Before shipping, confirm on kitty that ticks really aren't doubled. Someone saw doubling there once, and that's why the filter exists.

### 2. `4d343c91`: a late 1016 answer switches mouse reports to pixels (patch 0004)

At startup pixel asks the terminal whether it supports pixel mouse reports (DECRQM for mode 1016) and waits about 150 ms. Over a slow link, such as SSH, the answer can arrive late, and `main` then stays on cell coordinates for the whole session. With cell coordinates, wheel positions and pairing are coarse.

The fix, all in `terminal.rs`:
- A late "yes", read in a later probe or from the input stream, turns 1016 on again.
- A mouse report whose position is past the cell grid is taken as pixels, whatever pixel believed before.

Tests are included in the patch.

### 3. `a8a7feab`: `onWheel` on a scrolling Box observes instead of taking the wheel (patch 0001)

On `main`, any `onWheel` listener under the pointer takes the wheel, including one on the scroll area itself. A Box with `overflow: "scroll"` plus `onWheel` therefore never scrolls from terminal ticks. pixelcode's transcript didn't scroll over SSH because of this.

The fix:
- `pointer.rs::emit_wheel` returns `tree.scroll_area(node).is_none()`. A scroll area's own listener only observes, while any other listener still takes the wheel. That keeps `onWheel={() => {}}` working as a scroll blocker, and lets a canvas pan or zoom itself.
- `scroll.rs::drain_native` calls `emit_wheel` first, and falls through to scrolling the area when the listener only observed.
- The patch also documents this in `AGENT-DOCS.md`.

This changes behavior for any caller that relied on `onWheel` to stop its own scroll Box from scrolling. Check terminal-browser for that before porting.

### 4. `40ea1a57`: test only (patch 0003)

Adds a test that a burst of SGR-pixel wheel ticks, all arriving in one read, parses into one event per tick. Port it together with change 1.

### 5. `4ff5538d`: scroll-adjacent features (patch 0005), optional and larger

- **`Box onViewport` + `viewportMargin`.** The engine reports when a box comes within N pixels of what its scroll area shows, and when it leaves. That's `scroll.rs::emit_viewport_events` plus tracking in `tree/mod.rs`, with tests in `tree/tests.rs`. pixelcode uses it to load inline pages lazily.
- **`WebView passWheel`.** While a page isn't focused, the wheel scrolls whatever is around it instead of the page, until a click focuses it. This lives in `webview.tsx` and `web/input.ts`.
- **Also in this commit, not about scrolling:** `lazy`, `pauseOffscreen`, `onContentHeight`, and focus/hover callbacks. Port them separately, if at all.

## Suggested order

1. Changes 1 and 4 together (small; deletes code).
2. Change 2 (`terminal.rs` only, with tests).
3. Change 3, after auditing `onWheel` users.
4. Change 5, only if `onViewport` or `passWheel` is wanted on `main`.

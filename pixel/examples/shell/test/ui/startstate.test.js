const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { PixelView } = require("../../dist/terminal/embed.js");
const { runFake, pxsh, makeHome, uiEnv, screenOf, ARTIFACTS } = require("../../test-support/harness.js");
const { render } = require("../../test-support/screenshot.js");

const skip = PixelView.available() ? false : "pixel is not built";

const CMD_SHIFT_E = "\\x1b[101;10u";
const ESCAPE = "\\x1b[27u";
const CTRL_SPACE = "\\x1b[32;5u";
const VIEW_BOOT = { sleep: 4000 };
const GHOSTTY_PROMPT = "PS1=$'%{\\e]133;A;cl=line\\a%}READY> %{\\e]133;B\\a%}'\nunsetopt PROMPT_SP\n";
const OLD_LINES = 25;

const press = (col, row) => ({ send: `\\x1b[<0;${col};${row}M` });
const release = (col, row) => ({ send: `\\x1b[<0;${col};${row}m` });
const hover = (col, row) => ({ send: `\\x1b[<35;${col};${row}M` });

function homeWithGhosttyPrompt(zshrc = "") {
  const home = makeHome();
  fs.writeFileSync(path.join(home, ".zshrc"), GHOSTTY_PROMPT + zshrc);
  return home;
}

function isPlaceholder(c) {
  return c.codePointAt(0) === 0x10eeee;
}

function placeholderRows(screen) {
  return screen.lines.map((line, row) => ([...line].some(isPlaceholder) ? row : -1)).filter((row) => row >= 0);
}

function promptRow(screen) {
  return screen.text.findLastIndex((line) => line.startsWith("READY>"));
}

function oldLinesOnScreen(screen) {
  return screen.text.filter((line) => line.startsWith("old output"));
}

function assertOldOutputIntact(screen, lines = OLD_LINES) {
  const scrolledOff = screen.scrollback.filter((line) => line.startsWith("old output"));
  const shown = oldLinesOnScreen(screen);
  const expected = Array.from({ length: lines }, (_, i) => `old output ${i + 1}`);
  assert.deepEqual([...scrolledOff, ...shown], expected, "every old line is either still on screen, unchanged, or in the scrollback, in order");
  const firstShown = screen.text.indexOf(shown[0]);
  assert.deepEqual(screen.text.slice(firstShown, firstShown + shown.length), shown, "the old lines on screen are contiguous");
}

function shot(run, mark, file) {
  if (!process.env.PXSH_ARTIFACTS) return;
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  render({ capture: run.capture, frames: run.frames, at: run.marks[mark], out: path.join(ARTIFACTS, file), cols: run.size.cols, rows: run.size.rows });
}

test("started below old output, cmd+shift+e opens the bar at the prompt, and closing it leaves every old line in place", { skip }, () => {
  const run = runFake({
    name: "startstate-bar",
    command: pxsh,
    env: uiEnv(homeWithGhosttyPrompt()),
    frames: true,
    oldOutput: OLD_LINES,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { mark: "before" },
      { send: CMD_SHIFT_E },
      { sleep: 2000 },
      { mark: "open" },
      { send: "tall answer please" },
      { sleep: 300 },
      { send: "\\r" },
      { sleep: 2500 },
      { mark: "answered" },
      { send: ESCAPE },
      { sleep: 1000 },
      { mark: "closed" },
      { send: "exit\\r" },
    ],
  });
  shot(run, "open", "startstate-bar-open.png");
  shot(run, "answered", "startstate-bar-answered.png");
  shot(run, "closed", "startstate-bar-closed.png");
  const before = screenOf(run, "before");
  assert.equal(promptRow(before), OLD_LINES, "zsh's prompt starts where the cursor was");
  assert.deepEqual(before.cursor, [7, OLD_LINES]);
  const open = screenOf(run, "open");
  const rows = placeholderRows(open);
  const prompt = promptRow(open);
  assert.ok(rows.length > 2, "the bar shows");
  assert.equal(rows[0], prompt + 1, `the bar starts right under the prompt at row ${prompt}, not at row ${rows[0]}`);
  assert.deepEqual(open.cursor, [7, prompt]);
  for (const line of oldLinesOnScreen(open)) assert.match(line, /^old output \d+$/, "the bar never covers an old line");
  assertOldOutputIntact(open);
  const answered = screenOf(run, "answered");
  const grown = placeholderRows(answered);
  const promptAfterAnswer = promptRow(answered);
  assert.ok(grown.length > rows.length + 3, `the bar grew with the answer: ${rows.length} → ${grown.length} rows`);
  assert.ok(promptAfterAnswer < prompt, "the screen scrolled up to make room for it");
  assert.equal(grown[0], promptAfterAnswer + 1, "the bar still starts right under the prompt");
  assert.ok(grown.at(-1) < run.size.rows - 0, "and fits on the screen");
  assertOldOutputIntact(answered);
  const closed = screenOf(run, "closed");
  assert.equal(closed.placeholders, 0);
  assertOldOutputIntact(closed);
  assert.equal(promptRow(closed), promptAfterAnswer);
  assert.equal(closed.cursor[1], promptAfterAnswer);
});

test("started below old output, ctrl+space opens the popup with its corner at the real caret", { skip }, () => {
  const home = homeWithGhosttyPrompt("autoload -Uz compinit && compinit -u\n");
  for (const file of ["alpha.txt", "alpine.md", "alps", "altitude", "beta"]) fs.writeFileSync(path.join(home, file), "");
  fs.writeFileSync(path.join(home, ".zsh_history"), "cat alpha.txt\ngit status\n");
  const run = runFake({
    name: "startstate-completion",
    command: pxsh,
    env: uiEnv(home),
    frames: true,
    oldOutput: OLD_LINES,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { send: "cat al" },
      { sleep: 300 },
      { mark: "before" },
      { send: CTRL_SPACE },
      { sleep: 1500 },
      { mark: "popup" },
      { send: ESCAPE },
      { sleep: 800 },
      { mark: "closed" },
      { send: "\\x15exit\\r" },
    ],
  });
  shot(run, "popup", "startstate-completion-popup.png");
  const before = screenOf(run, "before");
  assert.deepEqual(before.cursor, [13, OLD_LINES]);
  const popup = screenOf(run, "popup");
  const caretRow = promptRow(popup);
  assert.equal(popup.text[caretRow], "READY> cat al", "the line stays visible");
  const rows = placeholderRows(popup);
  assert.ok(rows.length > 2, "the popup shows");
  assert.equal(rows[0], caretRow + 1, "the popup's top is right under the caret");
  assert.equal(popup.grid[rows[0]].findIndex((cell) => cell && isPlaceholder(cell)), 13, "and its left edge at the caret's column");
  assert.ok(rows.at(-1) < run.size.rows);
  assertOldOutputIntact(popup);
  const closed = screenOf(run, "closed");
  assert.equal(closed.placeholders, 0);
  assertOldOutputIntact(closed);
});

test("started below old output, clicks on the bar's buttons work at the rows the bar is drawn at", { skip }, () => {
  const home = homeWithGhosttyPrompt();
  const log = path.join(home, "codex.log");
  const promptAfterRoom = OLD_LINES - 1;
  const send = [65, promptAfterRoom + 4];
  const close = [65, promptAfterRoom + 2];
  const run = runFake({
    name: "startstate-clicks",
    command: pxsh,
    env: { ...uiEnv(home), FAKE_CODEX_LOG: log },
    frames: true,
    oldOutput: OLD_LINES,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { send: CMD_SHIFT_E },
      { sleep: 2000 },
      { mark: "bar" },
      { send: "list files" },
      { sleep: 300 },
      hover(...send),
      { sleep: 200 },
      press(...send),
      { sleep: 2500 },
      { mark: "answered" },
      hover(...close),
      { sleep: 200 },
      press(...close),
      { sleep: 90 },
      release(...close),
      { sleep: 1000 },
      { mark: "closed" },
      { send: "\\x15exit\\r" },
    ],
  });
  const bar = screenOf(run, "bar");
  assert.equal(promptRow(bar), promptAfterRoom, "the prompt moved up one line to make room, as in the first test");
  const methods = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).method);
  assert.equal(methods.filter((m) => m === "turn/start").length, 1, "clicking send sent the question");
  const answered = screenOf(run, "answered");
  assert.equal(answered.text[promptRow(answered)], "READY> ls -la", "the answer wrote its command");
  const closed = screenOf(run, "closed");
  assert.equal(closed.placeholders, 0, "clicking close closed the bar");
  assertOldOutputIntact(closed);
});

test("when the terminal never says where the cursor is, pxsh starts on the bottom row and the bar still opens at the prompt", { skip }, () => {
  const run = runFake({
    name: "startstate-no-answer",
    command: pxsh,
    env: uiEnv(homeWithGhosttyPrompt()),
    frames: true,
    oldOutput: OLD_LINES,
    noDsr: true,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { mark: "before" },
      { send: CMD_SHIFT_E },
      { sleep: 2000 },
      { mark: "open" },
      { send: ESCAPE },
      { sleep: 1000 },
      { mark: "closed" },
      { send: "exit\\r" },
    ],
  });
  shot(run, "open", "startstate-no-answer-open.png");
  const before = screenOf(run, "before");
  assert.equal(promptRow(before), run.size.rows - 1);
  assertOldOutputIntact(before);
  const open = screenOf(run, "open");
  const rows = placeholderRows(open);
  assert.ok(rows.length > 2);
  assert.equal(rows[0], promptRow(open) + 1, "the bar starts right under the prompt");
  assertOldOutputIntact(open);
  const closed = screenOf(run, "closed");
  assert.equal(closed.placeholders, 0);
  assertOldOutputIntact(closed);
});

test("after a clear every row is pxsh's own, so the bar opens above a prompt at the bottom as it always did", { skip }, () => {
  const run = runFake({
    name: "startstate-clear",
    command: pxsh,
    env: uiEnv(homeWithGhosttyPrompt()),
    frames: true,
    oldOutput: OLD_LINES,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      { send: "clear; for i in {1..26}; do print \"new output $i\"; done\\r" },
      { wait_for: "new output 26" },
      VIEW_BOOT,
      { mark: "before" },
      { send: CMD_SHIFT_E },
      { sleep: 2000 },
      { mark: "open" },
      { send: ESCAPE },
      { sleep: 1000 },
      { mark: "closed" },
      { send: "exit\\r" },
    ],
  });
  shot(run, "open", "startstate-clear-open.png");
  const before = screenOf(run, "before");
  const prompt = promptRow(before);
  assert.ok(prompt >= 26, `the prompt is near the bottom (row ${prompt})`);
  const open = screenOf(run, "open");
  const rows = placeholderRows(open);
  assert.equal(promptRow(open), prompt, "nothing scrolled");
  assert.ok(rows.length > 2);
  assert.ok(rows.at(-1) < prompt, "the bar sits above the prompt, over output pxsh saw");
  const closed = screenOf(run, "closed");
  assert.equal(closed.placeholders, 0);
  assert.deepEqual(closed.lines, before.lines, "and closing it puts every cell back");
});

test("after a resize reflows long old lines, pxsh asks again where the cursor is and the bar still opens at the prompt", { skip }, () => {
  const run = runFake({
    name: "startstate-resize",
    command: pxsh,
    env: uiEnv(homeWithGhosttyPrompt()),
    frames: true,
    oldOutput: 10,
    oldLine: `old output {n} ${"x".repeat(80)}`,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { resize: [60, 30] },
      { sleep: 1000 },
      { mark: "resized" },
      { send: CMD_SHIFT_E },
      { sleep: 2000 },
      { mark: "open" },
      { send: ESCAPE },
      { sleep: 1000 },
      { mark: "closed" },
      { send: "exit\\r" },
    ],
  });
  const resized = screenOf(run, "resized");
  const prompt = promptRow(resized);
  assert.ok(prompt > 15, `the reflowed old lines pushed the prompt down to row ${prompt}`);
  const open = screenOf(run, "open");
  const rows = placeholderRows(open);
  assert.ok(rows.length > 2);
  assert.equal(rows[0], promptRow(open) + 1, "the bar starts right under the prompt");
  const closed = screenOf(run, "closed");
  assert.equal(closed.placeholders, 0);
  const oldRows = closed.text.slice(0, promptRow(closed)).filter((line) => line);
  assert.ok(oldRows.every((line) => /^(old output \d+ x*|x+)$/.test(line)), `the old lines are intact after closing:\n${oldRows.join("\n")}`);
  const numbers = oldRows.map((line) => /^old output (\d+)/.exec(line)?.[1]).filter(Boolean).map(Number);
  assert.deepEqual(numbers, numbers.map((_, i) => numbers[0] + i), "and in order");
  assert.equal(numbers.at(-1), 10);
});

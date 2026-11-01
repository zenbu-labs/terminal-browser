const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { PixelView } = require("../../dist/terminal/embed.js");
const { Vt } = require("../../dist/terminal/vt.js");
const { runFake, pxsh, makeHome, uiEnv, screenAt } = require("../../test-support/harness.js");

const skip = PixelView.available() ? false : "pixel is not built";

const CMD_SHIFT_E = "\\x1b[101;10u";
const ESCAPE = "\\x1b[27u";
const CTRL_SPACE = "\\x1b[32;5u";
const VIEW_BOOT = { sleep: 4000 };
const GHOSTTY_PROMPT = "PS1=$'%{\\e]133;A;cl=line\\a%}READY> %{\\e]133;B\\a%}'\nunsetopt PROMPT_SP\n";

const press = (col, row) => ({ send: `\\x1b[<0;${col};${row}M` });
const release = (col, row) => ({ send: `\\x1b[<0;${col};${row}m` });
const hover = (col, row) => ({ send: `\\x1b[<35;${col};${row}M` });

function homeWithGhosttyPrompt(zshrc = "") {
  const home = makeHome();
  fs.writeFileSync(path.join(home, ".zshrc"), GHOSTTY_PROMPT + zshrc);
  return home;
}

function frameBytesAt(run, mark, rect) {
  const frame = run.frames.filter((f) => f.offset <= run.marks[mark]).at(-1);
  const data = fs.readFileSync(frame.file);
  const rows = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) rows.push(data.subarray((y * frame.width + rect.x) * 4, (y * frame.width + rect.x + rect.width) * 4));
  return Buffer.concat(rows);
}

function atGroundEverywhere(tap) {
  const vt = new Vt(100, 30);
  for (const record of tap) {
    if (record.from === "pxsh") assert.ok(vt.atGround(), `pxsh wrote ${JSON.stringify(record.bytes.toString("latin1").slice(0, 80))} inside a sequence`);
    if (record.from === "shell") vt.write(record.bytes);
  }
}

test("the AI bar opens over the prompt, writes the model's command onto the line, runs it, and leaves no trace when it closes", { skip }, () => {
  const home = makeHome();
  const run = runFake({
    name: "ai-bar",
    command: pxsh,
    env: uiEnv(home),
    frames: true,
    timeout: 60,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { mark: "before" },
      { send: CMD_SHIFT_E },
      { sleep: 2000 },
      { mark: "open" },
      { send: "list files" },
      { sleep: 500 },
      { send: "\\r" },
      { sleep: 2500 },
      { mark: "answered" },
      { send: "\\r" },
      { sleep: 1500 },
      { mark: "ran" },
      { send: ESCAPE },
      { sleep: 1000 },
      { mark: "closed" },
      { send: "exit\\r" },
    ],
  });
  const before = screenAt(run.capture, run.marks.before);
  const open = screenAt(run.capture, run.marks.open);
  const answered = screenAt(run.capture, run.marks.answered);
  const ran = screenAt(run.capture, run.marks.ran);
  const closed = screenAt(run.capture, run.marks.closed);
  assert.ok(run.frames.length > 0, "the view sent frames");
  assert.equal(before.placeholders, 0);
  assert.ok(open.placeholders > 20, "the bar shows as placeholder cells");
  assert.equal(open.visible, false, "the shell's cursor hides while the bar has focus");
  assert.equal(open.mouse, true, "pxsh reports the mouse while its UI shows");
  assert.deepEqual(open.cursor, before.cursor);
  assert.ok(answered.text.some((line) => line.startsWith("READY> ls -la")), `the command is on the line: ${answered.text.join("\n")}`);
  assert.ok(ran.text.some((line) => /^total \d+/.test(line)), "enter in the bar ran it");
  assert.ok(ran.placeholders > 0, "the bar stays open after running");
  assert.equal(closed.placeholders, 0);
  assert.equal(closed.visible, true);
  assert.equal(closed.mouse, false, "mouse reporting goes back to the shell's");
  atGroundEverywhere(run.tap);
});

test("opening and closing the bar leaves every cell, the cursor and the pen as they were", { skip }, () => {
  const run = runFake({
    name: "bar-restore",
    command: pxsh,
    env: uiEnv(makeHome()),
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      { send: "print -P '%F{red}red%f %B bold %b %U under %u wide 世界 e\u0301'; printf '\\\\e]8;;https://x.y\\\\e\\\\\\\\link\\\\e]8;;\\\\e\\\\\\\\\\\\n'; for i in {1..6}; do print -P \"%K{blue}row $i%k\"; done\\r" },
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
  const before = screenAt(run.capture, run.marks.before);
  assert.ok(screenAt(run.capture, run.marks.open).placeholders > 0);
  const closed = screenAt(run.capture, run.marks.closed);
  assert.deepEqual(closed.lines, before.lines);
  assert.deepEqual([closed.cursor, closed.pen, closed.visible, closed.mouse], [before.cursor, before.pen, before.visible, before.mouse]);
});

test("a full-screen program starting closes the bar, and the bar never opens over one", { skip }, () => {
  const run = runFake({
    name: "bar-fullscreen",
    command: pxsh,
    env: uiEnv(makeHome()),
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { send: CMD_SHIFT_E },
      { sleep: 1500 },
      { mark: "open" },
      { send: "\\x1b[<0;90;28M\\x1b[<0;90;28m" },
      { sleep: 300 },
      { send: "printf '\\\\e[?1049hFULL'; sleep 1.5; printf '\\\\e[?1049l'\\r" },
      { wait_for: "\\x1b[?1049hFULL" },
      { sleep: 300 },
      { send: CMD_SHIFT_E },
      { sleep: 500 },
      { mark: "fullscreen" },
      { sleep: 1500 },
      { mark: "back" },
      { send: "exit\\r" },
    ],
  });
  assert.ok(screenAt(run.capture, run.marks.open).placeholders > 0);
  const vt = new Vt(100, 30);
  vt.write(run.capture.subarray(0, run.marks.fullscreen));
  assert.equal(vt.info().altScreen, true);
  const entered = run.capture.indexOf("\x1b[?1049hFULL");
  assert.ok(entered > 0);
  assert.ok(!run.capture.subarray(entered, run.marks.fullscreen).includes(Buffer.from("\u{10EEEE}")), "nothing was drawn over the program");
  assert.equal(screenAt(run.capture, run.marks.back).placeholders, 0, "the bar stays closed afterwards");
});


test("ctrl+space opens zsh's completion at the caret, history rows first, without covering the line", { skip }, () => {
  const home = makeHome();
  for (const file of ["alpha.txt", "alpine.md", "beta"]) fs.writeFileSync(path.join(home, file), "");
  fs.writeFileSync(path.join(home, ".zshrc"), 'PS1="READY> "\nunsetopt PROMPT_SP\nautoload -Uz compinit && compinit -u\n');
  fs.writeFileSync(path.join(home, ".zsh_history"), "cat alpha.txt\ngit status\n");
  const run = runFake({
    name: "completion",
    command: pxsh,
    env: uiEnv(home),
    frames: true,
    timeout: 40,
    steps: [
      VIEW_BOOT,
      { send: "cat alp" },
      { sleep: 300 },
      { mark: "before" },
      { send: CTRL_SPACE },
      { sleep: 1500 },
      { mark: "popup" },
      { send: "\\x1b[B\\x1b[B" },
      { sleep: 300 },
      { send: "\\r" },
      { sleep: 800 },
      { mark: "accepted" },
      { send: "\\x15exit\\r" },
    ],
  });
  const popup = screenAt(run.capture, run.marks.popup);
  const caret = screenAt(run.capture, run.marks.before).cursor;
  assert.ok(popup.placeholders > 10);
  assert.equal(popup.text[caret[1]], "READY> cat alp", "the line stays visible");
  const below = popup.lines[caret[1] + 1];
  assert.ok([...below].slice(0, caret[0]).every((c) => c.codePointAt(0) !== 0x10eeee), "the popup starts at the caret's column");
  assert.equal(screenAt(run.capture, run.marks.accepted).text[caret[1]], "READY> cat alpine.md", "history row, alpha.txt, then alpine.md");
  assert.equal(screenAt(run.capture, run.marks.accepted).placeholders, 0);
});

test("while pxsh's UI shows, a right click opens its menu there, and its items work", { skip }, () => {
  const run = runFake({
    name: "context-menu",
    command: pxsh,
    env: uiEnv(homeWithGhosttyPrompt()),
    frames: true,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { send: CMD_SHIFT_E },
      { sleep: 1500 },
      { mark: "bar" },
      { send: "\\x1b[<2;40;16M\\x1b[<2;40;16m" },
      { sleep: 1200 },
      { mark: "menu" },
      hover(46, 22),
      { sleep: 300 },
      press(46, 22),
      { sleep: 1200 },
      { mark: "cleared" },
      { send: "exit\\r" },
    ],
  });
  const bar = screenAt(run.capture, run.marks.bar);
  const menu = screenAt(run.capture, run.marks.menu);
  assert.ok(menu.placeholders > bar.placeholders, "the menu shows beside the bar");
  assert.ok(menu.lines[15].includes("\u{10EEEE}"), "at the row that was clicked");
  assert.equal(menu.visible, true, "the click outside the bar gave the shell its cursor back");
  const cleared = screenAt(run.capture, run.marks.cleared);
  assert.equal(cleared.placeholders, bar.placeholders, "the menu closed and the bar stayed");
  assert.match(run.capture.subarray(run.marks.menu, run.marks.cleared).toString("latin1"), /\x1b\[2J\x1b\[3J/, "Clear cleared the screen");
});

test("a resize while the bar shows leaves no stray placeholders, and closing it then restores the reflowed screen", { skip }, () => {
  const run = runFake({
    name: "resize-bar",
    command: pxsh,
    env: uiEnv(makeHome()),
    frames: true,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      { send: "for i in {1..8}; do print \"a fairly long line number $i that will reflow when the pane gets narrower\"; done\\r" },
      VIEW_BOOT,
      { send: CMD_SHIFT_E },
      { sleep: 1500 },
      { resize: [70, 24] },
      { sleep: 1500 },
      { mark: "resized" },
      { send: ESCAPE },
      { sleep: 800 },
      { mark: "closed" },
      { send: "exit\\r" },
    ],
  });
  const resized = screenAt(run.capture, run.marks.resized, 70, 24);
  const rows = resized.lines.map((line, row) => ({ row, n: [...line].filter((c) => c.codePointAt(0) === 0x10eeee).length })).filter((r) => r.n);
  assert.ok(rows.length > 0, "the bar is back after the resize");
  const cols = new Set(rows.map((r) => r.n));
  assert.equal(cols.size, 1, `the bar is one rectangle, not reflowed pieces: ${JSON.stringify(rows)}`);
  const closed = screenAt(run.capture, run.marks.closed, 70, 24);
  assert.equal(closed.placeholders, 0);
  assert.ok(closed.text.some((line) => line.startsWith("a fairly long line number 8")), "the shell's text is there after closing");
});

const BAR_BELOW_PROMPT = { picker: [56, 4], send: [65, 4], close: [65, 2], modelRow: [45, 9], lunaRow: [16, 11] };

test("clicking the model picker opens it, and clicking another model switches the bar to it, even though Ghostty 1.3 keeps the release of a click below the prompt", { skip }, () => {
  const home = homeWithGhosttyPrompt();
  const env = uiEnv(home);
  const { picker, modelRow, lunaRow } = BAR_BELOW_PROMPT;
  const run = runFake({
    name: "model-picker-click",
    command: pxsh,
    env,
    frames: true,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { send: CMD_SHIFT_E },
      { sleep: 2000 },
      { mark: "bar" },
      hover(...picker),
      { sleep: 200 },
      press(...picker),
      { sleep: 90 },
      release(...picker),
      { sleep: 1500 },
      { mark: "menu" },
      hover(...modelRow),
      { sleep: 800 },
      { mark: "models" },
      hover(...lunaRow),
      { sleep: 200 },
      press(...lunaRow),
      { sleep: 1500 },
      hover(30, 20),
      { sleep: 300 },
      { mark: "picked" },
      { send: ESCAPE },
      { sleep: 300 },
      { send: "exit\\r" },
    ],
  });
  const at = (mark) => screenAt(run.capture, run.marks[mark]);
  assert.ok(at("menu").placeholders > at("bar").placeholders, "the picker's menu shows under the bar");
  assert.ok(at("models").placeholders > at("menu").placeholders, "the model list shows beside it");
  assert.equal(at("picked").placeholders, at("bar").placeholders, "picking a model closes the menu");
  const saved = JSON.parse(fs.readFileSync(path.join(env.XDG_STATE_HOME, "pxsh", "ai.json"), "utf8"));
  assert.equal(saved.choice.model, "gpt-6-luna");
  const label = { x: 470, y: 61, width: 160, height: 20 };
  assert.notDeepEqual(frameBytesAt(run, "picked", label), frameBytesAt(run, "bar", label), "the bar shows the new model");
});

test("the send, stop and close buttons work by click below the prompt", { skip }, () => {
  const home = homeWithGhosttyPrompt();
  const log = path.join(home, "codex.log");
  const { send, close } = BAR_BELOW_PROMPT;
  const run = runFake({
    name: "bar-buttons-click",
    command: pxsh,
    env: { ...uiEnv(home), FAKE_CODEX_LOG: log },
    frames: true,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { send: CMD_SHIFT_E },
      { sleep: 2000 },
      { send: "slow one" },
      { sleep: 300 },
      press(...send),
      { sleep: 1500 },
      { mark: "busy" },
      press(...send),
      { sleep: 1500 },
      { mark: "stopped" },
      { send: "list files" },
      { sleep: 300 },
      press(...send),
      { sleep: 2500 },
      { mark: "answered" },
      press(...close),
      { sleep: 1000 },
      { mark: "closed" },
      { send: "\\x15exit\\r" },
    ],
  });
  const methods = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).method);
  assert.equal(methods.filter((m) => m === "turn/start").length, 2, "both questions were sent");
  assert.ok(methods.includes("turn/interrupt"), "the stop button stopped the slow turn");
  assert.equal(screenAt(run.capture, run.marks.answered).text[0], "READY> ls -la", "the second answer wrote its command");
  assert.equal(screenAt(run.capture, run.marks.closed).placeholders, 0, "the close button closed the bar");
});

test("clicking a completion row below the prompt inserts it", { skip }, () => {
  const home = homeWithGhosttyPrompt("autoload -Uz compinit && compinit -u\n");
  for (const file of ["alpha.txt", "alpine.md", "beta"]) fs.writeFileSync(path.join(home, file), "");
  fs.writeFileSync(path.join(home, ".zsh_history"), "cat alpha.txt\ngit status\n");
  const alpineRow = [20, 6];
  const run = runFake({
    name: "completion-click",
    command: pxsh,
    env: uiEnv(home),
    frames: true,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { send: "cat alp" },
      { sleep: 300 },
      { send: CTRL_SPACE },
      { sleep: 1500 },
      { mark: "popup" },
      hover(...alpineRow),
      { sleep: 200 },
      press(...alpineRow),
      { sleep: 1000 },
      { mark: "clicked" },
      { send: "\\x15exit\\r" },
    ],
  });
  assert.ok(screenAt(run.capture, run.marks.popup).placeholders > 10);
  const clicked = screenAt(run.capture, run.marks.clicked);
  assert.equal(clicked.text[0], "READY> cat alpine.md");
  assert.equal(clicked.placeholders, 0, "the popup closed");
});

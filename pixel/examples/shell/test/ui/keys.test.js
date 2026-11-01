const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { PixelView } = require("../../dist/terminal/embed.js");
const { runFake, pxsh, makeHome, uiEnv, screenAt } = require("../../test-support/harness.js");

const skip = PixelView.available() ? false : "pixel is not built";

const CMD_SHIFT_E_KITTY = { send: "\\x1b[101;10u" };
const VIEW_BOOT = { sleep: 4000 };
const GHOSTTY_PROMPT = "PS1=$'%{\\e]133;A;cl=line\\a%}READY> %{\\e]133;B\\a%}'\nunsetopt PROMPT_SP\nautoload -Uz compinit && compinit -u\n";
const BAR_BELOW_PROMPT = { picker: [56, 4] };
const OUTSIDE = [90, 28];

const key = (chords) => ({ key: chords });
const sleep = (ms) => ({ sleep: ms });
const mark = (name) => ({ mark: name });
const click = (col, row) => ({ send: `\\x1b[<35;${col};${row}M\\x1b[<0;${col};${row}M\\x1b[<0;${col};${row}m` });
const rightClick = (col, row) => ({ send: `\\x1b[<2;${col};${row}M\\x1b[<2;${col};${row}m` });

function homeWith(zshrc = "") {
  const home = makeHome();
  fs.writeFileSync(path.join(home, ".zshrc"), GHOSTTY_PROMPT + zshrc);
  for (const file of ["alpha.txt", "alpine.md", "beta"]) fs.writeFileSync(path.join(home, file), "");
  fs.writeFileSync(path.join(home, ".zsh_history"), "cat alpha.txt\ngit status\n");
  return home;
}

function keysZshGot(tap) {
  const stream = Buffer.concat(tap.filter((r) => r.from === "zsh").map((r) => r.bytes)).toString("latin1");
  let keys = "";
  for (let at = 0; at < stream.length; ) {
    const command = /^\x1b\[6973~(\d+):/.exec(stream.slice(at, at + 24));
    if (command) at += command[0].length + Number(command[1]);
    else keys += stream[at++];
  }
  return keys;
}

function codexTurns(log) {
  return fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((m) => m.method === "turn/start")
    .map((m) => m.params.input[0].text.split("\n")[0]);
}

function frameBytesAt(run, name, rect) {
  const frame = run.frames.filter((f) => f.offset <= run.marks[name]).at(-1);
  const data = fs.readFileSync(frame.file);
  const rows = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) rows.push(data.subarray((y * frame.width + rect.x) * 4, (y * frame.width + rect.x + rect.width) * 4));
  return Buffer.concat(rows);
}

for (const encoding of ["kitty", "legacy"]) {
  const legacyKeys = encoding === "legacy";
  const openBar = legacyKeys ? CMD_SHIFT_E_KITTY : key("shift+super+e");

  test(`escape closes the innermost open thing one layer per press and never reaches zsh while pxsh's UI shows (${encoding} keys)`, { skip }, () => {
    const home = homeWith();
    const run = runFake({
      name: `escape-layers-${encoding}`,
      command: pxsh,
      env: uiEnv(home),
      legacyKeys,
      frames: true,
      timeout: 90,
      steps: [
        { wait_for: "READY>" },
        VIEW_BOOT,
        { send: "cat alp" },
        sleep(300),
        openBar,
        sleep(2000),
        mark("bar"),
        key("alt+p"),
        sleep(1000),
        mark("picker"),
        key("down down"),
        sleep(500),
        key("right"),
        sleep(800),
        mark("options"),
        key("escape"),
        sleep(600),
        mark("options-left"),
        key("escape"),
        sleep(600),
        mark("picker-closed"),
        key("escape"),
        sleep(800),
        mark("bar-closed"),

        openBar,
        sleep(1500),
        click(...OUTSIDE),
        sleep(500),
        mark("unfocused"),
        key("escape"),
        sleep(800),
        mark("unfocused-closed"),

        openBar,
        sleep(1500),
        { send: "question one" },
        sleep(300),
        key("enter"),
        sleep(1500),
        mark("answered"),
        key("escape"),
        sleep(800),
        mark("answered-closed"),

        openBar,
        sleep(1500),
        { send: "slow one" },
        sleep(300),
        key("enter"),
        sleep(1200),
        mark("running"),
        key("escape"),
        sleep(800),
        mark("running-closed"),

        openBar,
        sleep(1500),
        click(...OUTSIDE),
        sleep(400),
        key("ctrl+space"),
        sleep(1500),
        mark("popup-over-bar"),
        key("escape"),
        sleep(600),
        mark("popup-closed"),
        key("escape"),
        sleep(800),
        mark("popup-bar-closed"),

        openBar,
        sleep(1500),
        rightClick(40, 16),
        sleep(1000),
        mark("menu-over-bar"),
        key("escape"),
        sleep(600),
        mark("menu-closed"),
        key("escape"),
        sleep(800),
        mark("menu-bar-closed"),
        { send: "\\x15exit\\r" },
      ],
    });
    const at = (name) => screenAt(run.capture, run.marks[name]);
    const bar = at("bar").placeholders;
    assert.ok(bar > 20, "the bar shows");
    assert.ok(at("picker").placeholders > bar, "alt+p opens the model menu");
    assert.ok(at("options").placeholders > at("picker").placeholders, "right opens the effort list beside it");
    assert.equal(at("options-left").placeholders, at("options").placeholders, "the first escape leaves the list and keeps the menu, like px-shell");
    assert.equal(at("picker-closed").placeholders, bar, "the next escape closes only the menu");
    for (const closed of ["bar-closed", "unfocused-closed", "answered-closed", "running-closed", "popup-bar-closed", "menu-bar-closed"]) {
      assert.equal(at(closed).placeholders, 0, `${closed}: the bar is gone`);
      assert.equal(at(closed).text[0], "READY> cat alp", `${closed}: the line is untouched`);
    }
    assert.equal(at("unfocused").visible, true, "the click outside gave zsh the cursor");
    assert.ok(at("unfocused").placeholders > 0);
    assert.ok(at("answered").placeholders > bar, "the answer shows in the bar");
    assert.ok(at("running").placeholders > 0);
    assert.ok(at("popup-over-bar").placeholders > bar, "the popup shows over the bar");
    assert.ok(at("popup-closed").placeholders > 0 && at("popup-closed").placeholders < at("popup-over-bar").placeholders, "escape closed the popup and kept the bar");
    assert.ok(at("menu-over-bar").placeholders > bar, "the right-click menu shows over the bar");
    assert.ok(at("menu-closed").placeholders > 0 && at("menu-closed").placeholders < at("menu-over-bar").placeholders, "escape closed the menu and kept the bar");
    assert.equal(keysZshGot(run.tap), "cat alp\x15exit\r", "zsh never saw an escape");
  });

  test(`enter or tab while the completion popup shows is the popup's, even with nothing to accept (${encoding} keys)`, { skip }, () => {
    const home = homeWith("_pxsh_test_slow() { sleep 1; compadd later }\ncompdef _pxsh_test_slow slowcmd\n");
    const run = runFake({
      name: `popup-enter-${encoding}`,
      command: pxsh,
      env: uiEnv(home),
      legacyKeys,
      frames: true,
      timeout: 60,
      steps: [
        { wait_for: "READY>" },
        VIEW_BOOT,
        { send: "cat zzz" },
        sleep(300),
        key("ctrl+space"),
        sleep(1000),
        mark("empty"),
        key("enter"),
        sleep(600),
        mark("empty-enter"),
        key("ctrl+space"),
        sleep(1000),
        key("tab"),
        sleep(600),
        mark("empty-tab"),

        { send: "\\x15slowcmd " },
        sleep(400),
        key("ctrl+space"),
        sleep(250),
        mark("loading"),
        key("enter"),
        sleep(2000),
        mark("loading-enter"),

        { send: "\\x15cat alp" },
        sleep(400),
        key("ctrl+space"),
        sleep(1500),
        mark("list"),
        { send: "q\\r" },
        sleep(1500),
        mark("typed-and-entered"),

        { send: "\\x15cat alp" },
        sleep(400),
        key("ctrl+space"),
        sleep(1500),
        { send: "q" },
        sleep(25),
        key("tab"),
        sleep(1500),
        mark("typed-then-tab"),
        { send: "\\x15exit\\r" },
      ],
    });
    const at = (name) => screenAt(run.capture, run.marks[name]);
    assert.ok(at("empty").placeholders > 0, "the popup shows that nothing matched");
    assert.deepEqual([at("empty-enter").placeholders, at("empty-enter").text[0], at("empty-enter").text[1]], [0, "READY> cat zzz", ""], "enter closed it and ran nothing");
    assert.deepEqual([at("empty-tab").placeholders, at("empty-tab").text[0]], [0, "READY> cat zzz"], "tab closed it");
    assert.ok(at("loading").placeholders > 0, "the popup shows while zsh is still listing");
    assert.deepEqual([at("loading-enter").placeholders, at("loading-enter").text[0]], [0, "READY> slowcmd later"], "enter while loading took the first row once zsh listed it");
    assert.ok(at("list").placeholders > 0);
    assert.deepEqual([at("typed-and-entered").placeholders, at("typed-and-entered").text[0], at("typed-and-entered").text[1]], [0, "READY> cat alpq", ""], "typing past every row then enter inserts nothing");
    assert.deepEqual([at("typed-then-tab").placeholders, at("typed-then-tab").text[0]], [0, "READY> cat alpq"]);
    assert.equal(keysZshGot(run.tap), "cat zzz\x15slowcmd \x15cat alpq\x15cat alpq\x15exit\r", "zsh never saw enter or tab");
  });

  test(`the model menu takes arrows and enter, and alt+p or a click opens and closes it (${encoding} keys)`, { skip }, () => {
    const home = homeWith();
    const env = uiEnv(home);
    const run = runFake({
      name: `model-menu-keys-${encoding}`,
      command: pxsh,
      env,
      legacyKeys,
      frames: true,
      timeout: 60,
      steps: [
        { wait_for: "READY>" },
        VIEW_BOOT,
        openBar,
        sleep(2000),
        mark("bar"),
        key("alt+p"),
        sleep(1000),
        mark("menu"),
        key("down down"),
        sleep(500),
        key("right down down"),
        sleep(300),
        key("enter"),
        sleep(800),
        mark("effort-picked"),
        key("left down"),
        sleep(600),
        key("right down"),
        sleep(300),
        key("enter"),
        sleep(1000),
        mark("model-picked"),
        key("alt+p"),
        sleep(800),
        mark("reopened"),
        key("alt+p"),
        sleep(800),
        mark("toggled-closed"),
        click(...BAR_BELOW_PROMPT.picker),
        sleep(1000),
        mark("clicked-open"),
        key("down"),
        sleep(300),
        key("enter"),
        sleep(800),
        key("escape"),
        sleep(800),
        mark("clicked-closed"),
        { send: "abc" },
        sleep(500),
        key("escape"),
        sleep(500),
        { send: "\\x15exit\\r" },
      ],
    });
    const at = (name) => screenAt(run.capture, run.marks[name]);
    const bar = at("bar").placeholders;
    assert.ok(at("menu").placeholders > bar);
    assert.ok(at("effort-picked").placeholders > at("menu").placeholders, "picking an effort keeps the menu and its list open");
    assert.equal(at("model-picked").placeholders, bar, "picking a model closes the menu");
    assert.ok(at("reopened").placeholders > bar, "alt+p opens it");
    assert.equal(at("toggled-closed").placeholders, bar, "alt+p again closes it");
    assert.ok(at("clicked-open").placeholders > bar, "a click opens it");
    assert.equal(at("clicked-closed").placeholders, bar, "escape closes the clicked-open menu");
    const saved = JSON.parse(fs.readFileSync(path.join(env.XDG_STATE_HOME, "pxsh", "ai.json"), "utf8"));
    assert.deepEqual([saved.choice.model, saved.choice.effort, saved.choice.fast], ["gpt-6-luna", "high", true], "down to High, the model list's second row, then enter on Fast");
    assert.equal(keysZshGot(run.tap), "\x15exit\r", "none of the menu's keys reached zsh");
  });
}

test("cmd+shift+e opens the bar, focuses it again with its text kept, and does nothing while it has focus", { skip }, () => {
  const home = homeWith();
  const log = path.join(home, "codex.log");
  const run = runFake({
    name: "cmd-shift-e-toggle",
    command: pxsh,
    env: { ...uiEnv(home), FAKE_CODEX_LOG: log },
    frames: true,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      key("shift+super+e"),
      sleep(2000),
      mark("open"),
      { send: "abc" },
      sleep(300),
      click(...OUTSIDE),
      sleep(500),
      mark("unfocused"),
      key("shift+super+e"),
      sleep(600),
      mark("refocused"),
      { send: "d" },
      sleep(300),
      key("enter"),
      sleep(2000),
      key("shift+super+e"),
      sleep(800),
      mark("toggled"),
      key("escape"),
      sleep(500),
      { send: "\\x15exit\\r" },
    ],
  });
  const at = (name) => screenAt(run.capture, run.marks[name]);
  assert.ok(at("open").placeholders > 0);
  assert.equal(at("unfocused").visible, true);
  assert.deepEqual([at("refocused").visible, at("refocused").placeholders > 0], [false, true], "the bar has focus again");
  assert.deepEqual(codexTurns(log), ["abcd"], "the text typed before leaving the bar was kept");
  assert.ok(at("toggled").placeholders > 0, "cmd+shift+e with the bar focused left it open");
});

test("page keys with or without shift scroll the answer", { skip }, () => {
  const run = runFake({
    name: "answer-paging",
    command: pxsh,
    env: uiEnv(homeWith()),
    frames: true,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      key("shift+super+e"),
      sleep(2000),
      { send: "long one" },
      sleep(300),
      key("enter"),
      sleep(2500),
      mark("answered"),
      key("pageup"),
      sleep(600),
      mark("paged-up"),
      key("pagedown"),
      sleep(600),
      mark("paged-down"),
      key("shift+pageup"),
      sleep(600),
      mark("shift-paged-up"),
      key("escape"),
      sleep(500),
      { send: "\\x15exit\\r" },
    ],
  });
  const answer = { x: 70, y: 60, width: 200, height: 400 };
  const frame = (name) => frameBytesAt(run, name, answer);
  assert.notDeepEqual(frame("paged-up"), frame("answered"), "pageup scrolled");
  assert.notDeepEqual(frame("paged-down"), frame("paged-up"), "pagedown scrolled back");
  assert.notDeepEqual(frame("shift-paged-up"), frame("paged-down"), "shift+pageup scrolled too");
  assert.equal(keysZshGot(run.tap), "\x15exit\r");
});

test("a click outside closes the model menu, a right click elsewhere moves the menu, and a click on the line moves zsh's cursor where the terminal reports it", { skip }, () => {
  const run = runFake({
    name: "clicks-outside",
    command: pxsh,
    env: uiEnv(homeWith()),
    ghosttyVersion: "1.4.0",
    frames: true,
    timeout: 40,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      { send: "echo hello world" },
      sleep(300),
      key("shift+super+e"),
      sleep(2000),
      mark("bar"),
      key("alt+p"),
      sleep(1000),
      mark("picker"),
      click(...OUTSIDE),
      sleep(800),
      mark("outside"),
      rightClick(40, 16),
      sleep(1000),
      mark("menu"),
      rightClick(20, 24),
      sleep(1000),
      mark("menu-moved"),
      key("escape"),
      sleep(600),
      click(19, 1),
      sleep(600),
      { send: "X" },
      sleep(600),
      mark("moved-caret"),
      key("escape"),
      sleep(500),
      { send: "\\x15exit\\r" },
    ],
  });
  const at = (name) => screenAt(run.capture, run.marks[name]);
  const placeholdersOn = (screen, row) => [...screen.lines[row]].filter((c) => c.codePointAt(0) === 0x10eeee).length;
  assert.ok(at("picker").placeholders > at("bar").placeholders);
  assert.equal(at("outside").placeholders, at("bar").placeholders, "the click outside closed the model menu");
  assert.ok(placeholdersOn(at("menu"), 15) > 0);
  assert.equal(placeholdersOn(at("menu-moved"), 15), 0, "the menu left its first spot");
  assert.ok(placeholdersOn(at("menu-moved"), 23) > 0, "and opened at the second right click");
  assert.equal(at("moved-caret").text[0], "READY> echo hello Xworld");
});

test("a full-screen program starting closes the model menu, the popup and the right-click menu, and nothing comes back after it", { skip }, () => {
  const fullscreen = (after) => ({ send: `(sleep ${after}; printf '\\\\e[?1049hFULL'; sleep 1; printf '\\\\e[?1049l') &!\\r` });
  const run = runFake({
    name: "fullscreen-closes-ui",
    command: pxsh,
    env: uiEnv(homeWith()),
    frames: true,
    timeout: 60,
    steps: [
      { wait_for: "READY>" },
      VIEW_BOOT,
      fullscreen(3),
      sleep(300),
      key("shift+super+e"),
      sleep(1200),
      key("alt+p"),
      sleep(800),
      mark("picker"),
      { wait_for: "\\x1b[?1049l" },
      sleep(800),
      mark("picker-after"),
      fullscreen(2.5),
      sleep(300),
      { send: "cat alp" },
      key("ctrl+space"),
      sleep(1000),
      mark("popup"),
      { wait_for: "\\x1b[?1049l" },
      sleep(800),
      mark("popup-after"),
      { send: "\\x15" },
      fullscreen(3),
      sleep(300),
      key("shift+super+e"),
      sleep(1200),
      rightClick(40, 16),
      sleep(800),
      mark("menu"),
      { wait_for: "\\x1b[?1049l" },
      sleep(800),
      mark("menu-after"),
      { send: "\\x15exit\\r" },
    ],
  });
  for (const ui of ["picker", "popup", "menu"]) {
    const before = screenAt(run.capture, run.marks[ui]);
    const after = screenAt(run.capture, run.marks[`${ui}-after`]);
    assert.ok(before.placeholders > 0, `${ui} showed`);
    assert.equal(after.placeholders, 0, `${ui}: nothing is drawn after the program`);
    assert.equal(after.mouse, false);
  }
  const entered = [];
  for (let at = run.capture.indexOf("\x1b[?1049hFULL"); at >= 0; at = run.capture.indexOf("\x1b[?1049hFULL", at + 1)) entered.push(at);
  assert.equal(entered.length, 3);
  for (const at of entered) {
    const left = run.capture.indexOf("\x1b[?1049l", at);
    assert.ok(!run.capture.subarray(at, left).includes(Buffer.from("\u{10EEEE}")), "nothing was drawn over the program");
  }
});

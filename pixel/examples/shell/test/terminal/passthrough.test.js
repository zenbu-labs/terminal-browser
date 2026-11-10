const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { Vt } = require("../../dist/terminal/vt.js");
const { runFake, between, pxsh, plainZsh, makeHome } = require("../../test-support/harness.js");

const MARKER = /\x1b\]6973;[0-9a-f]+;[^\x07]*\x07/g;

function sameBytes(inside, outside, what) {
  if (inside && outside && inside.equals(outside)) return;
  let at = 0;
  while (inside && outside && at < Math.min(inside.length, outside.length) && inside[at] === outside[at]) at++;
  const around = (b) => JSON.stringify(b?.subarray(Math.max(0, at - 20), at + 40).toString("latin1"));
  assert.fail(`${what}: lengths ${inside?.length} vs ${outside?.length}, first difference at ${at}: ${around(inside)} vs ${around(outside)}`);
}

function payloadFile(home, name, bytes) {
  const file = path.join(home, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function catBoth(name, bytes) {
  const segments = [];
  for (const [label, command] of [["pxsh", pxsh], ["zsh", plainZsh]]) {
    const home = makeHome();
    payloadFile(home, "payload", bytes);
    const run = runFake({
      name: `${name}-${label}`,
      command,
      env: { HOME: home },
      steps: [{ wait_for: "READY>" }, { send: "print BEGIN; cat payload; print END\\r" }, { wait_for: "END\\r\\n" }, { send: "exit\\r" }],
    });
    segments.push(between(run.capture, Buffer.from("BEGIN\r\n"), Buffer.from("END\r\n")));
  }
  return segments;
}

test("everything the terminal receives is zsh's output without pxsh's markers, plus pxsh's own writes at points between sequences", () => {
  const run = runFake({
    name: "tap",
    command: pxsh,
    steps: [{ wait_for: "READY>" }, { send: "printf '\\\\e[1;31mred\\\\e[0m %s\\\\n' tail\\r" }, { wait_for: "tail" }, { sleep: 200 }, { send: "exit\\r" }],
  });
  const written = Buffer.concat(run.tap.filter((r) => r.from === "shell" || r.from === "pxsh").map((r) => r.bytes));
  assert.ok(run.capture.length > 0);
  assert.ok(run.capture.equals(written), "the terminal got exactly what pxsh logged writing");
  const raw = Buffer.concat(run.tap.filter((r) => r.from === "raw").map((r) => r.bytes)).toString("latin1");
  const shell = Buffer.concat(run.tap.filter((r) => r.from === "shell").map((r) => r.bytes)).toString("latin1");
  assert.match(raw, /\x1b\]6973;[0-9a-f]+;E;/, "zsh reported its line editor");
  assert.equal(shell, raw.replace(MARKER, ""), "zsh's bytes reach the terminal byte for byte, minus pxsh's markers");
  const vt = new Vt(100, 30);
  for (const record of run.tap) {
    if (record.from === "pxsh") assert.ok(vt.atGround(), `pxsh wrote ${JSON.stringify(record.bytes.toString("latin1"))} inside a sequence`);
    if (record.from === "shell") vt.write(record.bytes);
  }
});

test("cat of bytes that are not text, split sequences and odd UTF-8 reaches the terminal the same as in plain zsh", () => {
  const bytes = Buffer.concat([
    Buffer.from("plain \x1b[38;2;1;2;3mtrue color\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x07\n"),
    Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x0a]),
    Buffer.from("wide 世界 emoji 👍🏽 combining é\n\x1b[?1049h\x1b[2J\x1b[Halt screen\x1b[?1049l\n"),
    Buffer.from("\x1b]0;a title\x07\x1b[5 q\x1b[4:3mcurly\x1b[0m\n"),
  ]);
  const [inside, outside] = catBoth("cat-bytes", bytes);
  assert.ok(outside && outside.length > bytes.length - 10, "plain zsh printed the payload");
  sameBytes(inside, outside, "pxsh passed the payload through unchanged");
});

test("a program drawing the same kitty image id again and again reaches the terminal exactly as without pxsh", () => {
  const pixel = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]).toString("base64");
  const frames = [];
  for (let i = 0; i < 6; i++) frames.push(`\x1b_Ga=T,f=32,s=2,v=2,i=4242,p=1,q=2;${pixel}\x1b\\\x1b[1;1H`);
  frames.push("\x1b_Ga=p,i=4242,p=1,U=1,c=2,r=1,q=2\x1b\\\u{10EEEE}̅̅\n");
  frames.push("\x1b_Ga=d,d=I,i=4242,q=2\x1b\\\n");
  const [inside, outside] = catBoth("kitty-image", Buffer.from(frames.join("")));
  assert.ok(outside?.includes("i=4242"));
  sameBytes(inside, outside, "pxsh neither re-hosts nor rewrites the program's images");
  assert.equal((inside.toString("latin1").match(/\x1b_G/g) ?? []).length, 8, "every image command arrives once");
});

test("a resize reaches zsh with the new cell and pixel size", () => {
  const run = runFake({
    name: "resize",
    command: pxsh,
    cols: 100,
    rows: 30,
    steps: [
      { wait_for: "READY>" },
      { resize: [120, 40] },
      { sleep: 300 },
      { send: "python3 -c 'import fcntl,termios,struct;print(\"SIZE\",struct.unpack(\"HHHH\",fcntl.ioctl(0,termios.TIOCGWINSZ,bytes(8))))'\\r" },
      { wait_for: "SIZE (" },
      { sleep: 300 },
      { send: "exit\\r" },
    ],
  });
  assert.match(run.capture.toString("latin1"), /SIZE \(40, 120, 1200, 800\)/);
});

test("keys pxsh asked for in the kitty form reach a program as the legacy bytes it expects", () => {
  const run = runFake({
    name: "keys",
    command: pxsh,
    steps: [
      { wait_for: "READY>" },
      { send: "cat -v\\r" },
      { sleep: 300 },
      { send: "\\x1b[97;5u\\x1b[27u\\x1b[98;3ux\\r" },
      { wait_for: "bx\\r\\n^A" },
      { send: "\\x1b[100;5u" },
      { wait_for: "READY>" },
      { send: "exit\\r" },
    ],
  });
  assert.match(run.capture.toString("latin1"), /\^A\^\[\^\[bx\r\n/);
});

test("keys typed while pxsh starts reach zsh once, in order", () => {
  const run = runFake({
    name: "typeahead",
    command: pxsh,
    steps: [{ send: "print typed-early\\r" }, { wait_for: "READY>" }, { wait_for: "typed-early\\r\\n" }, { sleep: 300 }, { send: "exit\\r" }],
  });
  const lines = run.capture.toString("latin1").split(/\r?\n/);
  assert.equal(lines.filter((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "") === "typed-early").length, 1);
});

test("pxsh becomes plain zsh for commands and where it can't draw", () => {
  const command = runFake({ command: [...pxsh, "-c", "print -r -- $0 ran"], steps: [] });
  assert.match(command.capture.toString(), /zsh ran/);
  assert.equal(command.tap.length, 0, "the host never ran");
  const dumb = runFake({ command: pxsh, env: { TERM: "dumb", TERM_PROGRAM: "" }, steps: [{ wait_for: "READY>" }, { send: "print -r -- $0\\r" }, { wait_for: "zsh\\r\\n" }, { send: "exit\\r" }] });
  assert.match(dumb.capture.toString(), /-\/bin\/zsh\r\n/);
  assert.equal(dumb.tap.length, 0);
  const tmux = runFake({ command: pxsh, env: { TMUX: "/tmp/x,1,0" }, steps: [{ wait_for: "READY>" }, { send: "exit\\r" }] });
  assert.equal(tmux.tap.length, 0);
});

test("zsh inside pxsh is a login shell started like Ghostty starts it", () => {
  const run = runFake({
    command: pxsh,
    env: { SHLVL: "3" },
    steps: [{ wait_for: "READY>" }, { send: "print -r -- name=$0 login=$options[login] level=$SHLVL\\r" }, { wait_for: "level=" }, { sleep: 200 }, { send: "exit\\r" }],
  });
  assert.match(run.capture.toString(), /name=-\/bin\/zsh login=on level=1/);
});

test("cmd+c with nothing selected reaches a program that asked for the kitty keyboard, and copies zle's own selection", () => {
  const home = makeHome();
  fs.writeFileSync(
    path.join(home, "keys.py"),
    "import os, sys, termios, tty\nold = termios.tcgetattr(0)\ntty.setraw(0)\nos.write(1, b'\\x1b[>1u')\ndata = os.read(0, 64)\nos.write(1, b'\\x1b[<u')\ntermios.tcsetattr(0, termios.TCSADRAIN, old)\nprint('GOT', repr(data))\n",
  );
  const run = runFake({
    name: "cmd-c",
    command: pxsh,
    env: { HOME: home },
    steps: [
      { wait_for: "READY>" },
      { send: "python3 keys.py\\r" },
      { sleep: 600 },
      { send: "\\x1b[99;9u" },
      { wait_for: "GOT" },
      { sleep: 300 },
      { send: "echo hello world" },
      { sleep: 300 },
      { send: "\\x1b[1;2D\\x1b[1;2D\\x1b[1;2D\\x1b[1;2D\\x1b[1;2D" },
      { sleep: 500 },
      { send: "\\x1b[99;9u" },
      { sleep: 500 },
      { send: "\\x15exit\\r" },
    ],
  });
  const text = run.capture.toString("latin1");
  assert.match(text, /GOT b'\\x1b\[99;9u'/, "the program got cmd+c exactly as the terminal sent it");
  const copied = /\x1b\]52;c;([A-Za-z0-9+/=]+)/.exec(text);
  assert.equal(copied && Buffer.from(copied[1], "base64").toString(), "world");
});

function pxshWritesDuringFullScreen(tap) {
  const vt = new Vt(100, 30);
  const during = [];
  for (const record of tap) {
    if (record.from === "pxsh" && vt.info().altScreen) during.push(record.bytes.toString("latin1"));
    if (record.from === "shell") vt.write(record.bytes);
  }
  return during;
}

test("vim and htop run inside pxsh untouched: their bytes pass through, their keys and mouse reach them, pxsh writes nothing over them", () => {
  const home = makeHome();
  const run = runFake({
    name: "vim-htop",
    command: pxsh,
    env: { HOME: home },
    steps: [
      { wait_for: "READY>" },
      { send: "vim -u NONE -c 'set mouse=a' out.txt\\r" },
      { wait_for: "\\x1b[?1049h" },
      { sleep: 500 },
      { send: "ihello\\x1b" },
      { sleep: 300 },
      { send: "\\x1b[<0;3;1M\\x1b[<0;3;1m" },
      { sleep: 200 },
      { send: "x:wq\\r" },
      { wait_for: "READY>" },
      { send: "htop\\r" },
      { wait_for: "\\x1b[?1049h" },
      { sleep: 1000 },
      { send: "q" },
      { wait_for: "READY>" },
      { sleep: 200 },
      { send: "exit\\r" },
    ],
  });
  assert.equal(fs.readFileSync(path.join(home, "out.txt"), "utf8"), "helo\n", "typing, escape, a mouse click on the third column and x all reached vim");
  assert.deepEqual(pxshWritesDuringFullScreen(run.tap), []);
  const raw = Buffer.concat(run.tap.filter((r) => r.from === "raw").map((r) => r.bytes)).toString("latin1");
  const shell = Buffer.concat(run.tap.filter((r) => r.from === "shell").map((r) => r.bytes)).toString("latin1");
  assert.equal(shell, raw.replace(MARKER, ""));
  assert.match(shell, /htop/);
});

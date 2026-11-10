const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Vt, sgr } = require("../../dist/terminal/vt.js");

test("libghostty follows the cursor, the title and the alternate screen", () => {
  const vt = new Vt(20, 5, { scrollback: 100 });
  vt.write("hello\r\nworld\x1b]0;a title\x07");
  const info = vt.info();
  assert.deepEqual([info.cursorX, info.cursorY, info.altScreen, info.title], [5, 1, false, "a title"]);
  vt.write("\x1b[?1049h");
  assert.equal(vt.info().altScreen, true);
  vt.write("\x1b[?1049l");
  assert.equal(vt.info().altScreen, false);
});

test("the stream is at ground only between whole sequences and whole characters", () => {
  const vt = new Vt(20, 5);
  assert.equal(vt.atGround(), true);
  vt.write("\x1b[3");
  assert.equal(vt.atGround(), false);
  vt.write("1m");
  assert.equal(vt.atGround(), true);
  vt.write(Buffer.from([0xe4]));
  assert.equal(vt.atGround(), false);
  vt.write(Buffer.from([0xb8, 0x96]));
  assert.equal(vt.atGround(), true);
  vt.write("\x1b_Ga=T;AAAA");
  assert.equal(vt.atGround(), false);
  vt.write("\x1b\\");
  assert.equal(vt.atGround(), true);
});

test("cells carry their text, width, style and link", () => {
  const vt = new Vt(20, 5);
  vt.write("a\x1b[1;4:3;38;2;1;2;3;48;5;200m世\x1b[0m\x1b]8;;https://x.y\x07l\x1b]8;;\x07é");
  assert.deepEqual(vt.cell(0, 0), { text: "a", wide: false, spacer: false, style: null, link: null });
  const wide = vt.cell(1, 0);
  assert.equal(wide.text, "世");
  assert.equal(wide.wide, true);
  assert.equal(vt.cell(2, 0).spacer, true);
  assert.equal(sgr(wide.style), "\x1b[0;1;4:3;38;2;1;2;3;48;5;200m");
  assert.equal(vt.cell(3, 0).link, "https://x.y");
  assert.equal(vt.cell(4, 0).text, "é");
});

test("the pen is the style the next character gets", () => {
  const vt = new Vt(20, 5);
  vt.write("\x1b[3;7;31m");
  assert.equal(sgr(vt.pen()), "\x1b[0;3;7;31m");
  vt.write("\x1b[0m");
  assert.equal(sgr(vt.pen()), "\x1b[0m");
});

test("lines read history above the screen, marking wrapped rows", () => {
  const vt = new Vt(10, 3, { scrollback: 100 });
  vt.write("first\r\n0123456789abc\r\nx\r\ny");
  assert.equal(vt.info().history, 2);
  const lines = vt.lines(-2, 5);
  assert.equal(lines[0].cells.join("").trimEnd(), "first");
  assert.equal(lines[1].cells.join(""), "0123456789");
  assert.equal(lines[1].wrapped, true);
  assert.equal(lines[2].cells.join("").trimEnd(), "abc");
  assert.equal(vt.textRange({ line: -1, col: 0 }, { line: 0, col: 2 }), "0123456789abc");
  assert.match(vt.text(), /^first\n0123456789\nabc\nx\ny$/);
});

test("modes the shell sets are readable", () => {
  const vt = new Vt(10, 3);
  assert.equal(vt.mode("bracketedPaste"), false);
  vt.write("\x1b[?2004h\x1b[?1h\x1b[?1003h\x1b[?1006h\x1b[4h");
  assert.deepEqual(["bracketedPaste", "appCursor", "anyMouse", "sgrMouse", "insert"].map((m) => vt.mode(m)), [true, true, true, true, true]);
  assert.equal(vt.info().mouseTracking, true);
  vt.write("\x1b[>5u");
  assert.equal(vt.info().kittyFlags, 5);
});

test("the newest prompt line is found from the shell's OSC 133 marks, in history too", () => {
  const vt = new Vt(20, 3, { scrollback: 100 });
  assert.equal(vt.newestPromptLineAtOrAbove(2), null);
  vt.write("\x1b]133;A;cl=line\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07a\r\nb\r\n\x1b]133;A;cl=line\x07$ \x1b]133;B\x07");
  assert.equal(vt.newestPromptLineAtOrAbove(2), 2);
  assert.equal(vt.newestPromptLineAtOrAbove(1), -1);
});

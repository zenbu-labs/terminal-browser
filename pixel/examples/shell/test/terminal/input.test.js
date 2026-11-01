const assert = require("node:assert/strict");
const { test } = require("node:test");

const { InputParser } = require("../../dist/terminal/input.js");
const { chordName } = require("../../dist/terminal/chords.js");
const { legacyKey } = require("../../dist/terminal/keys.js");
const { Vt } = require("../../dist/terminal/vt.js");

const units = (...chunks) => {
  const parser = new InputParser();
  return [...chunks.flatMap((c) => parser.feed(Buffer.from(c, "latin1"))), ...parser.flush()];
};

test("pieces keep their exact bytes", () => {
  const input = "ab\x1b[A\x1b[<0;3;4M\x1b[200~x\x1b[201~\x1b[I\x1b]11;rgb:0/0/0\x1b\\\x1b[?62;22c\x1b[99;5u";
  const got = units(input);
  assert.equal(Buffer.concat(got.map((u) => u.bytes)).toString("latin1"), input);
  assert.deepEqual(got.map((u) => u.kind), ["key", "key", "key", "mouse", "paste", "focus", "other", "other", "key"]);
});

test("a sequence cut between reads waits for the rest", () => {
  const got = units("\x1b[", "13;6u", "\x1b[20", "0~pasted\x1b[2", "01~");
  assert.deepEqual(got.map((u) => u.kind), ["key", "paste"]);
  assert.equal(chordName(got[0].key), "ctrl+shift+enter");
  assert.equal(got[1].text, "pasted");
});

test("a lone escape given up on is the escape key", () => {
  const got = units("\x1b");
  assert.equal(got[0].key.key, "escape");
});

test("kitty keys decode to pxsh's chords", () => {
  const names = units("\x1b[101;10u\x1b[32;5u\x1b[99;9u\x1b[27u\x1b[13;2u\x1b[97;3u").map((u) => chordName(u.key));
  assert.deepEqual(names, ["shift+super+e", "ctrl+space", "super+c", "escape", "shift+enter", "alt+a"]);
});

test("mouse reports decode to cells and buttons", () => {
  const [down, up, wheel, legacy] = units("\x1b[<2;10;5M\x1b[<2;10;5m\x1b[<65;1;1M\x1b[M !!").map((u) => u.mouse);
  assert.deepEqual([down.kind, down.button, down.col, down.row], ["down", "right", 9, 4]);
  assert.equal(up.kind, "up");
  assert.equal(wheel.kind, "scrolldown");
  assert.deepEqual([legacy.kind, legacy.button, legacy.col, legacy.row], ["down", "left", 0, 0]);
});

test("keys pxsh got in the kitty form go on as the bytes Ghostty sends a legacy program", () => {
  const vt = new Vt(80, 24);
  const legacy = (input) => units(input).map((u) => legacyKey(u.key, vt).toString("latin1")).join("");
  assert.equal(legacy("\x1b[27u"), "\x1b");
  assert.equal(legacy("\x1b[99;5u"), "\x03");
  assert.equal(legacy("\x1b[32;5u"), "\x00");
  assert.equal(legacy("\x1b[97;3u"), "\x1ba");
  assert.equal(legacy("\x1b[97;4u"), "\x1bA");
  assert.equal(legacy("\x1b[127;3u"), "\x1b\x7f");
  assert.equal(legacy("\x1b[127;5u"), "\x08");
  assert.equal(legacy("\x1b[13;3u"), "\x1b\r");
  assert.equal(legacy("\x1b[9;2u"), "\x1b[Z");
  assert.equal(legacy("\x1b[99;9u"), "", "cmd+c types nothing, as on macOS");
  assert.equal(legacy("\x1b[1;3D"), "\x1b[1;3D");
  assert.equal(legacy("a"), "a");
  vt.write("\x1b[?1h");
  assert.equal(legacy("\x1b[A"), "\x1bOA", "cursor keys follow the program's application mode");
});

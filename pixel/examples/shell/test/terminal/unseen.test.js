const assert = require("node:assert/strict");
const { test } = require("node:test");

const { UnseenRows } = require("../../dist/terminal/unseen.js");
const { Vt } = require("../../dist/terminal/vt.js");

function startedAt(row, rows = 30) {
  const vt = new Vt(100, rows, { scrollback: 1000 });
  vt.write(`\x1b[${row + 1};1H`);
  const unseen = new UnseenRows(vt);
  unseen.startAbove(row);
  return { vt, unseen, write: (text) => unseen.write(Buffer.from(text)) };
}

test("rows above the starting cursor are unseen until they scroll away", () => {
  const { unseen, write } = startedAt(25);
  assert.equal(unseen.rows, 25);
  write("one\r\ntwo\r\nthree\r\n");
  assert.equal(unseen.rows, 25, "nothing scrolled yet");
  write("four\r\nfive\r\nsix\r\n");
  assert.equal(unseen.rows, 23);
  write("x\r\n".repeat(40));
  assert.equal(unseen.rows, 0);
});

test("erasing the whole display, or a full reset, makes every row seen", () => {
  for (const clear of ["\x1b[H\x1b[2J", "\x1b[2J", "\x1bc", "\x1b[H\x1b[J", "\x1b[29;1H\x1b[1J"]) {
    const { unseen, write } = startedAt(25);
    write(`prompt> ${clear}`);
    assert.equal(unseen.rows, 0, JSON.stringify(clear));
  }
});

test("erasing below a row only makes the rows from there down seen, and erasing the scrollback changes nothing on screen", () => {
  const { unseen, write } = startedAt(25);
  write("\x1b[11;1H\x1b[J");
  assert.equal(unseen.rows, 10);
  write("\x1b[6;4H\x1b[0J");
  assert.equal(unseen.rows, 6);
  write("\x1b[3J");
  assert.equal(unseen.rows, 6);
});

test("an erase split across two writes is missed, which only leaves rows unseen", () => {
  const { unseen, write } = startedAt(25);
  write("\x1b[H\x1b[");
  write("2J");
  assert.equal(unseen.rows, 25);
});

test("clearing the alternate screen leaves the main screen's unseen rows alone", () => {
  const { unseen, write } = startedAt(25);
  write("\x1b[?1049h\x1b[H\x1b[2J");
  write("y\r\n".repeat(40));
  write("\x1b[?1049l");
  assert.equal(unseen.rows, 25);
});

test("a reflow that pulls lines back out of the scrollback brings unseen rows back with them", () => {
  const { vt, unseen, write } = startedAt(25);
  write("a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n");
  assert.equal(unseen.rows, 22);
  vt.resize(100, 40, 10, 20);
  unseen.reflowed();
  assert.equal(unseen.rows, 25, "the three lines pulled down from the scrollback are unseen too");
  vt.resize(100, 20, 10, 20);
  unseen.reflowed();
  assert.equal(vt.info().cursorY, 19);
  assert.equal(unseen.rows, 12);
});

test("after a reflow, rows above the cursor count as unseen", () => {
  const { vt, unseen, write } = startedAt(25);
  write("prompt> ");
  unseen.shifted(-5);
  assert.equal(unseen.rows, 20);
  unseen.atLeastAboveCursor();
  assert.equal(unseen.rows, vt.info().cursorY);
});

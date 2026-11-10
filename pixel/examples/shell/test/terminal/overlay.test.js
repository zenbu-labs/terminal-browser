const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Overlay } = require("../../dist/terminal/overlay.js");
const { Vt, sgr } = require("../../dist/terminal/vt.js");

function setup(cols = 30, rows = 8) {
  const model = new Vt(cols, rows, { scrollback: 100 });
  const real = new Vt(cols, rows, { scrollback: 100 });
  const written = [];
  const overlay = new Overlay(model, (data) => {
    written.push(data);
    real.write(data);
  });
  const shell = (data) => {
    overlay.lift();
    model.write(data);
    real.write(data);
    overlay.commit();
  };
  return { model, real, overlay, shell, written };
}

function screen(vt) {
  const info = vt.info();
  const rows = [];
  for (let y = 0; y < info.rows; y++) {
    const cells = [];
    for (let x = 0; x < info.cols; x++) {
      const c = vt.cell(x, y);
      cells.push(`${c.text}|${c.wide}|${c.spacer}|${sgr(c.style)}|${c.link ?? ""}`);
    }
    rows.push(cells.join(" "));
  }
  return { rows, cursor: [info.cursorX, info.cursorY, info.pendingWrap], pen: sgr(vt.pen()), alt: info.altScreen };
}

const SHELL = [
  "\x1b[1;32muser\x1b[0m@host \x1b[44m blue bar \x1b[K\x1b[0m\r\n",
  "wide 世界 and é \x1b]8;;https://x.y\x07link\x1b]8;;\x07\r\n",
  "\x1b[4:3;58;5;1mcurly\x1b[0m \x1b[7minverse\x1b[0m\r\n",
  "READY> \x1b[3mtyped",
].join("");

function box(overlay, cells, from, to, image = 0x7e42) {
  const map = new Map();
  for (let row = from.row; row <= to.row; row++) {
    for (let col = from.col; col <= to.col; col++) map.set(overlay.key(row, col), { image, row, col });
  }
  return map;
}

test("an overlay over styled text, wide characters and links leaves the screen exactly as it was once it closes", () => {
  const { model, real, overlay, shell } = setup();
  shell(SHELL);
  const before = screen(real);
  assert.deepEqual(before, screen(model));
  overlay.setCells(box(overlay, null, { row: 0, col: 3 }, { row: 3, col: 10 }));
  overlay.commit();
  const open = screen(real);
  assert.notDeepEqual(open.rows, before.rows);
  assert.equal(real.cell(3, 0).text.codePointAt(0), 0x10eeee, "placeholders are on screen");
  assert.deepEqual([open.cursor, open.pen], [before.cursor, before.pen], "cursor and pen are the shell's while the overlay shows");
  overlay.setCells(new Map());
  overlay.commit();
  assert.deepEqual(screen(real), before);
});

test("an overlay that moves and shrinks puts back only what it no longer covers", () => {
  const { real, overlay, shell } = setup();
  shell(SHELL);
  const before = screen(real);
  overlay.setCells(box(overlay, null, { row: 0, col: 0 }, { row: 3, col: 29 }));
  overlay.commit();
  overlay.setCells(box(overlay, null, { row: 2, col: 5 }, { row: 2, col: 6 }));
  overlay.commit();
  const after = screen(real);
  assert.deepEqual(after.rows.filter((_, i) => i !== 2), before.rows.filter((_, i) => i !== 2));
  overlay.setCells(new Map());
  overlay.commit();
  assert.deepEqual(screen(real), before);
});

test("shell output while an overlay shows lands on the shell's cells, and the overlay comes back over it", () => {
  const { model, real, overlay, shell } = setup(30, 6);
  shell(SHELL);
  overlay.setCells(box(overlay, null, { row: 1, col: 2 }, { row: 2, col: 8 }));
  overlay.commit();
  shell("\r\nmore output that scrolls\r\nand more\r\nREADY> ");
  assert.equal(real.cell(2, 1).text.codePointAt(0), 0x10eeee);
  overlay.setCells(new Map());
  overlay.commit();
  assert.deepEqual(screen(real), screen(model));
  assert.equal(real.lines(-10, 10).flatMap((l) => l.cells).some((c) => c.codePointAt(0) === 0x10eeee), false, "no placeholder scrolled into history");
});

test("pxsh's writes keep a pending wrap, insert mode and the shell's own synchronized update", () => {
  const { model, real, overlay, shell, written } = setup(10, 4);
  shell("0123456789");
  assert.equal(model.info().pendingWrap, true);
  overlay.setCells(box(overlay, null, { row: 2, col: 0 }, { row: 2, col: 3 }));
  overlay.commit();
  assert.equal(real.info().pendingWrap, true);
  shell("X");
  overlay.setCells(new Map());
  overlay.commit();
  assert.deepEqual(screen(real), screen(model));
  shell("\x1b[4h\x1b[?2026h");
  written.length = 0;
  overlay.setCells(box(overlay, null, { row: 3, col: 0 }, { row: 3, col: 1 }));
  overlay.commit();
  assert.ok(!written.join("").includes("\x1b[?2026l"), "the shell's synchronized update is left running");
  assert.ok(written.join("").includes("\x1b[4l") && written.join("").endsWith(`${sgr(model.pen())}`), "insert mode goes off around pxsh's cells and back on");
  shell("abc");
  overlay.setCells(new Map());
  overlay.commit();
  shell("\x1b[?2026l\x1b[4l");
  assert.deepEqual(screen(real), screen(model));
});

test("nothing is written while the shell is inside an escape sequence", () => {
  const { model, real, overlay, written } = setup();
  model.write("\x1b[3");
  real.write("\x1b[3");
  overlay.setCells(box(overlay, null, { row: 0, col: 0 }, { row: 0, col: 1 }));
  assert.equal(overlay.commit(), false);
  assert.equal(written.length, 0);
  model.write("1m");
  real.write("1m");
  assert.equal(overlay.commit(), true);
});

test("mouse reporting and a hidden cursor are pxsh's only while it needs them", () => {
  const { model, overlay, shell, written } = setup();
  shell("READY> ");
  overlay.wantMouse = true;
  overlay.cursor = "hidden";
  overlay.commit();
  assert.match(written.join(""), /\x1b\[\?1003h\x1b\[\?1006h\x1b\[\?25l/);
  written.length = 0;
  overlay.wantMouse = false;
  overlay.cursor = "shell";
  shell("\x1b[?1000h");
  assert.match(written.join(""), /\x1b\[\?1003l\x1b\[\?1006l\x1b\[\?1000h\x1b\[\?25h/, "the shell's own mouse mode comes back");
  assert.equal(model.mode("normalMouse"), true);
});

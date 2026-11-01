const assert = require("node:assert/strict");
const { test } = require("node:test");

const { barPlacement, bufferRows, bufferStarts, placeChars } = require("../../dist/zsh/layout.js");

test("buffer rows follow wrapping, newlines and wide characters", () => {
  const chars = Array.from("ab漢cd\nxy");
  const rows = bufferRows(chars, placeChars(chars, { row: 3, col: 2 }, 6));
  assert.deepEqual(rows, [
    { row: 3, col: 2, end: 6, text: "ab漢" },
    { row: 4, col: 0, end: 2, text: "cd" },
    { row: 5, col: 0, end: 2, text: "xy" },
  ]);
});

test("a buffer whose cursor is past a newline fits every start column, so all of them are candidates", () => {
  const chars = Array.from("for f in a b\ndone");
  const starts = bufferStarts(chars, chars.length, { row: 7, col: 4 }, 20);
  assert.equal(starts.length, 20);
  assert.ok(starts.some((s) => s.row === 6 && s.col === 2));
});

test("a single line buffer has exactly one start", () => {
  const chars = Array.from("echo hi");
  assert.deepEqual(bufferStarts(chars, 7, { row: 3, col: 9 }, 20), [{ row: 3, col: 2 }]);
});

test("a buffer that exactly fills its row puts the cursor at the start of the next row, like zsh", () => {
  const chars = Array.from("x".repeat(18));
  const places = placeChars(chars, { row: 3, col: 2 }, 20);
  assert.deepEqual(places[places.length - 1], { row: 4, col: 0 });
  assert.deepEqual(bufferStarts(chars, chars.length, { row: 4, col: 0 }, 20), [{ row: 3, col: 2 }]);
});

test("a newline right after a full row leaves that next row empty, like zsh", () => {
  const chars = Array.from("x".repeat(18) + "\nabc");
  assert.deepEqual(bufferRows(chars, placeChars(chars, { row: 3, col: 2 }, 20)), [
    { row: 3, col: 2, end: 20, text: "x".repeat(18) },
    { row: 5, col: 0, end: 3, text: "abc" },
  ]);
});

test("the AI bar opens on the side its tallest size fits, prefers below, and is capped by the room on that side", () => {
  assert.deepEqual(barPlacement({ roomBelow: 500, roomAbove: 600, tallest: 400 }), { side: "below", maxHeight: 500 });
  assert.deepEqual(barPlacement({ roomBelow: 100, roomAbove: 600, tallest: 400 }), { side: "above", maxHeight: 600 });
});

test("in a zoomed-in pane where the bar fits on neither side, it takes the side with more room and never more than that room", () => {
  assert.deepEqual(barPlacement({ roomBelow: 120, roomAbove: 300, tallest: 800 }), { side: "above", maxHeight: 300 });
  assert.deepEqual(barPlacement({ roomBelow: 300, roomAbove: 120, tallest: 800 }), { side: "below", maxHeight: 300 });
});

test("an open bar keeps its side when the room changes", () => {
  assert.deepEqual(barPlacement({ roomBelow: 100, roomAbove: 600, tallest: 400, side: "below" }), { side: "below", maxHeight: 100 });
});

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { UndoCheckpoints } = require("../../dist/zsh/undo.js");

const state = (buffer, cursor, change, extra = {}) => ({
  keymap: "main",
  cursor,
  mark: 0,
  regionActive: false,
  buffer,
  postdisplay: "",
  predisplay: "",
  highlight: [],
  change,
  history: 100,
  ...extra,
});

function type(undo, text, from) {
  let { buffer, change } = from;
  for (const char of text) {
    buffer += char;
    change += 1;
    undo.observe(state(buffer, Array.from(buffer).length, change));
  }
  return state(buffer, Array.from(buffer).length, change);
}

function fresh() {
  const undo = new UndoCheckpoints();
  const start = state("", 0, 0);
  undo.observe(start);
  return { undo, start };
}

test("typing undoes a word at a time and redoes forward again", () => {
  const { undo, start } = fresh();
  type(undo, "git commit -m one", start);
  assert.deepEqual(undo.undo(), { action: "undo", change: 13 });
  undo.observe(state("git commit -m", 13, 17));
  assert.deepEqual(undo.undo(), { action: "undo", change: 10 });
  undo.observe(state("git commit", 10, 17));
  assert.deepEqual(undo.redo(), { action: "redo", change: 13 });
  undo.observe(state("git commit -m", 13, 17));
  assert.deepEqual(undo.redo(), { action: "redo", change: 17 });
  undo.observe(state("git commit -m one", 17, 17));
  assert.equal(undo.redo(), null);
});

test("undo stops at the start of the line", () => {
  const { undo, start } = fresh();
  type(undo, "ls", start);
  assert.deepEqual(undo.undo(), { action: "undo", change: 0 });
  undo.observe(state("", 0, 2));
  assert.equal(undo.undo(), null);
});

test("a run of deletions is one step", () => {
  const { undo, start } = fresh();
  type(undo, "abc", start);
  undo.observe(state("ab", 2, 4));
  undo.observe(state("a", 1, 5));
  assert.deepEqual(undo.undo(), { action: "undo", change: 3 });
});

test("a paste is its own step", () => {
  const { undo, start } = fresh();
  const typed = type(undo, "echo ", start);
  undo.observe(state("echo hello world", 16, typed.change + 1));
  type(undo, " x", state("echo hello world", 16, typed.change + 1));
  assert.deepEqual(undo.undo(), { action: "undo", change: 6 });
  undo.observe(state("echo hello world", 16, 8));
  assert.deepEqual(undo.undo(), { action: "undo", change: 5 });
});

test("ghost text and highlighting do not make steps", () => {
  const { undo, start } = fresh();
  undo.observe(state("e", 1, 1));
  undo.observe(state("e", 1, 1, { postdisplay: "cho hi", highlight: ["0 1 fg=red"] }));
  undo.observe(state("ec", 2, 2, { postdisplay: "ho hi" }));
  assert.deepEqual(undo.undo(), { action: "undo", change: 0 });
});

test("moving the cursor ends a typing run", () => {
  const { undo, start } = fresh();
  type(undo, "ab", start);
  undo.observe(state("ab", 0, 2));
  undo.observe(state("cab", 1, 3));
  assert.deepEqual(undo.undo(), { action: "undo", change: 2 });
});

test("typing over a selection undoes the replacement and the typing after it together", () => {
  const { undo, start } = fresh();
  const typed = type(undo, "echo abc", start);
  undo.observe(state("echo abc", 8, 8, { mark: 5, regionActive: true }));
  undo.observe(state("echo x", 6, 9));
  type(undo, "yz", state("echo x", 6, 9));
  assert.deepEqual(undo.undo(), { action: "undo", change: typed.change });
});

test("undoing a history recall returns to the line being edited", () => {
  const { undo, start } = fresh();
  type(undo, "git", start);
  undo.observe(state("git push", 8, 3, { history: 99 }));
  undo.observe(state("git push", 8, 3, { history: 98 }));
  assert.deepEqual(undo.undo(), { action: "undo" });
  undo.observe(state("git", 3, 3));
  assert.deepEqual(undo.undo(), { action: "undo", change: 0 });
});

test("a new edit after undo drops the redo steps", () => {
  const { undo, start } = fresh();
  type(undo, "ab cd", start);
  assert.deepEqual(undo.undo(), { action: "undo", change: 2 });
  undo.observe(state("ab", 2, 5));
  undo.observe(state("abx", 3, 6));
  assert.equal(undo.redo(), null);
  assert.deepEqual(undo.undo(), { action: "undo", change: 2 });
});

test("after zle's own undo, steps fall back to zle's until the next edit", () => {
  const { undo, start } = fresh();
  type(undo, "ab cd", start);
  undo.observe(state("ab", 2, 5));
  assert.deepEqual(undo.undo(), { action: "undo" });
  undo.observe(state("a", 1, 5));
  assert.deepEqual(undo.redo(), { action: "redo" });
  undo.observe(state("ab", 2, 5));
  undo.observe(state("abx", 3, 6));
  assert.deepEqual(undo.undo(), { action: "undo", change: 5 });
});

test("a new line starts with no steps", () => {
  const { undo, start } = fresh();
  type(undo, "ls -la", start);
  undo.reset();
  undo.observe(state("", 0, 0));
  assert.equal(undo.undo(), null);
});

const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { isPageSelectionCurrent, readPageSelection } = require("../dist/session/copy.js");

function frameFor(text, activeElement = null) {
  return {
    detached: false,
    url: "https://example.test/frame",
    isDestroyed: () => false,
    executeJavaScript: async (source) => vm.runInNewContext(source, {
      document: { activeElement },
      getSelection: () => text,
      performance: { timeOrigin: 42 },
    }),
  };
}

const contentsFor = (frame) => ({ focusedFrame: frame, isDestroyed: () => false });

test("selection reader preserves Unicode, whitespace-only text and multiline textarea slices", async () => {
  for (const text of ["  Ω\n42\t ", " \n\t"]) {
    assert.equal((await readPageSelection(contentsFor(frameFor(text)))).text, text);
  }
  const value = "prefix|  Line A Ω\nLine B 42  |suffix";
  const element = { value, selectionStart: 7, selectionEnd: value.length - 7 };
  const selection = await readPageSelection(contentsFor(frameFor("stale page text", element)));
  assert.equal(selection.text, "  Line A Ω\nLine B 42  ");
});

test("empty page and collapsed editor selections produce no clipboard candidate", async () => {
  assert.equal(await readPageSelection(contentsFor(frameFor(""))), null);
  const caret = { value: "text", selectionStart: 2, selectionEnd: 2 };
  assert.equal(await readPageSelection(contentsFor(frameFor("stale page text", caret))), null);
});

test("only the focused iframe is read, not a parent frame's stale selection", async () => {
  const child = frameFor("Frame Ω 42");
  const selection = await readPageSelection({
    ...contentsFor(child),
    mainFrame: { executeJavaScript() { throw new Error("parent frame must not be read"); } },
  });
  assert.equal(selection.text, "Frame Ω 42");
  assert.equal(selection.frame, child);
  assert.equal(selection.timeOrigin, 42);
});

test("missing, destroyed and detached targets are ignored", async () => {
  assert.equal(await readPageSelection(contentsFor(null)), null);
  const frame = frameFor("stale");
  assert.equal(await readPageSelection({ ...contentsFor(frame), isDestroyed: () => true }), null);
  frame.detached = true;
  assert.equal(await readPageSelection(contentsFor(frame)), null);
  frame.detached = false;
  frame.isDestroyed = () => true;
  assert.equal(await readPageSelection(contentsFor(frame)), null);
});

test("selection freshness requires the original live frame and document", async () => {
  const frame = frameFor("selection");
  const selection = await readPageSelection(contentsFor(frame));
  assert.equal(await isPageSelectionCurrent(selection), true);
  frame.url = "https://example.test/new-frame-route";
  assert.equal(await isPageSelectionCurrent(selection), false);
  frame.url = "https://example.test/frame";
  frame.executeJavaScript = async () => 43;
  assert.equal(await isPageSelectionCurrent(selection), false);
  frame.executeJavaScript = async () => { throw new Error("frame navigated"); };
  assert.equal(await isPageSelectionCurrent(selection), false);
  frame.detached = true;
  assert.equal(await isPageSelectionCurrent(selection), false);
  frame.detached = false;
  frame.isDestroyed = () => true;
  assert.equal(await isPageSelectionCurrent(selection), false);
});

test("frame execution errors and malformed results are safe no-ops", async () => {
  const frame = frameFor("unused");
  frame.executeJavaScript = async () => { throw new Error("frame navigated"); };
  assert.equal(await readPageSelection(contentsFor(frame)), null);
  for (const result of [null, "text", { text: 17, timeOrigin: 42 }, { text: "text" }, { text: "text", timeOrigin: NaN }]) {
    frame.executeJavaScript = async () => result;
    assert.equal(await readPageSelection(contentsFor(frame)), null);
  }
});

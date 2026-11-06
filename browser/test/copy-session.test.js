const assert = require("node:assert/strict");
const { test } = require("node:test");
const { copySession } = require("./support/copy-session.js");

test("alternate copy shortcut reaches selection reader and terminal clipboard sink", async (t) => {
  const app = await copySession(t);
  assert.equal(app.press("c", { alt: true, shift: true }), true);
  await app.settle();
  assert.deepEqual(app.writes, ["Page Ω 42"]);
});

test("alternate copy uses the active text field selection instead of stale page text", async (t) => {
  const app = await copySession(t, "stale page text");
  app.page.activeElement = { value: "prefix|Input Ω 42|suffix", selectionStart: 7, selectionEnd: 17 };
  app.press("c", { alt: true, shift: true });
  await app.settle();
  assert.deepEqual(app.writes, ["Input Ω 42"]);
});

test("palette copy preserves the selection from before the page loses focus", async (t) => {
  const app = await copySession(t);
  app.handle.blur = () => { app.page.text = ""; };
  app.press("k", { ctrl: true });
  app.view.actions.paletteQuery("Copy selected text");
  assert.equal(app.view.palette.items[0]?.id, "page.copy");
  app.view.actions.paletteRun(0);
  await app.settle();
  assert.deepEqual(app.writes, ["Page Ω 42"]);
});

test("alternate copy never copies stale page text while the find editor is focused", async (t) => {
  const app = await copySession(t);
  app.press("f", { ctrl: true, shift: true });
  assert.equal(app.view.findOpen, true);
  app.press("c", { alt: true, shift: true });
  await app.settle();
  assert.deepEqual(app.writes, []);
});

test("palette snapshots are discarded after same-URL document replacement", async (t) => {
  const app = await copySession(t);
  app.press("k", { ctrl: true });
  await app.settle();
  app.page.timeOrigin += 1;
  app.view.actions.paletteQuery("Copy selected text");
  app.view.actions.paletteRun(0);
  await app.settle();
  assert.deepEqual(app.writes, []);
});

test("same-document navigation invalidates the palette's selection", async (t) => {
  const app = await copySession(t);
  app.press("k", { ctrl: true });
  await app.settle();
  app.view.tabActions.state(app.view.tabViews[0].id, { ...app.view.state, url: "https://example.test/new-route", loading: false });
  app.view.actions.paletteQuery("Copy selected text");
  app.view.actions.paletteRun(0);
  await app.settle();
  assert.deepEqual(app.writes, []);
});

test("an older delayed copy cannot overwrite a newer copy", async (t) => {
  const app = await copySession(t, "older");
  const execute = app.frame.executeJavaScript;
  const pending = [];
  app.frame.executeJavaScript = (source) => {
    const result = execute(source);
    return new Promise((resolve) => pending.push(() => resolve(result)));
  };
  app.press("c", { alt: true, shift: true });
  app.page.text = "newer";
  app.press("c", { alt: true, shift: true });
  app.frame.executeJavaScript = execute;
  pending[1]();
  await app.settle();
  pending[0]();
  await app.settle();
  assert.deepEqual(app.writes, ["newer"]);
});

test("address, settings and find editors cannot copy a stale page selection", async (t) => {
  const app = await copySession(t);
  app.press("l", { ctrl: true });
  app.press("c", { alt: true, shift: true });
  app.press("escape");
  app.press(",", { ctrl: true });
  app.press("c", { alt: true, shift: true });
  app.press("escape");
  app.press("f", { ctrl: true, shift: true });
  app.press("k", { ctrl: true });
  app.view.actions.paletteQuery("Copy selected text");
  app.view.actions.paletteRun(0);
  await app.settle();
  assert.deepEqual(app.writes, []);
});

test("copy can be rebound through settings and restored to its default", async (t) => {
  const app = await copySession(t);
  app.press(",", { ctrl: true });
  assert(app.view.settings.shortcuts.some((row) => row.id === "page.copy"));
  app.view.actions.settings.recordShortcut("page.copy");
  app.press("y", { alt: true, shift: true });
  app.press("enter");
  app.press("escape");
  assert.equal(app.press("c", { alt: true, shift: true }), false);
  assert.equal(app.press("y", { alt: true, shift: true }), true);
  await app.settle();
  assert.deepEqual(app.writes, ["Page Ω 42"]);
  app.view.actions.settings.resetShortcut("page.copy");
  app.page.text = "restored";
  app.press("c", { alt: true, shift: true });
  await app.settle();
  assert.deepEqual(app.writes, ["Page Ω 42", "restored"]);
});

test("copy with an empty selection leaves the clipboard untouched", async (t) => {
  const app = await copySession(t, "");
  app.root.setClipboard("sentinel");
  app.press("c", { alt: true, shift: true });
  await app.settle();
  app.page.text = "stale";
  app.page.activeElement = { value: "input", selectionStart: 2, selectionEnd: 2 };
  app.press("c", { alt: true, shift: true });
  await app.settle();
  assert.deepEqual(app.writes, ["sentinel"]);
});

test("copy is suppressed for devtools and discarded when a frame is detached", async (t) => {
  const app = await copySession(t);
  app.press("f12");
  app.press("c", { alt: true, shift: true });
  app.press("f12");
  app.press("c", { alt: true, shift: true });
  app.frame.detached = true;
  await app.settle();
  assert.deepEqual(app.writes, []);
});

test("cancelled palette snapshots are not reused on a later invocation", async (t) => {
  const app = await copySession(t, "cancelled");
  app.press("k", { ctrl: true });
  app.press("escape");
  app.page.text = "fresh";
  app.press("k", { ctrl: true });
  app.view.actions.paletteQuery("Copy selected text");
  app.view.actions.paletteRun(0);
  await app.settle();
  assert.deepEqual(app.writes, ["fresh"]);
});

test("switching away and back invalidates the palette's old selection", async (t) => {
  const app = await copySession(t);
  app.view.actions.tabNew();
  app.view.actions.newTabSubmit("https://second.test");
  const [first, second] = app.view.tabViews;
  app.view.actions.tabSwitch(first.id);
  app.press("k", { ctrl: true });
  app.view.actions.tabSwitch(second.id);
  app.view.actions.tabSwitch(first.id);
  app.view.actions.paletteQuery("Copy selected text");
  app.view.actions.paletteRun(0);
  await app.settle();
  assert.deepEqual(app.writes, []);
});

test("Ctrl+Q still quits without copying", async (t) => {
  const app = await copySession(t);
  assert.equal(app.press("q", { ctrl: true }), true);
  assert.equal(app.stopped, true);
  assert.deepEqual(app.writes, []);
});

test("Ctrl+C falls through to existing clipboard routing without quitting", async (t) => {
  const app = await copySession(t);
  assert.equal(app.press("c", { ctrl: true }), false);
  assert.equal(app.stopped, false);
  assert.deepEqual(app.writes, []);
});

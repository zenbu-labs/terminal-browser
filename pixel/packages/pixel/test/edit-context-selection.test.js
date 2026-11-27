const assert = require("node:assert/strict");
const Module = require("node:module");
const vm = require("node:vm");
const { test } = require("node:test");

const clipboardWrites = [];
const electron = { clipboard: { readText: () => "", writeText: text => clipboardWrites.push(text) } };
const load = Module._load;
let PageInput, ViewRegistry;
try {
  Module._load = function (request, ...rest) {
    return request === "electron" ? electron : load.call(this, request, ...rest);
  };
  ({ PageInput } = require("../dist/web/input.js"));
  ({ ViewRegistry } = require("../dist/registry.js"));
} finally {
  Module._load = load;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function input(activeElement, domSelection = "", others = []) {
  const calls = [];
  const main = { executeJavaScript: async code => vm.runInNewContext(code, {
    document: { activeElement }, getSelection: () => domSelection,
  }) };
  const contents = {
    mainFrame: { framesInSubtree: [main, ...others] },
    paste: () => calls.push(["native paste"]),
    sendInputEvent: event => calls.push(["page key", event]),
  };
  const target = { contents: () => contents, focus: () => {}, scale: () => 1, cdp: async () => {} };
  return { page: new PageInput(target), calls };
}

function registry(page, calls) {
  const root = { info: { colors: {} }, setClipboard: text => calls.push(["terminal clipboard", text]) };
  const views = new ViewRegistry(root, 1, false, {});
  views.focused = { handleKey: () => false, host: page };
  return views;
}

test("EditContext selections are returned without disabling EditContext", async () => {
  const { page } = input({ editContext: { text: "start selected end", selectionStart: 6, selectionEnd: 14 } });
  assert.equal(await page.selectionText(), "selected");
});

test("EditContext selection preserves whitespace, multiline and Unicode text", async () => {
  const text = "  selected\nمرحبا 😀  ";
  const { page } = input({ editContext: { text, selectionStart: 0, selectionEnd: text.length } });
  assert.equal(await page.selectionText(), text);
});

test("textarea and DOM selections retain their existing behavior", async () => {
  assert.equal(await input({ value: "abcde", selectionStart: 1, selectionEnd: 4 }).page.selectionText(), "bcd");
  assert.equal(await input({}, "DOM text").page.selectionText(), "DOM text");
});

test("a collapsed EditContext selection does not copy the whole document", async () => {
  const { page } = input({ editContext: { text: "private document", selectionStart: 3, selectionEnd: 3 } });
  assert.equal(await page.selectionText(), "");
});

test("a collapsed EditContext selection retains a nonempty DOM fallback", async () => {
  const { page } = input({ editContext: { text: "document", selectionStart: 3, selectionEnd: 3 } }, "DOM fallback");
  assert.equal(await page.selectionText(), "DOM fallback");
});

test("missing or inaccessible focused elements retain the DOM fallback", async () => {
  assert.equal(await input(null, "fallback").page.selectionText(), "fallback");
  const element = { get editContext() { throw new Error("unavailable"); } };
  assert.equal(await input(element, "fallback").page.selectionText(), "fallback");
});

test("subtree frames remain searchable after a rejected frame read", async () => {
  const { page } = input({}, "", [
    { executeJavaScript: async () => { throw new Error("detached"); } },
    { executeJavaScript: async () => "child frame selection" },
  ]);
  assert.equal(await page.selectionText(), "child frame selection");
});

for (const key of ["c", "x"]) {
  test(`real Pixel Ctrl+${key.toUpperCase()} routing forwards the EditContext selection`, { skip: process.platform !== "linux" }, async () => {
    const { page, calls } = input({ editContext: { text: "selected", selectionStart: 0, selectionEnd: 8 } });
    registry(page, calls).handleKey({ key, kind: "press", mods: { ctrl: true, super: false, alt: false, shift: false } });
    await tick();
    assert.equal(calls.some(([type, text]) => type === "terminal clipboard" && text === "selected"), true);
    assert.equal(calls.some(([type]) => type === "page key"), true);
  });
}

test("a collapsed selection does not publish a terminal clipboard write", { skip: process.platform !== "linux" }, async () => {
  const { page, calls } = input({ editContext: { text: "document", selectionStart: 2, selectionEnd: 2 } });
  registry(page, calls).handleKey({ key: "x", kind: "press", mods: { ctrl: true, super: false, alt: false, shift: false } });
  await tick();
  assert.equal(calls.some(([type]) => type === "terminal clipboard"), false);
});

test("Linux text paste retains native clipboard staging and dispatch", { skip: process.platform !== "linux" }, async () => {
  const { page, calls } = input({});
  clipboardWrites.length = 0;
  page.paste("paste text");
  await tick();
  assert.deepEqual(clipboardWrites, ["paste text"]);
  assert.deepEqual(calls, [["native paste"]]);
});

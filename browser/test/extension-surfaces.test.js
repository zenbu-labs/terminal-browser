const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-surfaces-"));
const electron = require("./fake-electron.js");
const { LoadedExtension } = require("../dist/extensions/loaded.js");
const { ActionStore } = require("../dist/extensions/action.js");

const ID = "a".repeat(32);
const POPUP_ERROR = "The specified popup path is invalid. Ensure it is a path to a file in this extension.";

function loaded(manifest = {}) {
  const record = { id: ID, path: fs.mkdtempSync(path.join(os.tmpdir(), "tb-surface-ext-")), source: "crx", grantedPermissions: [], grantedOrigins: [] };
  return new LoadedExtension(record, { manifest_version: 3, name: "x", version: "1", ...manifest }, new electron.FakeSession("surfaces"));
}

test("extension pages resolve inside the extension, like Chrome's ResolveExtensionURL", () => {
  const extension = loaded();
  assert.equal(extension.url("popup.html"), `chrome-extension://${ID}/popup.html`);
  assert.equal(extension.url("/ui/popup.html?x=1#y"), `chrome-extension://${ID}/ui/popup.html?x=1#y`);
  assert.equal(extension.url("a/../../b.html"), `chrome-extension://${ID}/b.html`);
  for (const outside of [
    "https://example.com/",
    "http://example.com/",
    "//example.com/x",
    "file:///etc/passwd",
    "terminal-browser://settings",
    `chrome-extension://${"b".repeat(32)}/page.html`,
    "javascript:alert(1)",
    "data:text/html,hi",
  ]) {
    assert.equal(extension.url(outside), null, outside);
  }
});

function actions(extension) {
  const handlers = new Map();
  const service = { router: { handle: (name, handler) => handlers.set(name, handler) }, changed: () => {} };
  const store = new ActionStore(service);
  store.install(service);
  store.extensionLoaded(extension);
  const caller = { extension };
  return { call: (name, ...args) => handlers.get(name)(caller, ...args) };
}

test("action.setPopup takes only this extension's pages, with Chrome's error", () => {
  const { call } = actions(loaded({ action: {} }));
  call("action.setPopup", { popup: "popup.html" });
  assert.equal(call("action.getPopup", {}), `chrome-extension://${ID}/popup.html`);
  for (const popup of ["https://example.com/", "//example.com/", "terminal-browser://settings", "file:///etc/passwd"]) {
    assert.throws(() => call("action.setPopup", { popup }), { message: POPUP_ERROR }, popup);
  }
  assert.equal(call("action.getPopup", {}), `chrome-extension://${ID}/popup.html`);
  call("action.setPopup", { popup: "" });
  assert.equal(call("action.getPopup", {}), "");
});

test("a manifest popup outside the extension is ignored", () => {
  assert.equal(actions(loaded({ action: { default_popup: "https://example.com/" } })).call("action.getPopup", {}), "");
  assert.equal(actions(loaded({ action: { default_popup: "p.html" } })).call("action.getPopup", {}), `chrome-extension://${ID}/p.html`);
});

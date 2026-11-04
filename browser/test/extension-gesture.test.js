const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { test } = require("node:test");

const page = new EventEmitter();
const created = [];
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      app: { on: (event, handler) => event === "web-contents-created" && created.push(handler) },
      ipcMain: { handle() {}, on() {} },
      webContents: { getAllWebContents: () => [page] },
    };
  }
  return load.call(this, request, ...rest);
};

const { hasUserGesture } = require("../dist/extensions/router.js");
const { hadRecentInput, listenForUserActivation, nextUserActivation } = require("../dist/extensions/user-activation.js");

listenForUserActivation();

// Stands in for WebFrameMain, whose activation state comes from Chromium's RenderFrameHost.
function frame({ active = false, destroyed = false, detached = false, documentLifecycle = "active" } = {}) {
  return { isDestroyed: () => destroyed, detached, documentLifecycle, hasTransientUserActivation: () => active };
}

const extension = (gesture) => ({ id: "x", hadRecentUserGesture: () => gesture });

test("a frame acts for the user only when Chromium says it has transient user activation", () => {
  const embedded = frame();
  page.emit("input-event", {}, { type: "mouseDown" });
  assert.equal(hadRecentInput(page), true);
  assert.equal(hasUserGesture({ kind: "frame", extension: extension(false), contents: page, frame: embedded }), false);
  assert.equal(hasUserGesture({ kind: "frame", extension: extension(false), contents: page, frame: frame({ active: true }) }), true);
});

test("a destroyed frame never has a gesture", () => {
  assert.equal(hasUserGesture({ kind: "frame", extension: extension(true), contents: page, frame: frame({ active: true, destroyed: true }) }), false);
});

test("a frame whose document is no longer the active one never has a gesture", () => {
  for (const documentLifecycle of ["pending_deletion", "cached", "prerender"]) {
    assert.equal(hasUserGesture({ kind: "frame", extension: extension(true), contents: page, frame: frame({ active: true, documentLifecycle }) }), false, documentLifecycle);
  }
  assert.equal(hasUserGesture({ kind: "frame", extension: extension(true), contents: page, frame: frame({ active: true, detached: true }) }), false);
});

test("a service worker needs a recent click on its own extension", () => {
  assert.equal(hasUserGesture({ kind: "worker", extension: extension(false) }), false);
  assert.equal(hasUserGesture({ kind: "worker", extension: extension(true) }), true);
});

test("waiting for the user resolves once the page's own document has user activation after a click or key press", async () => {
  const later = new EventEmitter();
  later.mainFrame = { ...frame(), documentId: "first" };
  let active = false;
  later.mainFrame.hasTransientUserActivation = () => active;
  let resolved = null;
  void nextUserActivation(later).then((value) => (resolved = value));
  active = true;
  later.emit("input-event", {}, { type: "mouseMove" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resolved, null);
  later.emit("input-event", {}, { type: "rawKeyDown" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resolved, true);
});

test("waiting for the user gives up once the page shows another document", async () => {
  const later = new EventEmitter();
  later.mainFrame = { ...frame(), documentId: "first" };
  const waiting = nextUserActivation(later);
  later.mainFrame = { ...frame({ active: true }), documentId: "second" };
  later.emit("did-navigate", {}, "https://example.com/");
  later.emit("input-event", {}, { type: "mouseDown" });
  assert.equal(await waiting, false);
});

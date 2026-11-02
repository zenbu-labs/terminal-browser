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
const { hadRecentInput, listenForUserActivation, nextUserInput } = require("../dist/extensions/user-activation.js");

listenForUserActivation();

// Stands in for WebFrameMain, whose activation state comes from Chromium's RenderFrameHost.
function frame({ active = false, destroyed = false } = {}) {
  return { isDestroyed: () => destroyed, hasTransientUserActivation: () => active };
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

test("a service worker needs a recent click on its own extension", () => {
  assert.equal(hasUserGesture({ kind: "worker", extension: extension(false) }), false);
  assert.equal(hasUserGesture({ kind: "worker", extension: extension(true) }), true);
});

test("waiting for input resolves on a click or key press, not on pointer movement", async () => {
  const later = new EventEmitter();
  for (const handler of created) handler({}, later);
  assert.equal(hadRecentInput(later), false);
  let resolved = null;
  void nextUserInput(later).then((value) => (resolved = value));
  later.emit("input-event", {}, { type: "mouseMove" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, null);
  later.emit("input-event", {}, { type: "rawKeyDown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, true);
});

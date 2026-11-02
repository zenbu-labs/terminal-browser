const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { test } = require("node:test");

const page = new EventEmitter();
const created = [];
const ipcListeners = new Map();
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      app: { on: (event, handler) => event === "web-contents-created" && created.push(handler) },
      ipcMain: { handle() {}, on: (channel, handler) => ipcListeners.set(channel, handler) },
      webContents: { getAllWebContents: () => [page] },
    };
  }
  return load.call(this, request, ...rest);
};

const { hasUserGesture } = require("../dist/extensions/router.js");
const { ACTIVATION_CHANNEL } = require("../dist/extensions/activation-reporter.js");
const { hadRecentInput, hasTransientUserActivation, listenForUserActivation } = require("../dist/extensions/user-activation.js");

listenForUserActivation();

let token = 0;
function frame(parent = null) {
  return { processId: 1, frameToken: `frame-${token++}`, parent, isDestroyed: () => false };
}

const extension = (gesture) => ({ id: "x", hadRecentUserGesture: () => gesture });

function clickIn(contents, target) {
  contents.emit("input-event", {}, { type: "mouseDown" });
  ipcListeners.get(ACTIVATION_CHANNEL)({ sender: contents, senderFrame: target });
}

test("typing in a web page doesn't count as a gesture for an extension frame embedded in it", () => {
  const top = frame();
  const embedded = frame(top);
  const caller = { kind: "frame", extension: extension(false), contents: page, frame: embedded };
  clickIn(page, top);
  assert.equal(hadRecentInput(page), true);
  assert.equal(hasUserGesture(caller), false);
  clickIn(page, embedded);
  assert.equal(hasUserGesture(caller), true);
});

test("a click in a frame also activates the frames around it, like Chrome", () => {
  const top = frame();
  const middle = frame(top);
  const inner = frame(middle);
  clickIn(page, middle);
  assert.equal(hasTransientUserActivation(top), true);
  assert.equal(hasTransientUserActivation(middle), true);
  assert.equal(hasTransientUserActivation(inner), false);
});

test("a frame can't claim a gesture without real input reaching its page", () => {
  const quiet = new EventEmitter();
  for (const handler of created) handler({}, quiet);
  const target = frame();
  ipcListeners.get(ACTIVATION_CHANNEL)({ sender: quiet, senderFrame: target });
  assert.equal(hasTransientUserActivation(target), false);
  quiet.emit("input-event", {}, { type: "mouseMove" });
  ipcListeners.get(ACTIVATION_CHANNEL)({ sender: quiet, senderFrame: target });
  assert.equal(hasTransientUserActivation(target), false);
});

test("the gesture expires after five seconds", (t) => {
  const target = frame();
  clickIn(page, target);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 5_001);
  assert.equal(hasTransientUserActivation(target), false);
});

test("a service worker needs a recent click on its own extension", () => {
  assert.equal(hasUserGesture({ kind: "worker", extension: extension(false) }), false);
  assert.equal(hasUserGesture({ kind: "worker", extension: extension(true) }), true);
});

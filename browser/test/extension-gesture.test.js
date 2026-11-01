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

const { Router, hasUserGesture, hadRecentInput } = require("../dist/extensions/router.js");

const extension = (gesture) => ({ id: "x", hadRecentUserGesture: () => gesture });

test("a page only counts as acting for the user right after a click or key press in it", () => {
  new Router({}, () => null);
  const caller = { kind: "frame", extension: extension(false), contents: page };
  assert.equal(hasUserGesture(caller), false);
  page.emit("input-event", {}, { type: "mouseMove" });
  page.emit("input-event", {}, { type: "mouseWheel" });
  assert.equal(hadRecentInput(page), false);
  page.emit("input-event", {}, { type: "mouseDown" });
  assert.equal(hasUserGesture(caller), true);
});

test("pages created later are watched too", () => {
  const later = new EventEmitter();
  for (const handler of created) handler({}, later);
  assert.equal(hadRecentInput(later), false);
  later.emit("input-event", {}, { type: "rawKeyDown" });
  assert.equal(hadRecentInput(later), true);
});

test("a service worker needs a recent click on its own extension", () => {
  assert.equal(hasUserGesture({ kind: "worker", extension: extension(false) }), false);
  assert.equal(hasUserGesture({ kind: "worker", extension: extension(true) }), true);
});

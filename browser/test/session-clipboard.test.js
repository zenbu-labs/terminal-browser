const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { test } = require("node:test");

const { Keymap } = require("../../shared/dist/config/keys.js");
const { ViewRegistry } = require("../../pixel/packages/pixel/dist/registry.js");
const sessionFile = require.resolve("../dist/session/session.js");
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "electron") return { clipboard: { readText: () => "" } };
  if (parent?.filename === sessionFile && !request.startsWith("node:") && request !== "./clipboard") {
    return {};
  }
  return load.call(this, request, parent, ...rest);
};
const { Session } = require(sessionFile);
Module._load = load;

const tick = () => new Promise((resolve) => setImmediate(resolve));
const press = (key, mods = {}) => ({
  key,
  kind: "press",
  mods: { super: false, ctrl: false, alt: false, shift: false, ...mods },
});

function session(overrides = {}) {
  const calls = [];
  const messages = new EventEmitter();
  const handle = {
    cdp: async (method, params) => calls.push([method, params]),
    webContents: { debugger: messages },
  };
  const tab = { id: 1, ref: { current: handle } };
  const value = Object.assign(Object.create(Session.prototype), {
    ctx: { env: {} },
    tabs: { active: tab, activeHandle: handle },
    settings: { recording: false, isOpen: false, keymap: new Keymap(overrides, { noSuper: false }) },
    permissions: { hasPending: () => false },
    records: new Map(),
    copyWatchers: new Map(),
    copyOnSelect: false,
    root: { setClipboard: (text) => calls.push(["clipboard", text]) },
    showToast: (...args) => calls.push(["toast", ...args]),
    shutdown: () => calls.push(["quit"]),
  });
  return { value, tab, handle, calls, messages };
}

function route(value, calls) {
  const root = {
    info: { colors: {} },
    setClipboard: (text) => calls.push(["keyboard clipboard", text]),
  };
  const registry = new ViewRegistry(root, 1, false, { quit: () => {} });
  registry.focused = {
    handleKey: (event) => value.handleKey(event),
    host: {
      selectionText: async () => "editor selection",
      key: (event) => calls.push(["page key", event]),
    },
  };
  return registry;
}

test("Ctrl+Q still quits without sending a page key", () => {
  const { value, calls } = session();
  route(value, calls).handleKey(press("q", { ctrl: true }));
  assert.deepEqual(calls, [["quit"]]);
});

test("an explicit Ctrl+C quit binding is still respected", () => {
  const { value, calls } = session({ quit: ["ctrl+c"] });
  route(value, calls).handleKey(press("c", { ctrl: true }));
  assert.deepEqual(calls, [["quit"]]);
});

test("key releases reach the page without another copy or quit", () => {
  const { value, calls } = session();
  const event = { ...press("c", { ctrl: true }), kind: "release" };
  route(value, calls).handleKey(event);
  assert.deepEqual(calls, [["page key", event]]);
});

test("app-owned Copy/Cut reaches the terminal with copy-on-selection disabled", async () => {
  const { value, calls, messages } = session();
  value.ensureCopyWatcher();
  await tick();
  value.ensureCopyWatcher();
  assert.equal(value.copyWatchers.size, 1);
  assert.equal(messages.listenerCount("message"), 1);
  assert.equal(calls.filter(([method]) => method === "Runtime.addBinding").length, 2);
  messages.emit("message", {}, "Runtime.bindingCalled", {
    name: "__terminalBrowserClipboard", payload: "menu copy",
  });
  assert.deepEqual(calls.slice(-2), [["clipboard", "menu copy"], ["toast", "Copied to clipboard", "done"]]);
  value.copyWatchers.get(1).dispose();
});

test("a retained watcher cannot copy from a background tab", async () => {
  const { value, calls, messages } = session();
  value.ensureCopyWatcher();
  await tick();
  value.tabs.active = { id: 2 };
  messages.emit("message", {}, "Runtime.bindingCalled", {
    name: "__terminalBrowserClipboard", payload: "background",
  });
  assert.equal(calls.some(([method]) => method === "clipboard"), false);
  value.copyWatchers.get(1).dispose();
});

test("missing handles do not create watchers", () => {
  const { value } = session();
  value.tabs.active.ref.current = null;
  value.ensureCopyWatcher();
  assert.equal(value.copyWatchers.size, 0);
});

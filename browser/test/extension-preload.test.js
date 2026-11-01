const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { contextBridge: {}, ipcRenderer: {} };
  return load.call(this, request, ...rest);
};

const { installChromeApis } = require("../dist/extensions/preload.js");
const { API_SPEC } = require("../dist/extensions/protocol.js");
const { API_SCHEMAS } = require("../dist/extensions/api-schemas.js");

const ID = "abcdefghijklmnopabcdefghijklmnop";

function nativeEvent() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
  };
}

// Runs the preload's chrome.* setup in a fake extension context and returns
// what the extension's own code would see.
function context({ manifest = {}, granted = null, isWorker = true, view = null, page = null } = {}) {
  const invoked = [];
  const listened = [];
  let deliver = null;
  const runtime = {
    id: ID,
    getManifest: () => ({ manifest_version: 3, name: "x", version: "1", ...manifest }),
    onMessage: nativeEvent(),
    onMessageExternal: nativeEvent(),
    onConnect: nativeEvent(),
    onConnectExternal: nativeEvent(),
  };
  const chrome = { runtime };
  globalThis.chrome = chrome;
  globalThis.location = { protocol: "chrome-extension:", href: `chrome-extension://${ID}/page.html`, origin: `chrome-extension://${ID}` };
  if (page) globalThis.window = page;
  const bridge = {
    invoke: (method, args) => {
      invoked.push([method, args]);
      return Promise.resolve(method === "runtime.watchSenderTabs" ? { tabs: [], notTabs: [] } : undefined);
    },
    listen: (event) => listened.push(event),
    unlisten() {},
    onEvent: (listener) => (deliver = listener),
    ready() {},
    viewInfo: () => view,
    grantedPermissions: () => granted,
  };
  installChromeApis(bridge, isWorker, API_SPEC, API_SCHEMAS);
  return { chrome, invoked, listened, fire: (name, args) => deliver(name, args, undefined) };
}

test("calls with the wrong argument types throw synchronously with Chrome's message", () => {
  const { chrome, invoked } = context({ granted: ["tabs"] });
  assert.throws(() => chrome.tabs.get("x"), {
    name: "TypeError",
    message: "Error in invocation of tabs.get(integer tabId, optional function callback): No matching signature.",
  });
  assert.throws(() => chrome.tabs.get(-1), {
    message: "Error in invocation of tabs.get(integer tabId, optional function callback): Error at parameter 'tabId': Value must be at least 0.",
  });
  assert.throws(() => chrome.tabs.query({ active: "yes" }), {
    message:
      "Error in invocation of tabs.query(object queryInfo, optional function callback): Error at parameter 'queryInfo': Error at property 'active': Invalid type: expected boolean, found string.",
  });
  assert.throws(() => chrome.permissions.contains({ permissions: 5 }), {
    message:
      "Error in invocation of permissions.contains(permissions.Permissions permissions, optional function callback): Error at parameter 'permissions': Error at property 'permissions': Invalid type: expected array, found integer.",
  });
  assert.throws(() => chrome.tabs.query({ nope: 1 }), /Unexpected property: 'nope'\./);
  assert.throws(() => chrome.windows.create({ type: "bogus" }), /Error at property 'type': Value must be one of normal, panel, popup\./);
  assert.equal(invoked.filter(([method]) => !method.startsWith("runtime.")).length, 0);
});

test("optional arguments can be left out anywhere, like in Chrome", () => {
  const { chrome, invoked } = context();
  chrome.tabs.update({ url: "https://a.test/" });
  chrome.tabs.update(1, { muted: true }, () => {});
  chrome.tabs.query({}, () => {});
  chrome.windows.getAll(undefined);
  assert.deepEqual(
    invoked.filter(([method]) => method.startsWith("tabs.") || method.startsWith("windows.")).map(([method]) => method),
    ["tabs.update", "tabs.update", "tabs.query", "windows.getAll"],
  );
  assert.throws(() => chrome.tabs.update(1, { muted: true }, () => {}, "extra"), /No matching signature/);
});

test("a listener that isn't a function is ignored without an error, like Chrome", () => {
  const { chrome } = context();
  assert.doesNotThrow(() => chrome.tabs.onUpdated.addListener("nope"));
  assert.equal(chrome.tabs.onUpdated.hasListeners(), false);
  assert.throws(() => chrome.tabs.onUpdated.addListener(() => {}, { url: [] }), { name: "TypeError" });
});

test("namespaces only exist while their permission is granted", () => {
  const manifest = { optional_permissions: ["cookies", "history"] };
  const { chrome, fire, listened } = context({ manifest, granted: [] });
  assert.equal(chrome.cookies, undefined);
  assert.equal(chrome.history, undefined);
  assert.ok(listened.includes("runtime.permissionsChanged"));
  fire("runtime.permissionsChanged", [["cookies"]]);
  assert.equal(typeof chrome.cookies.get, "function");
  assert.equal(chrome.history, undefined);
  fire("runtime.permissionsChanged", [[]]);
  assert.equal(chrome.cookies, undefined);
});

test("a manifest permission the main process didn't grant gets no namespace", () => {
  const { chrome } = context({ manifest: { permissions: ["cookies", "downloads"] }, granted: ["downloads"] });
  assert.equal(chrome.cookies, undefined);
  assert.equal(typeof chrome.downloads.download, "function");
});

test("chrome.action only exists with an action manifest key", () => {
  assert.equal(context().chrome.action, undefined);
  assert.equal(typeof context({ manifest: { action: {} } }).chrome.action.setTitle, "function");
});

test("messages from popups, side panels and offscreen documents carry no tab, frame or document", async () => {
  const { chrome, fire } = context();
  const seen = [];
  chrome.runtime.onMessage.addListener((message, sender) => seen.push(sender));
  await new Promise((resolve) => setImmediate(resolve));
  fire("runtime.senderTabs", [{ tabs: [{ id: 3, windowId: 1, index: 0 }], notTabs: [9] }]);
  const [wrapped] = chrome.runtime.onMessage.listeners;
  const popup = { id: ID, url: "u", origin: "o", tab: { id: 9 }, frameId: 0, documentId: "d", documentLifecycle: "active" };
  wrapped("hi", popup, () => {});
  const tab = { id: ID, url: "u", origin: "o", tab: { id: 3 }, frameId: 0, documentId: "d", documentLifecycle: "active" };
  wrapped("hi", tab, () => {});
  assert.deepEqual(Object.keys(seen[0]).sort(), ["id", "origin", "url"]);
  assert.equal(seen[1].tab.windowId, 1);
  assert.equal(seen[1].frameId, 0);
});

test("downloads.onDeterminingFilename listeners answer through suggest", () => {
  const { chrome, fire, invoked } = context({ granted: ["downloads"] });
  const determined = () => invoked.filter(([method]) => method === "downloadsInternal.determineFilename").map(([, args]) => args);
  const listener = (item, suggest) => suggest({ filename: "renamed.txt", conflictAction: "overwrite" });
  chrome.downloads.onDeterminingFilename.addListener(listener);
  fire("downloads.onDeterminingFilename", [{ id: 4, filename: "/tmp/a.txt" }]);
  assert.deepEqual(determined(), [[4, "renamed.txt", "overwrite"]]);
  chrome.downloads.onDeterminingFilename.removeListener(listener);

  let later = null;
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    later = suggest;
    return true;
  });
  fire("downloads.onDeterminingFilename", [{ id: 5, filename: "/tmp/b.txt" }]);
  assert.equal(determined().length, 1);
  later({ filename: "later.txt" });
  later({ filename: "twice.txt" });
  assert.deepEqual(determined()[1], [5, "later.txt", ""]);
  assert.equal(determined().length, 2);
});

test("a listener that never suggests keeps the download's name", () => {
  const { chrome, fire, invoked } = context({ granted: ["downloads"] });
  chrome.downloads.onDeterminingFilename.addListener(() => {});
  fire("downloads.onDeterminingFilename", [{ id: 8, filename: "/tmp/c.txt" }]);
  assert.deepEqual(invoked.find(([method]) => method === "downloadsInternal.determineFilename")[1], [8, "", ""]);
});

test("chrome.extension matches Chrome's members", () => {
  const { chrome } = context();
  assert.deepEqual(chrome.extension.ViewType, { TAB: "tab", POPUP: "popup" });
  assert.equal(chrome.extension.setUpdateUrlData("a=1"), undefined);
  assert.throws(() => chrome.extension.setUpdateUrlData("x".repeat(1025)), /String must have at most 1024 characters/);
  assert.equal(chrome.extension.getViews, undefined);
});

test("extension.getViews returns this page when it matches the filter", () => {
  const page = { location: { origin: `chrome-extension://${ID}` }, frames: [] };
  page.parent = page;
  page.top = page;
  const { chrome } = context({ isWorker: false, page, view: { type: "popup", windowId: 4, tabId: -1 } });
  assert.deepEqual(chrome.extension.getViews(), [page]);
  assert.deepEqual(chrome.extension.getViews({ type: "popup" }), [page]);
  assert.deepEqual(chrome.extension.getViews({ type: "tab" }), []);
  assert.deepEqual(chrome.extension.getViews({ windowId: 5 }), []);
  assert.deepEqual(chrome.extension.getViews({ windowId: -2 }), [page]);
  delete globalThis.window;
});

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const electron = require("./fake-electron.js");
const { PAGE_NOTIFY_MS, allowedInternalCall, installInternalApi, internalHostOf, isInternalUrl, pageNotifier } = require("../dist/pages/internal.js");
const { servePages } = require("../dist/pages/scheme.js");
const { guardInternalNavigation } = require("../dist/pages/navigation.js");
const { INTERNAL_API, internalChannel } = require("../dist/pages/internal-api.js");

const tabs = new Set();
const isTab = (contents) => tabs.has(contents);

function call(origin, { session = electron.session.defaultSession, top = true, tab = true } = {}) {
  const mainFrame = { origin, parent: null };
  const frame = top ? mainFrame : { origin, parent: mainFrame };
  const sender = { session, mainFrame };
  if (tab) tabs.add(sender);
  return { sender, senderFrame: frame };
}

const handlers = Object.fromEntries(
  Object.entries(INTERNAL_API).map(([host, methods]) => [host, Object.fromEntries(methods.map((method) => [method, () => `${host}.${method}`]))]),
);
installInternalApi(handlers, isTab);
servePages(() => ({ cwd: process.cwd(), theme: null }));
guardInternalNavigation();
const ssh = electron.session.fromPartition("persist:ssh-host");

test("only the exact page's top frame in one of our tabs may call its API", () => {
  const served = () => true;
  assert.equal(allowedInternalCall(call("terminal-browser://settings"), "settings", served, isTab), true);
  assert.equal(allowedInternalCall(call("terminal-browser://history"), "settings", served, isTab), false);
  assert.equal(allowedInternalCall(call("https://evil.example"), "settings", served, isTab), false);
  assert.equal(allowedInternalCall(call("terminal-browser://settings.evil"), "settings", served, isTab), false);
  assert.equal(allowedInternalCall(call("terminal-browser://settings", { top: false }), "settings", served, isTab), false);
  assert.equal(allowedInternalCall(call("terminal-browser://settings", { tab: false }), "settings", served, isTab), false);
  assert.equal(allowedInternalCall({ ...call("terminal-browser://settings"), senderFrame: null }, "settings", served, isTab), false);
});

test("a frame origin only matches an internal page when it is Chromium's exact spelling", () => {
  const served = () => true;
  for (const origin of ["TERMINAL-BROWSER://settings", "terminal-browser://SETTINGS", "terminal-browser://settings/", " terminal-browser://settings", "terminal-browser:settings"]) {
    assert.equal(allowedInternalCall(call(origin), "settings", served, isTab), false, origin);
  }
});

test("internal URLs are recognised in every spelling Chromium accepts", () => {
  for (const spelling of ["TERMINAL-BROWSER://Settings/", "terminal-browser:\\\\settings", "terminal-\tbrowser://settings", "  terminal-browser:settings"]) {
    assert.equal(isInternalUrl(spelling), true, spelling);
    assert.equal(internalHostOf(spelling), "settings", spelling);
    const contents = new EventEmitter();
    electron.app.emit("web-contents-created", {}, contents);
    assert.equal(navigate(contents, spelling, { initiator: "https://evil.example" }), true, spelling);
  }
  assert.equal(internalHostOf("https://settings/"), null);
});

test("the API answers internal pages in SSH panes too, with the same guards", async () => {
  const channel = internalChannel("settings", "get");
  const invoke = electron.invokeHandlers.get(channel);
  assert.equal(await invoke(call("terminal-browser://settings")), "settings.get");
  assert.equal(await invoke(call("terminal-browser://settings", { session: ssh })), "settings.get");
  assert.throws(() => invoke(call("https://evil.example", { session: ssh })), /Not allowed/);
  assert.throws(() => invoke(call("terminal-browser://settings", { session: ssh, top: false })), /Not allowed/);
});

test("every session gets the internal page preload and the terminal-browser:// handler", () => {
  for (const session of [electron.session.defaultSession, ssh]) {
    assert.ok(session.preloads.some((script) => script.filePath.endsWith("internal-preload.js")));
    assert.ok(session.protocols.has("terminal-browser"));
  }
});

test("web content can't fetch internal pages, the browser can", async () => {
  const handler = ssh.protocols.get("terminal-browser");
  const fromWeb = await handler({ url: "terminal-browser://settings", initiatorOrigin: "https://evil.example" });
  assert.equal(fromWeb.status, 403);
  const fromExtension = await handler({ url: "terminal-browser://settings", initiatorOrigin: "chrome-extension://abc" });
  assert.equal(fromExtension.status, 403);
  const typed = await handler({ url: "terminal-browser://settings" });
  assert.equal(typed.status, 200);
  const shouted = await handler({ url: "TERMINAL-BROWSER://SETTINGS" });
  assert.match(await shouted.text(), /<title>Settings<\/title>/);
});

function navigate(contents, url, { isMainFrame = true, initiator } = {}) {
  let prevented = false;
  contents.emit("will-frame-navigate", { url, isMainFrame, initiator: initiator && { origin: initiator }, preventDefault: () => (prevented = true) });
  return prevented;
}

test("web pages can't navigate to or frame internal pages", () => {
  const contents = new EventEmitter();
  electron.app.emit("web-contents-created", {}, contents);
  assert.equal(navigate(contents, "terminal-browser://settings", { initiator: "https://evil.example" }), true);
  assert.equal(navigate(contents, "terminal-browser://settings", { isMainFrame: false, initiator: "terminal-browser://start" }), true);
  assert.equal(navigate(contents, "terminal-browser://history", { initiator: "terminal-browser://settings" }), false);
  assert.equal(navigate(contents, "terminal-browser://settings"), true);
  assert.equal(navigate(contents, "https://example.com", { initiator: "https://evil.example" }), false);
});

function runPreload(href, { top = true } = {}) {
  const exposed = {};
  const location = new URL(href);
  const window = {};
  window.top = top ? window : {};
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => (exposed[name] = api) },
    ipcRenderer: { invoke: async (channel) => channel, on() {} },
  };
  const source = fs.readFileSync(path.join(__dirname, "../dist/internal-preload.js"), "utf8");
  vm.runInNewContext(source, { require: () => fakeElectron, location, window, URL });
  return exposed.terminalBrowser ?? null;
}

test("the preload only exposes a page's own API to an internal top frame", async () => {
  const settings = runPreload("terminal-browser://settings/");
  assert.deepEqual(Object.keys(settings).sort(), [...INTERNAL_API.settings, "onChange"].sort());
  assert.equal(await settings.get(), internalChannel("settings", "get"));
  assert.equal(runPreload("terminal-browser://settings/", { top: false }), null);
  assert.equal(runPreload("https://evil.example/"), null);
  assert.equal(runPreload("terminal-browser://unknown/"), null);
});

test("an open page hears about a change at once, and about a burst at most once per window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sent = [];
  const page = { isDestroyed: () => false, getURL: () => "terminal-browser://downloads/", send: (channel) => sent.push(channel) };
  const other = { isDestroyed: () => false, getURL: () => "terminal-browser://history/", send: (channel) => sent.push(`history:${channel}`) };
  t.mock.method(electron.webContents, "getAllWebContents", () => [page, other]);
  const notify = pageNotifier("downloads");

  notify();
  t.mock.timers.tick(0);
  assert.deepEqual(sent, ["tb-internal:changed"]);

  for (let at = 0; at < PAGE_NOTIFY_MS - 50; at += 10) {
    notify();
    t.mock.timers.tick(10);
  }
  assert.equal(sent.length, 1);
  t.mock.timers.tick(50);
  assert.equal(sent.length, 2);

  t.mock.timers.tick(PAGE_NOTIFY_MS * 4);
  notify();
  t.mock.timers.tick(0);
  assert.equal(sent.length, 3);
  t.mock.timers.tick(PAGE_NOTIFY_MS * 4);
  assert.deepEqual(sent, ["tb-internal:changed", "tb-internal:changed", "tb-internal:changed"]);
});

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-active-tab-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-active-tab-config-"));
const electron = require("./fake-electron");
const { startBrowsing } = require("../dist/browsing/index.js");
const { ExtensionService } = require("../dist/extensions/service.js");
const { LoadedExtension } = require("../dist/extensions/loaded.js");
const { canCapturePage, captureVisiblePageError } = require("../dist/extensions/api/page-capture.js");
const { installSearch } = require("../dist/extensions/api/search.js");
const { installTabs } = require("../dist/extensions/api/tabs.js");
const { channelFor } = require("../dist/extensions/protocol.js");

const ID = "a".repeat(32);
const VICTIM = `chrome-extension://${"b".repeat(32)}/vault.html`;

// The settings watchers started by startBrowsing keep the process alive.
test.after(() => setImmediate(() => process.exit(0)));
startBrowsing();

const session = new electron.FakeSession("active-tab");
const nativeGrants = new Set();
session.extensions.grantActiveTab = (id, contents) => nativeGrants.add(`${id}/${contents.id}`) && true;
session.extensions.revokeActiveTab = (id, contents) => nativeGrants.delete(`${id}/${contents.id}`);
const service = new ExtensionService(session);
service.activate();
installSearch(service);
installTabs(service);

const call = (method, ...args) =>
  electron.invokeHandlers.get(channelFor(method))({ sender: { session, id: -1 }, senderFrame: { origin: `chrome-extension://${ID}` } }, ...args);

let nextId = 100;
let nextDocument = 1;

// A tab whose page commits navigations the way Electron reports them: the main frame's document and origin change,
// then did-navigate (or did-navigate-in-page) fires, then the pane sees the new URL.
function openTab(url, origin) {
  const loads = [];
  const contents = Object.assign(new EventEmitter(), {
    id: nextId++,
    mainFrame: { url, origin, documentId: `doc${nextDocument++}` },
    isDestroyed: () => false,
    getTitle: () => "title",
    getURL: () => contents.mainFrame.url,
    loadURL: async (_url, options) => loads.push(options ?? {}),
  });
  const tab = {
    id: contents.id,
    url,
    ref: { current: { webContents: contents, loadURL: () => loads.push({}) } },
    state: { url, title: "title", loading: false, audible: false, muted: false, favicon: null },
    contentsId: contents.id,
    openerId: null,
    lastAccessed: 0,
    pinned: false,
  };
  const tabs = { observer: null, active: tab, count: 1, all: () => [tab], byContentsId: (id) => (id === tab.contentsId ? tab : null) };
  const host = new Proxy({ tabs, focused: () => true, size: () => ({ width: 800, height: 600 }) }, { get: (target, key) => (key in target ? target[key] : () => {}) });
  const window = service.addWindow(host);
  tabs.observer.ready(tab);
  const navigate = (next, nextOrigin, { sameDocument = false } = {}) => {
    const previous = tab.state;
    contents.mainFrame = { url: next, origin: nextOrigin, documentId: sameDocument ? contents.mainFrame.documentId : `doc${nextDocument++}` };
    if (sameDocument) contents.emit("did-navigate-in-page", {}, next, true);
    else contents.emit("did-navigate", {}, next, 200, "OK");
    tab.state = { ...previous, url: next };
    tabs.observer.updated(tab, previous);
  };
  return { tab, tabs, window, contents, navigate, loads };
}

function loadExtension(permissions) {
  const record = { id: ID, path: "/nowhere", source: "webstore", enabled: true, grantedPermissions: [], grantedOrigins: [] };
  const extension = new LoadedExtension(record, { manifest_version: 3, name: "x", version: "1", permissions }, session);
  service.loaded.set(ID, extension);
  return extension;
}

const activeTabExtension = (permissions = []) => loadExtension(["activeTab", ...permissions]);

function granted(extension, { tab, contents }) {
  const url = contents.mainFrame.url;
  return { js: extension.canSeeTab(tab.contentsId, url), native: nativeGrants.has(`${ID}/${contents.id}`) };
}

const BOTH = { js: true, native: true };
const NEITHER = { js: false, native: false };

test("a grant on an opaque-origin page is gone after the tab opens another opaque-origin page", () => {
  for (const [start, next, nextOrigin] of [
    ["data:text/html,<h1>hello</h1>", VICTIM, VICTIM.slice(0, 51)],
    ["about:blank", "data:text/html,other", "null"],
    ["data:text/html,a", "data:text/html,b", "null"],
    ["file:///Users/me/a.html", "terminal-browser://history", "terminal-browser://history"],
  ]) {
    const extension = activeTabExtension(["pageCapture"]);
    const page = openTab(start, start.startsWith("file:") ? "file://" : "null");
    service.grantActiveTab(extension, page.tab);
    assert.deepEqual(granted(extension, page), BOTH, start);
    page.navigate(next, nextOrigin);
    assert.deepEqual(granted(extension, page), NEITHER, `${start} -> ${next}`);
    assert.equal(canCapturePage(extension, page.tab.contentsId, next), false, `${start} -> ${next}`);
    assert.notEqual(captureVisiblePageError(extension, page.tab.contentsId, next), null, `${start} -> ${next}`);
  }
});

test("a cross-origin navigation drops the grant, a same-origin one keeps it, like Chrome", () => {
  const extension = activeTabExtension();
  const page = openTab("https://a.test/", "https://a.test");
  service.grantActiveTab(extension, page.tab);
  page.navigate("https://a.test/next", "https://a.test");
  assert.deepEqual(granted(extension, page), BOTH);
  page.navigate("https://b.test/", "https://b.test");
  assert.deepEqual(granted(extension, page), NEITHER);
  page.navigate("https://a.test/", "https://a.test");
  assert.deepEqual(granted(extension, page), NEITHER);
});

// The tabs.onUpdated events `extension` would get while `body` runs.
function updatesFor(extension, body) {
  const events = [];
  const broadcast = service.broadcast;
  service.broadcast = (name, args) => {
    if (name !== "tabs.onUpdated") return;
    const sent = args(extension);
    if (sent) events.push({ change: sent[1], tab: sent[2] });
  };
  try {
    body();
  } finally {
    service.broadcast = broadcast;
  }
  return events;
}

test("an old activeTab grant doesn't show where the tab is going before the navigation commits", () => {
  const extension = activeTabExtension();
  const page = openTab("https://news.test/story", "https://news.test");
  service.grantActiveTab(extension, page.tab);
  const secret = "https://bank.test/authorize?code=SECRET";
  const events = updatesFor(extension, () => {
    page.contents.emit("did-start-navigation", { url: secret, isMainFrame: true, isSameDocument: false });
    const previous = page.tab.state;
    page.tab.state = { ...previous, loading: true };
    page.tabs.observer.updated(page.tab, previous);
  });
  assert.equal(JSON.stringify(events).includes("SECRET"), false, JSON.stringify(events));
  assert.equal(events[0].change.status, "loading");
  assert.equal(events[0].tab.url, "https://news.test/story");
  assert.equal(JSON.stringify(service.tabInfo(extension, { window: page.window, tab: page.tab })).includes("SECRET"), false);
});

test("after a page without a title commits, the tab's title is its URL, not the previous page's title", () => {
  const extension = loadExtension(["tabs"]);
  const page = openTab("https://mail.test/inbox", "https://mail.test");
  page.tab.state = { ...page.tab.state, title: "Inbox (3) - alice@corp.example" };
  const events = updatesFor(extension, () => {
    const previous = page.tab.state;
    page.contents.mainFrame = { url: "https://other.test/blank", origin: "https://other.test", documentId: `doc${nextDocument++}` };
    page.contents.emit("did-navigate", {}, "https://other.test/blank", 200, "OK");
    page.tab.state = { ...previous, url: "https://other.test/blank", title: "" };
    page.tabs.observer.updated(page.tab, previous);
  });
  assert.equal(JSON.stringify(events).includes("alice"), false, JSON.stringify(events));
  assert.equal(events.at(-1).change.title, "https://other.test/blank");
  assert.equal(events.at(-1).tab.title, "https://other.test/blank");
});

test("a same-document navigation keeps the grant, even on an opaque-origin page", () => {
  const extension = activeTabExtension();
  for (const [url, origin] of [
    ["https://a.test/", "https://a.test"],
    ["data:text/html,a", "null"],
  ]) {
    const page = openTab(url, origin);
    service.grantActiveTab(extension, page.tab);
    page.navigate(`${url}#section`, origin, { sameDocument: true });
    assert.deepEqual(granted(extension, page), BOTH, url);
  }
});

test("a committed error page drops a grant like any other new document", () => {
  const extension = activeTabExtension();
  const page = openTab("https://a.test/", "https://a.test");
  service.grantActiveTab(extension, page.tab);
  page.contents.mainFrame = { url: "https://b.test/", origin: "null", documentId: `doc${nextDocument++}` };
  page.contents.emit("did-fail-provisional-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://b.test/", true);
  assert.deepEqual(granted(extension, page), NEITHER);
});

test("the extension's grant follows Chromium's: none when Chromium refuses it", () => {
  const extension = activeTabExtension();
  const page = openTab("https://a.test/", "https://a.test");
  const grant = session.extensions.grantActiveTab;
  session.extensions.grantActiveTab = () => false;
  try {
    service.grantActiveTab(extension, page.tab);
  } finally {
    session.extensions.grantActiveTab = grant;
  }
  assert.equal(extension.canSeeTab(page.tab.contentsId, "https://a.test/"), false);
});

const FROM_EXTENSION = { initiatorOrigin: `chrome-extension://${ID}/` };

test("search.query loads results from the extension's origin, so the page gets no user activation", async () => {
  loadExtension(["search"]);
  const page = openTab("https://a.test/", "https://a.test");
  await call("search.query", { text: "x", tabId: page.tab.contentsId });
  await call("search.query", { text: "x" });
  assert.deepEqual(page.loads, [FROM_EXTENSION, FROM_EXTENSION]);
});

test("tabs.update loads its url from the extension's origin", async () => {
  loadExtension(["tabs"]);
  const page = openTab("https://a.test/", "https://a.test");
  await call("tabs.update", page.tab.contentsId, { url: "https://b.test/" });
  assert.deepEqual(page.loads, [FROM_EXTENSION]);
});

test("tabs.detectLanguage refuses internal pages and about:blank, like Chrome's IsTranslatableURL", async () => {
  loadExtension([]);
  for (const url of ["terminal-browser://history", "about:blank", "devtools://devtools/bundled/inspector.html"]) {
    const page = openTab(url, "null");
    page.contents.mainFrame.executeJavaScript = async () => "en";
    await assert.rejects(call("tabs.detectLanguage", page.tab.contentsId), { message: "Language detection is not supported for this page." }, url);
  }
  const page = openTab("https://a.test/", "https://a.test");
  page.contents.mainFrame.executeJavaScript = async () => "fr-CA";
  assert.equal(await call("tabs.detectLanguage", page.tab.contentsId), "fr");
});

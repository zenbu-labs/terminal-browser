const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-page-leaks-data-"));
const electron = require("./fake-electron");
let userData = null;
electron.app.getPath = () => userData;

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request.endsWith("/browsing") || request === "../../browsing") {
    return { browsing: () => ({ bookmarks: { any: { add() {} }, search: () => [] } }) };
  }
  return load.call(this, request, ...rest);
};

const { LoadedExtension } = require("../dist/extensions/loaded.js");
const { DeclarativeContentStore } = require("../dist/extensions/api/declarative-content.js");
const { ExtensionService, visibleTabChange } = require("../dist/extensions/service.js");

const STORE_ID = "a".repeat(32);
const UNPACKED_ID = "b".repeat(32);
const OTHER_ID = "c".repeat(32);

function extension(id, { source = "webstore", permissions = ["declarativeContent"], hosts = [] } = {}) {
  const record = { id, path: "/nowhere", source, grantedPermissions: [], grantedOrigins: [] };
  const manifest = { manifest_version: 3, name: id, version: "1", permissions, host_permissions: hosts, action: {} };
  return new LoadedExtension(record, manifest, {});
}

// A tab whose document matches every selector it's asked about, like an internal page listing every URL as a link.
class MatchingPage extends EventEmitter {
  constructor(id, url) {
    super();
    this.id = id;
    this.url = url;
    this.injected = [];
  }

  getURL() {
    return this.url;
  }

  isDestroyed() {
    return false;
  }

  executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
    const selectors = JSON.parse(/const selectors = (\[.*\]);/.exec(code)[1]);
    const known = JSON.parse(/const known = (".*");/.exec(code)[1]);
    this.injected.push(selectors);
    return known === selectors.join("\n") ? new Promise(() => {}) : Promise.resolve(selectors);
  }
}

function harness(extensions) {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "tb-page-leaks-userdata-"));
  const shown = new Map();
  const tabs = new Map();
  const listeners = [];
  const service = {
    loaded: new Map(extensions.map((ext) => [ext.id, ext])),
    onUnload() {},
    onUninstall() {},
    onActivate: (run) => run(),
    onTabContents: (listener) => listeners.push(listener),
    tabRef: (contentsId) => (tabs.has(contentsId) ? { tab: tabs.get(contentsId).tab, window: {} } : null),
    contentsOf: (tab) => tabs.get(tab.contentsId)?.contents ?? null,
    allTabs: () => [...tabs.values()].map(({ tab }) => ({ tab })),
    actions: {
      setDeclarative: (extensionId, tabId, state) => shown.set(`${extensionId}:${tabId}`, state?.shown ?? false),
      clearDeclarative() {},
    },
    dispatch() {},
  };
  const store = new DeclarativeContentStore(service);
  let nextId = 100;
  return {
    store,
    open(url) {
      const contents = new MatchingPage(nextId++, url);
      const tab = { contentsId: contents.id, state: { url } };
      tabs.set(contents.id, { tab, contents });
      for (const listener of listeners) listener(contents);
      contents.emit("dom-ready");
      return contents;
    },
    shown: (extensionId, contents) => shown.get(`${extensionId}:${contents.id}`) ?? false,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const rule = (selector) => ({
  conditions: [{ instanceType: "declarativeContent.PageStateMatcher", css: [selector] }],
  actions: [{ instanceType: "declarativeContent.ShowAction" }],
});

test("declarativeContent css conditions never read pages the extension couldn't run on, like Chrome's ContentWatcher", async () => {
  const store = extension(STORE_ID);
  const unpacked = extension(UNPACKED_ID, { source: "unpacked" });
  const h = harness([store, unpacked]);
  const pages = {
    history: h.open("terminal-browser://history"),
    downloads: h.open("terminal-browser://downloads"),
    localDocument: h.open("terminal-browser-file://file/Users/me/notes.html"),
    chromePage: h.open("chrome://extensions"),
    webStore: h.open("https://chromewebstore.google.com/detail/x"),
    otherExtension: h.open(`chrome-extension://${OTHER_ID}/page.html`),
    storeOwnPage: h.open(`chrome-extension://${STORE_ID}/page.html`),
    file: h.open("file:///Users/me/secret.html"),
    web: h.open("https://site.test/"),
  };
  h.store.add(store, [rule('a[href^="https://online.bank.example/"]')]);
  h.store.add(unpacked, [rule('a[title^="https://online.bank.example/"]')]);
  await settle();

  for (const name of ["history", "downloads", "localDocument", "chromePage", "webStore", "otherExtension", "file"]) {
    assert.equal(h.shown(STORE_ID, pages[name]), false, name);
  }
  for (const name of ["history", "downloads", "localDocument", "chromePage", "webStore", "otherExtension", "storeOwnPage"]) {
    assert.equal(h.shown(UNPACKED_ID, pages[name]), false, name);
  }
  for (const name of ["history", "downloads", "localDocument", "chromePage", "webStore"]) {
    assert.deepEqual(pages[name].injected, [], `no watcher in ${name}`);
  }
  assert.equal(h.shown(STORE_ID, pages.web), true);
  assert.equal(h.shown(STORE_ID, pages.storeOwnPage), true);
  assert.equal(h.shown(UNPACKED_ID, pages.web), true);
  assert.equal(h.shown(UNPACKED_ID, pages.file), true, "file access lets the watcher read file:// pages");
  assert.deepEqual(pages.file.injected.at(-1), ['a[title^="https://online.bank.example/"]']);
});

test("a selector shared with an extension that may read the page doesn't match for one that may not", async () => {
  const store = extension(STORE_ID);
  const unpacked = extension(UNPACKED_ID, { source: "unpacked" });
  const h = harness([store, unpacked]);
  const file = h.open("file:///Users/me/secret.html");
  h.store.add(store, [rule("a")]);
  h.store.add(unpacked, [rule("a")]);
  await settle();
  assert.equal(h.shown(UNPACKED_ID, file), true);
  assert.equal(h.shown(STORE_ID, file), false);
});

const scrubTab = (ext, info) => ExtensionService.prototype.scrubTab.call(null, ext, info);

test("a tab's pending URL is scrubbed on its own, like Chrome's ScrubTabForExtension", () => {
  const ext = extension(STORE_ID, { permissions: [], hosts: ["https://a.test/*"] });
  const navigating = { id: 7, url: "https://a.test/", title: "A", pendingUrl: "https://bank.test/statement?id=42", favIconUrl: "https://a.test/f.ico" };
  assert.deepEqual(scrubTab(ext, navigating), { id: 7, url: "https://a.test/", title: "A", favIconUrl: "https://a.test/f.ico" });
  const toInternal = { id: 7, url: "https://a.test/", title: "A", pendingUrl: "terminal-browser://history" };
  assert.equal(scrubTab(ext, toInternal).pendingUrl, undefined);
  const arriving = { id: 7, url: "https://bank.test/", title: "Bank", pendingUrl: "https://a.test/" };
  assert.deepEqual(scrubTab(ext, arriving), { id: 7, pendingUrl: "https://a.test/" });
  const fresh = { id: 7, url: "", title: "https://a.test/", pendingUrl: "https://a.test/" };
  assert.deepEqual(scrubTab(ext, fresh), { id: 7, pendingUrl: "https://a.test/" });
  const tabs = extension(STORE_ID, { permissions: ["tabs"] });
  assert.deepEqual(scrubTab(tabs, navigating), navigating);
});

test("an activeTab grant shows the granted page, not a navigation away from it that hasn't committed yet", () => {
  const ext = extension(STORE_ID, { permissions: ["activeTab"] });
  ext.grantActiveTab(7, { documentId: "doc-1", origin: "https://news.test" });
  const leaving = { id: 7, url: "https://news.test/story", title: "News", pendingUrl: "https://bank.test/authorize?code=SECRET" };
  assert.deepEqual(scrubTab(ext, leaving), { id: 7, url: "https://news.test/story", title: "News" });
  assert.deepEqual(visibleTabChange({ status: "loading", url: leaving.pendingUrl }, scrubTab(ext, leaving)), { status: "loading" });
  const staying = { ...leaving, pendingUrl: "https://news.test/next" };
  assert.deepEqual(scrubTab(ext, staying), staying);
  assert.equal(scrubTab(ext, { id: 8, url: "https://news.test/", title: "News" }).url, undefined, "another tab");
  ext.grantActiveTab(9, { documentId: "doc-2", origin: "null" });
  const opaque = { id: 9, url: "https://a.test/sandboxed", title: "S", pendingUrl: "https://a.test/next" };
  assert.deepEqual(scrubTab(ext, opaque), { id: 9, url: "https://a.test/sandboxed", title: "S" });
});

test("tabs.onUpdated hides a pending URL the extension can't see, even when it sees the committed one", () => {
  const ext = extension(STORE_ID, { permissions: [], hosts: ["https://a.test/*"] });
  const tab = { id: 7, url: "https://a.test/", title: "A", pendingUrl: "https://bank.test/statement?id=42" };
  assert.deepEqual(visibleTabChange({ status: "loading", url: tab.pendingUrl }, scrubTab(ext, tab)), { status: "loading" });
  const toInternal = scrubTab(ext, { ...tab, pendingUrl: "terminal-browser://history" });
  assert.equal(visibleTabChange({ url: "terminal-browser://history" }, toInternal), null);
  const sameSite = scrubTab(ext, { ...tab, pendingUrl: "https://a.test/next" });
  assert.deepEqual(visibleTabChange({ status: "loading", url: "https://a.test/next" }, sameSite), { status: "loading", url: "https://a.test/next" });
  assert.equal(visibleTabChange({ title: "Bank" }, scrubTab(ext, { id: 7, url: "https://bank.test/", title: "Bank" })), null);
});

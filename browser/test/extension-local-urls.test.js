const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-local-urls-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-local-urls-config-"));
const electron = require("./fake-electron");
const { historyEntry } = require("shared");
const { startBrowsing } = require("../dist/browsing/index.js");
const { ExtensionService } = require("../dist/extensions/service.js");
const { LoadedExtension } = require("../dist/extensions/loaded.js");
const { installBookmarks } = require("../dist/extensions/api/bookmarks.js");
const { installHistory } = require("../dist/extensions/api/history.js");
const { installTabs } = require("../dist/extensions/api/tabs.js");
const { channelFor } = require("../dist/extensions/protocol.js");
const { documentUrl } = require("../dist/url.js");

const ID = "a".repeat(32);

test.after(() => setImmediate(() => process.exit(0)));
startBrowsing();

const session = new electron.FakeSession("local-urls");
const service = new ExtensionService(session);
service.activate();
installBookmarks(service);
installHistory(service);
installTabs(service);

const call = (method, ...args) =>
  electron.invokeHandlers.get(channelFor(method))({ sender: { session, id: -1 }, senderFrame: { origin: `chrome-extension://${ID}` } }, ...args);

function loadExtension({ source = "webstore", permissions = [], hosts = [] } = {}) {
  const record = { id: ID, path: "/nowhere", source, enabled: true, grantedPermissions: [], grantedOrigins: [] };
  const manifest = { manifest_version: 3, name: "x", version: "1", permissions, host_permissions: hosts };
  const extension = new LoadedExtension(record, manifest, session);
  service.loaded.set(ID, extension);
  return extension;
}

const downloaded = path.join(os.homedir(), "Downloads", "invoice.html");
const fileUrl = `file://${downloaded}`;

test("an extension without file access can't bookmark a local file, and none can bookmark a local document", async () => {
  loadExtension({ permissions: ["bookmarks"] });
  for (const url of [fileUrl, "FILE:///etc/passwd", documentUrl(downloaded)]) {
    await assert.rejects(call("bookmarks.create", { parentId: "1", title: "Gmail", url }), { message: "Invalid URL." }, url);
  }
  const web = await call("bookmarks.create", { parentId: "1", title: "Gmail", url: "https://mail.example/" });
  await assert.rejects(call("bookmarks.update", web.id, { url: fileUrl }), { message: "Invalid URL." });
  await assert.rejects(call("bookmarks.update", web.id, { url: documentUrl(downloaded) }), { message: "Invalid URL." });
  assert.equal((await call("bookmarks.get", web.id))[0].url, "https://mail.example/");

  loadExtension({ source: "unpacked", permissions: ["bookmarks"] });
  const local = await call("bookmarks.create", { parentId: "1", title: "local", url: fileUrl });
  assert.equal(local.url, fileUrl);
  await assert.rejects(call("bookmarks.create", { parentId: "1", title: "doc", url: documentUrl(downloaded) }), { message: "Invalid URL." });
});

test("history.addUrl drops local files an extension can't read, like Chrome drops urls history doesn't keep", async () => {
  loadExtension({ permissions: ["history"] });
  await call("history.addUrl", { url: fileUrl });
  await call("history.addUrl", { url: documentUrl(downloaded) });
  assert.equal(historyEntry(fileUrl), null);
  await call("history.addUrl", { url: "https://site.example/a" });
  assert.notEqual(historyEntry("https://site.example/a"), null);

  loadExtension({ source: "unpacked", permissions: ["history"] });
  await call("history.addUrl", { url: fileUrl });
  assert.notEqual(historyEntry(fileUrl), null);
});

let nextId = 300;
function openTab(url) {
  const contents = Object.assign(new EventEmitter(), {
    id: nextId++,
    mainFrame: { url, origin: "null", documentId: `doc${nextId}` },
    isDestroyed: () => false,
    isLoading: () => false,
    getTitle: () => "invoice",
    getURL: () => url,
  });
  const tab = {
    id: contents.id,
    url,
    ref: { current: { webContents: contents } },
    state: { url, title: "invoice", loading: false, audible: false, muted: false, favicon: null },
    contentsId: contents.id,
    openerId: null,
    lastAccessed: 0,
    pinned: false,
  };
  const tabs = { observer: null, active: tab, count: 1, all: () => [tab], byContentsId: (id) => (id === tab.contentsId ? tab : null) };
  const host = new Proxy({ tabs, focused: () => true, size: () => ({ width: 800, height: 600 }) }, { get: (target, key) => (key in target ? target[key] : () => {}) });
  service.addWindow(host);
  tabs.observer.ready(tab);
  return tab;
}

test("a local document's tab shows extensions its file:// url, only to those Chrome would show a file page to", async () => {
  const tab = openTab(documentUrl(downloaded));
  loadExtension({ permissions: ["tabs"] });
  assert.equal((await call("tabs.get", tab.contentsId)).url, fileUrl);
  loadExtension({ hosts: ["<all_urls>"] });
  assert.equal((await call("tabs.get", tab.contentsId)).url, undefined);
  loadExtension({ source: "unpacked", hosts: ["<all_urls>"] });
  assert.equal((await call("tabs.get", tab.contentsId)).url, fileUrl);
});

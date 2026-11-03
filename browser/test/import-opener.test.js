const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-import-opener-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-import-opener-config-"));
const electron = require("./fake-electron.js");

let lookups = 0;
const installed = [];
const importService = {
  manager: {},
  importer: {
    find: async (checkStore = true) => (checkStore && lookups++, []),
    install: async (browser, profile, id) => (installed.push(`${browser}/${profile}/${id}`), { id }),
  },
};
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "../extensions/service" && parent?.filename?.endsWith(path.join("pages", "extensions-api.js"))) {
    return { extensionService: () => importService };
  }
  if (request === "@zenbu-labs/pixel") return { initialWebViewState: (url) => ({ url, title: "", loading: true }) };
  return load.call(this, request, parent, ...rest);
};

const { startBrowsing } = require("../dist/browsing/index.js");
const { extensionsHandlers } = require("../dist/pages/extensions-api.js");
const { allowedInternalCall } = require("../dist/pages/internal.js");
const { guardInternalNavigation } = require("../dist/pages/navigation.js");
const { TabManager } = require("../dist/session/tabs.js");
const { ExtensionService } = require("../dist/extensions/service.js");
const { LoadedExtension } = require("../dist/extensions/loaded.js");
const { installTabs } = require("../dist/extensions/api/tabs.js");
const { channelFor } = require("../dist/extensions/protocol.js");

const IMPORT = "terminal-browser://extensions/import";
const EXTENSIONS = "terminal-browser://extensions/";
const WEB = "https://example.com/";
const ID = "e".repeat(32);

// The settings watchers started by startBrowsing keep the process alive.
test.after(() => setImmediate(() => process.exit(0)));
startBrowsing();
guardInternalNavigation();
const handlers = extensionsHandlers();

// The call as the page makes it, through the same gate.
function importStart(contents, ...args) {
  const call = { sender: contents, senderFrame: contents.mainFrame };
  if (!allowedInternalCall(call, "extensions", "importStart", () => true, () => true)) throw new Error("Not allowed");
  return handlers.importStart(contents, ...args);
}

let nextContentsId = 500;
let nextDocument = 1;

function frame(contents, url) {
  return {
    url,
    parent: null,
    origin: url.startsWith("terminal-browser:") ? `terminal-browser://${new URL(url).host}` : new URL(url).origin,
    documentId: `doc${nextDocument++}`,
    documentLifecycle: "active",
    detached: false,
    activated: false,
    isDestroyed: () => false,
    hasTransientUserActivation() {
      return this.activated && contents.mainFrame === this;
    },
  };
}

// What pixel's WebView does for a tab: a page whose navigations start right away and commit a moment later, the
// way Electron reports them. A newer navigation cancels one that hasn't committed yet.
function mountPage(tab) {
  const contents = new EventEmitter();
  const entries = [];
  let index = -1;
  let latest = 0;
  const start = (url, { initiator = null, to = null } = {}) => {
    const seq = ++latest;
    contents.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false, frame: contents.mainFrame, initiator });
    return new Promise((resolve) => {
      setImmediate(() => {
        if (seq !== latest) return resolve();
        contents.mainFrame = frame(contents, url);
        if (to === null) {
          entries.splice(index + 1, entries.length, url);
          index = entries.length - 1;
        } else {
          index = to;
        }
        contents.emit("did-navigate", {}, url, 200, "OK");
        resolve();
      });
    });
  };
  Object.assign(contents, {
    id: nextContentsId++,
    mainFrame: frame(contents, "about:blank"),
    isDestroyed: () => false,
    getURL: () => contents.mainFrame.url,
    getTitle: () => "",
    getType: () => "window",
    loadURL: (url) => start(url),
    followLink: (url) => start(url, { initiator: contents.mainFrame }),
    reload: () => start(entries[index], { to: index }),
    reloadIgnoringCache: () => start(entries[index], { to: index }),
    navigationHistory: {
      canGoBack: () => index > 0,
      canGoForward: () => index < entries.length - 1,
      goBack: () => start(entries[index - 1], { to: index - 1 }),
      goForward: () => start(entries[index + 1], { to: index + 1 }),
    },
  });
  tab.ref.current = {
    webContents: contents,
    loadURL: (url) => void contents.loadURL(url),
    back: () => contents.navigationHistory.goBack(),
    reload: () => contents.reload(),
    focus() {},
    setAudioMuted() {},
    cdp: async () => ({}),
  };
  electron.app.emit("web-contents-created", {}, contents);
  void contents.loadURL(tab.url);
}

let renderQueued = false;
const tabHost = {
  onActivated() {},
  onActiveState() {},
  onPageMenu() {},
  onTabsChanged() {},
  onTabOpened() {},
  tabSwitchAllowed: () => true,
  requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    setImmediate(() => {
      renderQueued = false;
      for (const tab of tabs.all()) if (!tab.ref.current) mountPage(tab);
    });
  },
};
const tabs = new TabManager(tabHost, "about:blank");

const session = new electron.FakeSession("import-opener");
const service = new ExtensionService(session);
service.activate();
installTabs(service);
const windowHost = new Proxy(
  { tabs, focused: () => true, size: () => ({ width: 800, height: 600 }), resolveUrl: (url) => url || "about:blank" },
  { get: (target, key) => (key in target ? target[key] : () => {}) },
);
service.addWindow(windowHost);
const record = { id: ID, path: "/nowhere", source: "webstore", enabled: true, grantedPermissions: [], grantedOrigins: [] };
service.loaded.set(ID, new LoadedExtension(record, { manifest_version: 3, name: "x", version: "1", permissions: ["tabs"] }, session));

const extension = (method, ...args) =>
  electron.invokeHandlers.get(channelFor(method))({ sender: { session, id: -1 }, senderFrame: { origin: `chrome-extension://${ID}` } }, ...args);

const contentsOf = (tabInfo) => tabs.byContentsId(tabInfo.id).ref.current.webContents;
const committed = (contents, url) =>
  contents.getURL() === url ? Promise.resolve() : new Promise((resolve) => contents.on("did-navigate", (_event, at) => at === url && resolve()));
const idle = () => new Promise((resolve) => setTimeout(resolve, 20));
const settled = (promise) => Promise.race([promise.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))]);

async function openedByBrowser(url) {
  const tab = tabs.create(url, true, { byBrowser: true });
  await tabs.whenReady(tab);
  const contents = tab.ref.current.webContents;
  await committed(contents, url);
  return contents;
}

async function openedByExtension(url) {
  const contents = contentsOf(await extension("tabs.create", { url }));
  await committed(contents, url);
  return contents;
}

// Without the user, an import page an extension got to must not look anything up.
async function assertWaitsForTheUser(contents, label) {
  lookups = 0;
  assert.equal(await settled(handlers.importFind(contents)), "waiting", label);
  assert.equal(lookups, 0, label);
  assert.throws(() => importStart(contents, "chrome", "Default", []), { message: "Not allowed" }, label);
}

async function assertLooksUpRightAway(contents, label) {
  lookups = 0;
  assert.equal(await settled(handlers.importFind(contents)), "done", label);
  assert.equal(lookups, 1, label);
}

test("the import page the browser opened looks extensions up on the Web Store right away", async () => {
  await assertLooksUpRightAway(await openedByBrowser(IMPORT), "a tab the browser opened");
  const contents = await openedByBrowser(EXTENSIONS);
  tabs.navigate(tabs.byContentsId(contents.id), IMPORT);
  await committed(contents, IMPORT);
  await assertLooksUpRightAway(contents, "a url typed into the browser");
  const linked = await openedByBrowser(EXTENSIONS);
  await linked.followLink(IMPORT);
  await assertLooksUpRightAway(linked, "a link on the extensions page");
});

test("an extension opening the import page twice gets neither page to look anything up", async () => {
  const [first, second] = (await Promise.all([extension("tabs.create", { url: IMPORT }), extension("tabs.create", { url: IMPORT })])).map(contentsOf);
  await Promise.all([committed(first, IMPORT), committed(second, IMPORT)]);
  await assertWaitsForTheUser(first, "first tab");
  await assertWaitsForTheUser(second, "second tab");
});

test("extension opens racing a browser open only let the browser's page look up", async () => {
  const firstOpen = extension("tabs.create", { url: IMPORT });
  const browserTab = tabs.create(IMPORT, true, { byBrowser: true });
  const secondOpen = extension("tabs.create", { url: IMPORT });
  const [first, second] = await Promise.all([firstOpen, secondOpen]);
  const pages = [contentsOf(first), browserTab.ref.current.webContents, contentsOf(second)];
  await Promise.all(pages.map((contents) => committed(contents, IMPORT)));
  await assertWaitsForTheUser(pages[0], "the first extension tab");
  await assertLooksUpRightAway(pages[1], "the browser's tab");
  await assertWaitsForTheUser(pages[2], "the second extension tab");
});

test("navigating away and back to the import page needs the user", async () => {
  const extensionPage = await openedByExtension(IMPORT);
  await extension("tabs.update", extensionPage.id, { url: WEB });
  await committed(extensionPage, WEB);
  await extension("tabs.goBack", extensionPage.id);
  await committed(extensionPage, IMPORT);
  await assertWaitsForTheUser(extensionPage, "back to the page an extension opened");

  const browserPage = await openedByBrowser(IMPORT);
  await extension("tabs.update", browserPage.id, { url: WEB });
  await committed(browserPage, WEB);
  await extension("tabs.goBack", browserPage.id);
  await committed(browserPage, IMPORT);
  await assertWaitsForTheUser(browserPage, "back to the page the browser opened");
  await extension("tabs.goForward", browserPage.id);
  await committed(browserPage, WEB);
  tabs.byContentsId(browserPage.id).ref.current.back();
  await committed(browserPage, IMPORT);
  await assertWaitsForTheUser(browserPage, "the browser's own back button");
});

test("reloading or duplicating the import page needs the user", async () => {
  const reloaded = await openedByBrowser(IMPORT);
  const before = reloaded.mainFrame;
  await extension("tabs.reload", reloaded.id);
  await idle();
  assert.notEqual(reloaded.mainFrame, before);
  await assertWaitsForTheUser(reloaded, "reloaded by an extension");
  const own = await openedByBrowser(IMPORT);
  tabs.byContentsId(own.id).ref.current.reload();
  await idle();
  await assertWaitsForTheUser(own, "reloaded by the browser");
  const copy = contentsOf(await extension("tabs.duplicate", own.id));
  await committed(copy, IMPORT);
  await assertWaitsForTheUser(copy, "duplicated by an extension");
});

test("only the user's own click on the page lets it look up", async () => {
  const contents = await openedByExtension(IMPORT);
  lookups = 0;
  const found = handlers.importFind(contents);
  contents.emit("input-event", {}, { type: "mouseMove" });
  contents.emit("input-event", {}, { type: "mouseDown" });
  assert.equal(await settled(found), "waiting", "input the page never took as a user activation");
  contents.mainFrame.activated = true;
  contents.emit("input-event", {}, { type: "mouseDown" });
  assert.equal(await settled(found), "done");
  assert.equal(lookups, 1);
});

test("a click on the page that replaced the import page doesn't let it look up", async () => {
  const contents = await openedByExtension(IMPORT);
  lookups = 0;
  const found = handlers.importFind(contents);
  await contents.loadURL(WEB);
  contents.mainFrame.activated = true;
  contents.emit("input-event", {}, { type: "mouseDown" });
  assert.deepEqual(await found, []);
  assert.equal(lookups, 0);
});

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

test("an import installs only what the user's click on Import chose", async () => {
  installed.length = 0;
  const contents = await openedByBrowser(IMPORT);
  await assert.rejects(async () => handlers.importInstall(contents, "chrome", "Default", A), { message: "Not allowed" });
  assert.throws(() => importStart(contents, "chrome", "Default", [A, B]), { message: "Not allowed" }, "without the user's click");
  contents.mainFrame.activated = true;
  importStart(contents, "chrome", "Default", [A, B]);
  contents.mainFrame.activated = false;
  await handlers.importInstall(contents, "chrome", "Default", A);
  await assert.rejects(async () => handlers.importInstall(contents, "chrome", "Default", A), { message: "Not allowed" });
  await assert.rejects(async () => handlers.importInstall(contents, "chrome", "Default", C), { message: "Not allowed" });
  await assert.rejects(async () => handlers.importInstall(contents, "chrome", "Profile 1", B), { message: "Not allowed" });
  await assert.rejects(async () => handlers.importInstall(await openedByBrowser(IMPORT), "chrome", "Default", B), { message: "Not allowed" });
  await contents.reload();
  await assert.rejects(async () => handlers.importInstall(contents, "chrome", "Default", B), { message: "Not allowed" });
  assert.deepEqual(installed, [`chrome/Default/${A}`]);
});

test("on the import page an extension opened, only the user's own click on Import starts an import", async () => {
  installed.length = 0;
  const contents = await openedByExtension(IMPORT);
  assert.throws(() => importStart(contents, "chrome", "Default", [A]), { message: "Not allowed" });
  await assert.rejects(async () => handlers.importInstall(contents, "chrome", "Default", A), { message: "Not allowed" });
  contents.mainFrame.activated = true;
  importStart(contents, "chrome", "Default", [A]);
  contents.mainFrame.activated = false;
  await handlers.importInstall(contents, "chrome", "Default", A);
  assert.deepEqual(installed, [`chrome/Default/${A}`]);
});

test("on the import page an extension opened, a click on the page that replaced it doesn't start an import", async () => {
  const contents = await openedByExtension(IMPORT);
  contents.mainFrame.activated = true;
  contents.mainFrame.documentLifecycle = "pending_deletion";
  assert.throws(() => importStart(contents, "chrome", "Default", [A]), { message: "Not allowed" });
  contents.mainFrame.documentLifecycle = "active";
  contents.mainFrame.detached = true;
  assert.throws(() => importStart(contents, "chrome", "Default", [A]), { message: "Not allowed" });
});

const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { ipcMain: {}, webContents: {}, protocol: {}, app: {} };
  if (request === "@zenbu-labs/pixel") return { initialWebViewState: (url) => ({ url, title: "", loading: true }) };
  return load.call(this, request, ...rest);
};

const { frameOpener, linkOpenRoute, windowOpenRoute } = require("../dist/pages/window-open.js");
const { TabManager } = require("../dist/session/tabs.js");

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

function frame(url, origin, parent = null) {
  return { url, origin, parent, isDestroyed: () => false };
}

function page(...frames) {
  return { mainFrame: { framesInSubtree: frames } };
}

const open = (contents, url, referrer = "") => windowOpenRoute(contents, { url, referrer: { url: referrer, policy: "default" } });

const REFUSED = {
  file: "file:///Users/victim/Downloads/evil.html",
  "local file": "terminal-browser-file://file/Users/victim/notes/private.md",
  "local file, odd spelling": "TERMINAL-BROWSER-FILE:\\\\file/Users/victim/notes/private.md",
  "our page": "terminal-browser://history",
  "chrome page": "chrome://gpu",
  javascript: "javascript:alert(document.domain)",
  data: "data:text/html,<script>alert(1)</script>",
  "view-source": "view-source:https://example.com/",
  filesystem: "filesystem:https://example.com/temporary/a.html",
};

test("an extension surface's window.open can't reach local files, our pages or script URLs", () => {
  const popup = page(frame(`${EXTENSION}/popup.html`, EXTENSION));
  for (const [name, url] of Object.entries(REFUSED)) assert.equal(open(popup, url), null, name);
});

test("an extension surface opens web pages and extension pages as a load from its own origin", () => {
  const popup = page(frame(`${EXTENSION}/popup.html`, EXTENSION));
  assert.deepEqual(open(popup, "https://example.com/a"), { url: "https://example.com/a", initiator: EXTENSION, byBrowser: false, external: null, mayDownload: true });
  assert.deepEqual(open(popup, `${OTHER}/private.html`), { url: `${OTHER}/private.html`, initiator: EXTENSION, byBrowser: false, external: null, mayDownload: true });
  assert.deepEqual(open(popup, "about:blank"), { url: "about:blank", initiator: EXTENSION, byBrowser: false, external: null, mayDownload: true });
});

test("a web page shown in a popup window or side panel gets the same refusals and loads as its own origin", () => {
  const web = page(frame("https://evil.example/p.html", "https://evil.example"));
  for (const [name, url] of Object.entries(REFUSED)) assert.equal(open(web, url), null, name);
  assert.deepEqual(open(web, `${OTHER}/private.html`), { url: `${OTHER}/private.html`, initiator: "https://evil.example", byBrowser: false, external: null, mayDownload: true });
  assert.deepEqual(open(web, "https://example.com/"), { url: "https://example.com/", initiator: "https://evil.example", byBrowser: false, external: null, mayDownload: true });
});

test("an opaque page can't open extension pages, since its load can't carry its origin", () => {
  const sandboxed = page(frame("https://evil.example/sandboxed.html", "null"));
  assert.equal(open(sandboxed, `${OTHER}/war.html`), null);
  assert.equal(open(sandboxed, "terminal-browser-file://file/tmp/a.html"), null);
  assert.deepEqual(open(sandboxed, "https://example.com/"), { url: "https://example.com/", initiator: null, byBrowser: false, external: null, mayDownload: true });
});

test("our own pages open anything, as the browser", () => {
  const history = page(frame("terminal-browser://history/", "terminal-browser://history"));
  assert.deepEqual(open(history, "terminal-browser-file://file/tmp/a.md"), { url: "terminal-browser-file://file/tmp/a.md", initiator: null, byBrowser: true, external: null, mayDownload: true });
  assert.deepEqual(open(history, "terminal-browser://downloads"), { url: "terminal-browser://downloads", initiator: null, byBrowser: true, external: null, mayDownload: true });
});

test("a local page opens its folder's pages and web pages, but not our pages or extension pages", () => {
  const local = page(frame("terminal-browser-file://file/tmp/site/index.html", "null"));
  assert.deepEqual(open(local, "terminal-browser-file://file/tmp/site/other.html"), {
    url: "terminal-browser-file://file/tmp/site/other.html",
    initiator: null,
    byBrowser: false,
    external: null,
    mayDownload: false,
  });
  assert.deepEqual(open(local, "https://example.com/"), { url: "https://example.com/", initiator: null, byBrowser: false, external: null, mayDownload: false });
  assert.equal(open(local, "terminal-browser-file://file/tmp/elsewhere/other.html"), null);
  assert.equal(open(local, "terminal-browser://history"), null);
  assert.equal(open(local, `${OTHER}/war.html`), null);
  assert.equal(open(local, "javascript:alert(1)"), null);
});

test("the user's own \"Open link in new tab\" on a local page opens another folder's page, but never downloads from it", () => {
  const opener = frameOpener(frame("terminal-browser-file://file/tmp/site/index.html", "null"));
  assert.deepEqual(linkOpenRoute(opener, "terminal-browser-file://file/tmp/elsewhere/other.html"), {
    url: "terminal-browser-file://file/tmp/elsewhere/other.html",
    initiator: null,
    byBrowser: false,
    external: null,
    mayDownload: false,
  });
  assert.equal(linkOpenRoute(opener, "terminal-browser-file://file/tmp/site/data.bin").mayDownload, true);
});

test("a web frame inside an extension page is judged as itself, not as the extension", () => {
  const main = frame(`${EXTENSION}/panel.html`, EXTENSION);
  const embedded = page(main, frame("https://evil.example/frame.html", "https://evil.example", main));
  assert.equal(open(embedded, `${EXTENSION}/options.html`, "https://evil.example/").initiator, "https://evil.example");
  assert.equal(open(embedded, `${EXTENSION}/options.html`, `${EXTENSION}/panel.html`).initiator, EXTENSION);
  assert.equal(open(embedded, `${EXTENSION}/options.html`).initiator, "https://evil.example");
  const history = frame("terminal-browser://history/", "terminal-browser://history");
  const framed = page(history, frame("https://evil.example/frame.html", "https://evil.example", history));
  assert.equal(open(framed, "terminal-browser://downloads", "https://evil.example/"), null);
  assert.equal(open(framed, "terminal-browser://downloads"), null);
});

test("without a referrer, frames of two web origins open as an opaque page", () => {
  const main = frame("https://a.example/", "https://a.example");
  const contents = page(main, frame("https://b.example/", "https://b.example", main));
  assert.equal(open(contents, "https://c.example/").initiator, null);
  assert.equal(open(contents, `${OTHER}/war.html`), null);
});

test("tabs a page opens load as the page's origin and never count as opened by the browser", () => {
  const opened = [];
  const host = { onActivated() {}, onActiveState() {}, onPageMenu() {}, onTabsChanged() {}, onTabOpened: (_tab, url) => opened.push(url), tabSwitchAllowed: () => true, requestRender() {} };
  const tabs = new TabManager(host, "about:blank");
  tabs.observer = { created() {}, ready() {}, updated() {}, activated() {}, moved() {}, pinned() {}, removed() {} };
  const opener = tabs.create("https://evil.example/");
  const web = page(frame("https://evil.example/", "https://evil.example"));
  const details = (url, disposition = "foreground-tab") => ({ url, disposition, referrer: { url: "" }, frameName: "", features: "" });
  for (const url of Object.values(REFUSED)) assert.equal(tabs.openWindow(opener.id, details(url), web), "deny", url);
  assert.equal(tabs.openWindow(opener.id, details("terminal-browser://history", "new-window"), web), "deny");
  assert.equal(tabs.count, 1);
  assert.equal(tabs.openWindow(opener.id, details("https://example.com/"), web), "deny");
  const created = tabs.all()[1];
  assert.equal(created.url, "https://example.com/");
  assert.equal(created.initiator, "https://evil.example");
  assert.equal(created.byBrowser, false);
  assert.equal(created.openerId, opener.id);
  assert.deepEqual(opened, ["https://example.com/"]);
  assert.equal(tabs.openWindow(opener.id, details("https://example.com/", "new-window"), web), "popup");
});

function tabManager() {
  const opened = [];
  const external = [];
  const host = {
    onActivated() {},
    onActiveState() {},
    onPageMenu() {},
    onTabsChanged() {},
    onTabOpened: (_tab, url) => opened.push(url),
    onOpenExternal: (tab, route) => external.push({ tab: tab.id, url: route.url, requester: route.external.requester }),
    tabSwitchAllowed: () => true,
    requestRender() {},
  };
  const tabs = new TabManager(host, "about:blank");
  tabs.observer = { created() {}, ready() {}, updated() {}, activated() {}, moved() {}, pinned() {}, removed() {} };
  return { tabs, opened, external };
}

const handlerDetails = (url, disposition = "foreground-tab") => ({ url, disposition, referrer: { url: "" }, frameName: "", features: "" });

test("a page's popup windows (window.open with features) get the same refusals as its tabs", () => {
  const { tabs } = tabManager();
  const opener = tabs.create("https://evil.example/");
  const web = page(frame("https://evil.example/", "https://evil.example"));
  for (const [name, url] of Object.entries(REFUSED)) assert.equal(tabs.openWindow(opener.id, handlerDetails(url, "new-window"), web), "deny", name);
  assert.equal(tabs.openWindow(opener.id, handlerDetails("https://example.com/", "new-window"), web), "popup");
  assert.equal(tabs.openWindow(opener.id, handlerDetails("about:blank", "new-window"), web), "popup");
});

test("Open link in new tab opens as the frame the link is in, like a click would", () => {
  const { tabs, opened } = tabManager();
  const opener = tabs.create("https://evil.example/");
  const main = frame("https://evil.example/", "https://evil.example");
  for (const [name, url] of Object.entries(REFUSED)) assert.equal(tabs.openLink(opener.id, frameOpener(main), url), false, name);
  assert.equal(tabs.openLink(opener.id, frameOpener(frame("https://evil.example/s.html", "null")), `${OTHER}/war.html`), false);
  assert.equal(tabs.openLink(opener.id, null, "https://example.com/"), false, "a frame that's gone");
  assert.equal(tabs.count, 1);
  assert.equal(tabs.openLink(opener.id, frameOpener(main), `${OTHER}/private.html`), true);
  const created = tabs.all()[1];
  assert.equal(created.url, `${OTHER}/private.html`);
  assert.equal(created.initiator, "https://evil.example");
  assert.equal(created.byBrowser, false);
  assert.equal(created.openerId, opener.id);
  assert.deepEqual(opened, [`${OTHER}/private.html`]);
  const history = frame("terminal-browser://history/", "terminal-browser://history");
  assert.equal(tabs.openLink(opener.id, frameOpener(history), "terminal-browser://downloads"), true);
  assert.equal(tabs.all().find((tab) => tab.url === "terminal-browser://downloads").byBrowser, true);
});

test("URLs for other apps open no tab and go to the open-another-app prompt instead", () => {
  const { tabs, external } = tabManager();
  const opener = tabs.create("https://evil.example/");
  const main = frame("https://evil.example/", "https://evil.example");
  const web = page(main);
  assert.equal(tabs.openWindow(opener.id, handlerDetails("myapp://open?payload=1"), web), "deny");
  assert.equal(tabs.openWindow(opener.id, handlerDetails("intent://scan/#Intent;scheme=myapp;end", "new-window"), web), "deny");
  assert.equal(tabs.openLink(opener.id, frameOpener(main), "mailto:a@example.com"), true);
  assert.equal(tabs.count, 1);
  assert.deepEqual(external, [
    { tab: opener.id, url: "myapp://open?payload=1", requester: "https://evil.example" },
    { tab: opener.id, url: "intent://scan/#Intent;scheme=myapp;end", requester: "https://evil.example" },
    { tab: opener.id, url: "mailto:a@example.com", requester: "https://evil.example" },
  ]);
  assert.deepEqual(open(web, "myapp://x").external, { requester: "https://evil.example" });
  assert.equal(open(web, "https://example.com/").external, null);
  assert.equal(open(web, `${OTHER}/war.html`).external, null);
});

const requester = (contents, url, referrer) => open(contents, url, referrer)?.external?.requester ?? null;

test("the open-another-app prompt names a sandboxed frame by the site that made it, not the page around it", () => {
  const main = frame("https://trusted.example/", "https://trusted.example");
  const contents = page(main, frame("https://ads.example/slot.html", "null", main));
  assert.equal(requester(contents, "zoommtg://zoom.us/join"), "https://ads.example");
  assert.equal(requester(contents, "zoommtg://zoom.us/join", "https://ads.example/slot.html"), "https://ads.example");
  assert.equal(requester(page(frame("https://ads.example/sandboxed-page.html", "null")), "zoommtg://zoom.us/join"), "https://ads.example");
  const parent = frame("https://ads.example/slot.html", "https://ads.example", main);
  const dataFrame = page(main, parent, frame("data:text/html,x", "null", parent));
  assert.equal(requester(dataFrame, "zoommtg://zoom.us/join"), "https://ads.example");
});

test("without a referrer, a frame inside the page is named rather than the page", () => {
  const main = frame("https://trusted.example/", "https://trusted.example");
  const contents = page(main, frame("https://ads.example/", "https://ads.example", main));
  assert.equal(requester(contents, "mailto:a@example.com"), "https://ads.example");
  assert.equal(requester(contents, "mailto:a@example.com", "https://trusted.example/"), "https://trusted.example");
});

test("a local file asks as file://, and our own pages never open other apps", () => {
  const local = page(frame("terminal-browser-file://file/tmp/site/index.html", "null"));
  assert.equal(requester(local, "zoommtg://zoom.us/join"), "file://");
  const localMain = frame("terminal-browser-file://file/tmp/site/index.html", "null");
  assert.equal(requester(page(localMain, frame("data:text/html,x", "null", localMain)), "zoommtg://zoom.us/join"), "file://");
  const history = page(frame("terminal-browser://history/", "terminal-browser://history"));
  assert.equal(open(history, "zoommtg://zoom.us/join"), null);
  assert.equal(linkOpenRoute(frameOpener(frame("terminal-browser://settings/", "terminal-browser://settings")), "mailto:a@example.com"), null);
  assert.equal(requester(page(frame("about:blank", "null")), "zoommtg://x"), null, "an opaque page no site made");
});

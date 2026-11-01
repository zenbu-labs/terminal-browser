const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { ipcMain: {}, webContents: {}, protocol: {}, app: {} };
  if (request === "@zenbu-labs/pixel") return { initialWebViewState: (url) => ({ url, title: "", loading: true }) };
  return load.call(this, request, ...rest);
};

const { TabManager } = require("../dist/session/tabs.js");

function manager() {
  const events = [];
  const host = { onActivated() {}, onActiveState() {}, onPageMenu() {}, onTabsChanged() {}, onTabOpened() {}, tabSwitchAllowed: () => true, requestRender() {} };
  const tabs = new TabManager(host, "about:blank");
  tabs.observer = {
    created() {},
    ready() {},
    updated() {},
    activated() {},
    moved: (tab, from, to) => events.push(["moved", tab.url, from, to]),
    pinned: (tab) => events.push(["pinned", tab.url, tab.pinned]),
    removed() {},
  };
  return { tabs, events };
}

test("pinning moves a tab to the end of the pinned tabs, like Chrome", () => {
  const { tabs, events } = manager();
  const [a, b, c] = ["a", "b", "c"].map((url) => tabs.create(url));
  tabs.setPinned(c.id, true);
  assert.deepEqual(tabs.all().map((tab) => tab.url), ["c", "a", "b"]);
  tabs.setPinned(b.id, true);
  assert.deepEqual(tabs.all().map((tab) => tab.url), ["c", "b", "a"]);
  tabs.setPinned(c.id, false);
  assert.deepEqual(tabs.all().map((tab) => tab.url), ["b", "c", "a"]);
  assert.deepEqual(events.slice(0, 2), [["pinned", "c", true], ["moved", "c", 2, 0]]);
  assert.equal(a.pinned, false);
});

test("unpinned tabs can't be moved or opened in front of pinned ones", () => {
  const { tabs } = manager();
  const [a, b] = ["a", "b"].map((url) => tabs.create(url));
  tabs.setPinned(b.id, true);
  tabs.move(a.id, 0);
  assert.deepEqual(tabs.all().map((tab) => tab.url), ["b", "a"]);
  tabs.create("c", false, { index: 0 });
  assert.deepEqual(tabs.all().map((tab) => tab.url), ["b", "c", "a"]);
  tabs.move(b.id, 5);
  assert.deepEqual(tabs.all().map((tab) => tab.url), ["b", "c", "a"]);
});

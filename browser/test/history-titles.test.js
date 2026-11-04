const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-history-titles-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-history-titles-config-"));
const electron = require("./fake-electron.js");
const { deleteAllHistory, historyEntry, searchHistory, visitsForUrl } = require("shared");
const { HistoryRecorder } = require("../dist/browsing/history.js");
const { navigateTyped } = require("../dist/browsing/typed.js");

const recorder = new HistoryRecorder();
recorder.readMode();
const visited = [];
recorder.visited.add((entry) => visited.push({ ...entry }));

// A tab whose events follow Chromium's order: commit first, then a title only when it changed.
function tab() {
  const contents = new EventEmitter();
  contents.session = electron.session.defaultSession;
  let url = "";
  contents.getURL = () => url;
  contents.navigate = (next, { title, explicit = true } = {}) => {
    url = next;
    contents.emit("did-navigate", {}, next);
    if (title !== undefined) contents.emit("page-title-updated", {}, title, explicit);
  };
  contents.reload = () => contents.navigate(url);
  contents.pushState = (next) => {
    url = next;
    contents.emit("did-navigate-in-page", {}, next, true);
  };
  recorder.watch(contents);
  return contents;
}

test("a page first recorded on a reload with an unchanged title keeps its title", () => {
  deleteAllHistory();
  const page = tab();
  recorder.mode = "off";
  page.navigate("https://b.example/", { title: "Page B" });
  assert.equal(historyEntry("https://b.example/"), null);
  recorder.mode = "local";
  page.reload();
  assert.equal(historyEntry("https://b.example/").title, "Page B");
  assert.equal(visited.at(-1).title, "Page B");
  assert.equal(searchHistory({ text: "page b" })[0].url, "https://b.example/");
});

test("same-document navigations carry the page's title", () => {
  deleteAllHistory();
  const page = tab();
  page.navigate("https://app.example/", { title: "Inbox" });
  page.pushState("https://app.example/#mail/1");
  assert.equal(historyEntry("https://app.example/#mail/1").title, "Inbox");
  assert.equal(visited.at(-1).title, "Inbox");
});

test("going back to a cached page records it with its title", () => {
  deleteAllHistory();
  const page = tab();
  page.navigate("https://a.example/", { title: "Page A" });
  page.navigate("https://c.example/", { title: "Page C" });
  deleteAllHistory();
  page.navigate("https://a.example/");
  assert.equal(historyEntry("https://a.example/").title, "Page A");
});

test("a page without a title is stored without one, not with its url", () => {
  deleteAllHistory();
  const page = tab();
  page.navigate("https://untitled.example/page", { title: "untitled.example/page", explicit: false });
  assert.equal(historyEntry("https://untitled.example/page").title, "");
  assert.equal(visited.at(-1).title, "");
});

test("a later title change updates the stored title", () => {
  deleteAllHistory();
  const page = tab();
  page.navigate("https://slow.example/");
  assert.equal(historyEntry("https://slow.example/").title, "");
  page.emit("page-title-updated", {}, "Loaded", true);
  assert.equal(historyEntry("https://slow.example/").title, "Loaded");
});

test("only the navigation typed into the address bar is recorded as typed, wherever it redirects", () => {
  deleteAllHistory();
  const page = tab();
  const other = tab();
  const start = (contents, url) => contents.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
  navigateTyped(page, () => start(page, "https://typed.example/"));
  start(other, "https://typed.example/");
  other.navigate("https://typed.example/");
  page.navigate("https://typed.example/home");
  start(page, "https://typed.example/");
  page.navigate("https://typed.example/");
  const transitions = (url) => visitsForUrl(url).map((visit) => visit.transition);
  assert.deepEqual(transitions("https://typed.example/home"), ["typed"]);
  assert.deepEqual(transitions("https://typed.example/"), ["link", "link"]);
});

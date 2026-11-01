const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-replaced-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-replaced-config-"));
require("./fake-electron.js");
const { addressBarUrl } = require("../dist/pages/navigation.js");

const page = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html";

test("the address bar hides an extension's new tab page like Chrome's empty omnibox", () => {
  assert.equal(addressBarUrl(page, "chrome://newtab/"), "");
});

test("the address bar shows the page an extension's history or bookmarks page replaced", () => {
  assert.equal(addressBarUrl(page, "chrome://history/"), "terminal-browser://history/");
  assert.equal(addressBarUrl(page, "chrome://bookmarks/"), "terminal-browser://bookmarks/");
});

test("the new tab page has an empty address while an extension's replacement loads", () => {
  assert.equal(addressBarUrl("terminal-browser://newtab/", null), "");
});

test("pages nothing replaced keep their own address", () => {
  assert.equal(addressBarUrl(page, null), page);
  assert.equal(addressBarUrl("terminal-browser://history/", null), "terminal-browser://history/");
  assert.equal(addressBarUrl("https://example.com/", null), "https://example.com/");
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-host-access-data-"));
require("./fake-electron");
const { LoadedExtension } = require("../dist/extensions/loaded.js");
const { captureVisiblePageError } = require("../dist/extensions/api/page-capture.js");

const ID = "a".repeat(32);
const OTHER = "b".repeat(32);

function extension(hosts, { source = "webstore", permissions = [] } = {}) {
  const record = { id: ID, path: "/nowhere", source, grantedPermissions: [], grantedOrigins: [] };
  const manifest = { manifest_version: 3, name: "x", version: "1", permissions, host_permissions: hosts };
  return new LoadedExtension(record, manifest, {});
}

test("file:// pages need the user's file access even with <all_urls>, like Chrome", () => {
  const store = extension(["<all_urls>"]);
  assert.equal(store.hasHostAccess("file:///Users/me/secret.txt"), false);
  assert.equal(store.hasHostAccess("https://a.test/"), true);
  const unpacked = extension(["<all_urls>"], { source: "unpacked" });
  assert.equal(unpacked.hasHostAccess("file:///Users/me/secret.txt"), true);
  assert.equal(extension(["file:///*"]).hasHostAccess("file:///etc/passwd"), false);
});

test("a chrome-extension:// host permission grants nothing", () => {
  const ext = extension([`chrome-extension://${OTHER}/*`, "chrome-extension://*/*"]);
  assert.equal(ext.hasHostAccess(`chrome-extension://${OTHER}/page.html`), false);
});

test("host permissions ignore the pattern's path but honour its port", () => {
  const ext = extension(["https://a.test/only/this/*", "https://b.test:8443/*"]);
  assert.equal(ext.hasHostAccess("https://a.test/somewhere/else"), true);
  assert.equal(ext.hasHostAccess("https://b.test:8443/x"), true);
  assert.equal(ext.hasHostAccess("https://b.test/x"), false);
});

test("no host permission reaches the Web Store, chrome:// or another extension's pages", () => {
  const ext = extension(["<all_urls>"]);
  assert.equal(ext.pageAccessError("https://chromewebstore.google.com/detail/x", null), "The extensions gallery cannot be scripted.");
  assert.equal(ext.pageAccessError("https://chrome.google.com/webstore/x", null), "The extensions gallery cannot be scripted.");
  assert.equal(ext.pageAccessError("chrome://settings/", null), "Cannot access a chrome:// URL");
  assert.equal(ext.pageAccessError(`chrome-extension://${OTHER}/a.html`, null), "Cannot access a chrome-extension:// URL of different extension");
  assert.equal(ext.pageAccessError("https://a.test/", null), null);
});

test("captureVisibleTab of a file:// page needs file access even with <all_urls>, like Chrome", () => {
  const store = extension(["<all_urls>"]);
  assert.equal(
    captureVisiblePageError(store, 1, "file:///Users/me/secret.pdf"),
    "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
  );
  assert.equal(captureVisiblePageError(store, 1, "https://a.test/"), null);
  assert.equal(captureVisiblePageError(extension(["<all_urls>"], { source: "unpacked" }), 1, "file:///Users/me/secret.pdf"), null);
  assert.equal(captureVisiblePageError(extension(["https://a.test/*"]), 1, "https://a.test/"), "Either the '<all_urls>' or 'activeTab' permission is required.");
});

test("captureVisibleTab of the Web Store or a data: page needs activeTab, like Chrome", () => {
  const ext = extension(["<all_urls>"]);
  const notInvoked = "The 'activeTab' permission is not in effect because this extension has not been in invoked.";
  assert.equal(captureVisiblePageError(ext, 1, "https://chromewebstore.google.com/detail/x"), notInvoked);
  assert.equal(captureVisiblePageError(ext, 1, "data:text/html,hi"), notInvoked);
  ext.grantActiveTab(1, "https://chromewebstore.google.com/detail/x");
  assert.equal(captureVisiblePageError(ext, 1, "https://chromewebstore.google.com/detail/x"), null);
});

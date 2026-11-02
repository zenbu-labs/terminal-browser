const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-permissions-data-"));

const { requiredPermissions, optionalPermissions, asManifest } = require("../dist/index.js");

test("permissions Chrome on macOS doesn't grant are dropped, like Chrome does", () => {
  const manifest = asManifest({
    manifest_version: 3,
    name: "x",
    version: "1",
    permissions: ["audio", "certificateProvider", "platformKeys", "vpnProvider", "wallpaper", "webRequestBlocking", "tabs", "https://a.test/*"],
    optional_permissions: ["loginState", "cookies"],
  });
  assert.deepEqual(requiredPermissions(manifest).api, ["tabs"]);
  assert.deepEqual(optionalPermissions(manifest).api, ["cookies"]);
});

test("webRequestBlocking stays for Manifest V2 extensions", () => {
  const manifest = asManifest({ manifest_version: 2, name: "x", version: "1", permissions: ["webRequest", "webRequestBlocking", "<all_urls>"] });
  assert.deepEqual(requiredPermissions(manifest).api, ["webRequest", "webRequestBlocking"]);
  assert.deepEqual(requiredPermissions(manifest).hosts, ["<all_urls>"]);
});

const { acceptedPermissions, installWarnings, permissionsIncreased } = require("../dist/index.js");

const ALL = "Read and change all your data on all websites";
const v3 = (extra) => ({ manifest_version: 3, name: "x", version: "1", ...extra });
const script = (...matches) => ({ content_scripts: [{ matches, js: ["a.js"] }] });
const accepted = (manifest, record = { grantedPermissions: [], grantedOrigins: [] }) => acceptedPermissions(manifest, record);

test("content script matches warn like host permissions, as in Chrome", () => {
  assert.deepEqual(installWarnings(v3(script("<all_urls>"))), [ALL]);
  assert.deepEqual(installWarnings(v3(script("*://*/*"))), [ALL]);
  assert.deepEqual(installWarnings(v3({ ...script("https://b.test/*"), host_permissions: ["https://a.test/*"] })), [
    "Read and change your data on a.test and b.test",
  ]);
  assert.deepEqual(installWarnings(v3(script("https://*.example.com/*"))), ["Read and change your data on all example.com sites"]);
});

test("content script matches don't give API host access", () => {
  const required = requiredPermissions(asManifest(v3(script("https://a.test/*"))));
  assert.deepEqual(required.hosts, []);
  assert.deepEqual(required.scriptableHosts, ["https://a.test/*"]);
});

test("any wildcard host on any scheme warns about all websites, like Chrome", () => {
  for (const host of ["http://*/*", "https://*/*", "*://*/*", "ws://*/*", "<all_urls>", "*://*.com/*", "https://*.co.uk/*"]) {
    assert.deepEqual(installWarnings(v3({ host_permissions: [host] })), [ALL], host);
  }
  assert.deepEqual(installWarnings(v3({ host_permissions: ["file:///*"] })), []);
  assert.deepEqual(installWarnings(v3({ host_permissions: ["https://*.github.io/*"] })), ["Read and change your data on all github.io sites"]);
});

test("hosts that differ only by registry are one site, shown with the best registry", () => {
  assert.deepEqual(installWarnings(v3({ host_permissions: ["https://google.de/*", "https://google.com/*", "https://google.co.uk/*"] })), [
    "Read and change your data on google.com",
  ]);
  assert.deepEqual(
    installWarnings(v3({ host_permissions: ["https://d.test/*", "https://c.test/*", "https://b.test/*", "https://a.test/*"] })),
    ["Read and change your data on a number of websites"],
  );
});

test("devtools_page and a new tab override add Chrome's implied warnings", () => {
  assert.deepEqual(installWarnings(v3({ devtools_page: "devtools.html" })), [ALL]);
  assert.deepEqual(installWarnings(v3({ chrome_url_overrides: { newtab: "tab.html" } })), ["Replace the page you see when opening a new tab"]);
});

test("an update that adds content script hosts is a permission increase", () => {
  assert.equal(permissionsIncreased(accepted(v3()), v3(script("<all_urls>"))), true);
  assert.equal(permissionsIncreased(accepted(v3()), v3(script("https://a.test/*"))), true);
  assert.equal(permissionsIncreased(accepted(v3(script("https://a.test/*"))), v3(script("https://b.test/*"))), true);
  assert.equal(permissionsIncreased(accepted(v3()), v3({ devtools_page: "devtools.html" })), true);
});

test("updates that ask for nothing new are not an increase, like Chrome", () => {
  assert.equal(permissionsIncreased(accepted(v3(script("https://a.test/*"))), v3({ host_permissions: ["https://a.test/*"] })), false);
  assert.equal(permissionsIncreased(accepted(v3({ host_permissions: ["https://*.a.test/*"] })), v3(script("https://x.a.test/*"))), false);
  assert.equal(permissionsIncreased(accepted(v3({ host_permissions: ["https://google.com/*"] })), v3({ host_permissions: ["https://google.de/*"] })), false);
  assert.equal(permissionsIncreased(accepted(v3(script("<all_urls>"))), v3({ permissions: ["tabs"], ...script("<all_urls>") })), false);
  assert.equal(permissionsIncreased(accepted(v3()), v3({ permissions: ["storage", "alarms"] })), false);
  assert.equal(permissionsIncreased(accepted(v3()), v3({ permissions: ["tabs"] })), true);
});

test("optional permissions the user granted count as accepted", () => {
  const before = v3({ optional_host_permissions: ["https://a.test/*"], optional_permissions: ["history"] });
  const after = v3({ host_permissions: ["https://a.test/*"], permissions: ["history"] });
  assert.equal(permissionsIncreased(accepted(before), after), true);
  assert.equal(permissionsIncreased(accepted(before, { grantedPermissions: ["history"], grantedOrigins: ["https://a.test/*"] }), after), false);
});

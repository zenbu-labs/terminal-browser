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

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-output-"));
const env = {
  ...process.env,
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_STATE_HOME: path.join(home, "state"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_RUNTIME_DIR: path.join(home, "run"),
};
Object.assign(process.env, env);
const { saveExtension } = require("shared");

const HOSTILE = "Evil\x1b]0;owned\x07\x1b[2K\x1b[1A\r\u202eTool\u009b31m\x08";

saveExtension({
  id: "a".repeat(32),
  path: path.join(home, "ext"),
  version: "1.0\x1b[8m",
  name: HOSTILE,
  source: "unpacked",
  enabled: true,
  disabledReason: null,
  pinned: true,
  grantedPermissions: [],
  grantedOrigins: [],
  shortcuts: {},
  installedAt: 1,
  updatedAt: 1,
  lastUpdateCheck: null,
  userScriptsAllowed: false,
});

function cli(...args) {
  return spawnSync(process.execPath, [path.join(__dirname, "../dist/main.js"), "extensions", ...args], { env, encoding: "utf8" });
}

const RAW = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

test("extension text from a manifest is listed as visible escapes", () => {
  const listed = cli("list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, RAW);
  assert.match(listed.stdout, /Evil\\e\]0;owned\\x07\\e\[2K\\e\[1A\\r\\u202eTool\\u009b31m\\x08/);
});

test("the JSON listing stays lossless but escapes what JSON.stringify leaves raw", () => {
  const listed = cli("list", "--json");
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, RAW);
  assert.equal(JSON.parse(listed.stdout)[0].name, HOSTILE);
});

test("action results print the name with its control characters escaped", () => {
  const removed = cli("remove", "--yes", "a".repeat(32));
  assert.equal(removed.status, 0, removed.stderr);
  assert.doesNotMatch(removed.stdout, RAW);
  assert.match(removed.stdout, /removed Evil\\e\]0;owned/);
});

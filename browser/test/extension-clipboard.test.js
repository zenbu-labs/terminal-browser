const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request !== "shared") return load.call(this, request, ...rest);
  return { sitePermission: () => null, setSitePermission() {} };
};

const { PermissionPrompts } = require("../dist/session/permissions.js");

const ID = "abcdefghijklmnopabcdefghijklmnop";
const granted = new Map([[ID, new Set()]]);

const prompts = new PermissionPrompts({
  requestRender() {},
  deviceAccess: async () => true,
  extensionHasPermission: (id, permission) => granted.get(id)?.has(permission) ?? false,
});

const check = (permission, origin = `chrome-extension://${ID}`) =>
  prompts.check({ permission, origin, embedder: "https://site.example", mediaTypes: [], externalURL: null });

test("an extension frame only reads the clipboard without asking when its manifest has clipboardRead", () => {
  granted.set(ID, new Set());
  assert.equal(check("clipboard-read"), "prompt");
  assert.equal(check("clipboard-sanitized-write"), "prompt");
  granted.set(ID, new Set(["clipboardRead"]));
  assert.equal(check("clipboard-read"), true);
  assert.equal(check("clipboard-sanitized-write"), "prompt");
  granted.set(ID, new Set(["clipboardWrite"]));
  assert.equal(check("clipboard-read"), "prompt");
  assert.equal(check("clipboard-sanitized-write"), true);
});

test("uninstalled extensions and web pages get no clipboard grant", () => {
  granted.set(ID, new Set(["clipboardRead", "clipboardWrite"]));
  assert.equal(check("clipboard-read", "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba"), "prompt");
  assert.equal(check("clipboard-read", "https://evil.example"), "prompt");
  assert.equal(check("geolocation"), false);
});

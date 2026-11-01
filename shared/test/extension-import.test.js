const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-import-data-"));

const { findImports, importableItems } = require("../dist/index.js");

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function chromeProfile(root, dir, settings) {
  write(path.join(root, dir, "Secure Preferences"), { extensions: { settings } });
  write(path.join(root, dir, "Preferences"), { extensions: { settings: {} } });
}

function installed(root, dir, id, manifest) {
  write(path.join(root, dir, "Extensions", id, "1.0_0", "manifest.json"), manifest);
  return `${id}/1.0_0`;
}

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-import-home-"));
  const support = process.platform === "darwin" ? path.join(home, "Library/Application Support") : home;
  const chrome = path.join(support, process.platform === "darwin" ? "Google/Chrome" : ".config/google-chrome");
  write(path.join(chrome, "Local State"), {
    profile: { info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" } }, profiles_order: ["Default", "Profile 1"] },
  });
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  const c = "c".repeat(32);
  const d = "d".repeat(32);
  const e = "e".repeat(32);
  const f = "f".repeat(32);
  chromeProfile(chrome, "Default", {
    [a]: { location: 1, from_webstore: true, was_installed_by_default: false, disable_reasons: [], path: installed(chrome, "Default", a, { name: "__MSG_appName__", version: "1.0", default_locale: "en" }) },
    [b]: { location: 1, from_webstore: true, was_installed_by_default: false, disable_reasons: [1], path: installed(chrome, "Default", b, { name: "Turned Off", version: "1.0" }) },
    [c]: { location: 5, from_webstore: false, path: "/Applications/Chrome.app/pdf", manifest: { name: "PDF Viewer", version: "1" } },
    [d]: { location: 10, from_webstore: true, was_installed_by_default: true, path: installed(chrome, "Default", d, { name: "Payments", version: "1.0" }) },
    [e]: { location: 1, from_webstore: true, was_installed_by_default: false, disable_reasons: [], path: installed(chrome, "Default", e, { name: "A Theme", version: "1.0", theme: {} }) },
    [f]: {},
  });
  write(path.join(chrome, "Default", "Extensions", a, "1.0_0", "_locales", "en", "messages.json"), { appName: { message: "Localized Name" } });
  const unpacked = path.join(home, "code", "tool");
  write(path.join(unpacked, "manifest.json"), { name: "My Tool", version: "0.1" });
  chromeProfile(chrome, "Profile 1", { [a]: { location: 4, path: unpacked, disable_reasons: [] } });
  return home;
}

test("reads every Chrome profile and skips built-in, default, theme and broken entries", async () => {
  const found = await findImports({ home: fakeHome() });
  const chrome = found.find((browser) => browser.key === "chrome");
  assert.ok(chrome);
  assert.deepEqual(chrome.profiles.map((profile) => profile.name), ["Personal", "Work"]);
  const personal = chrome.profiles[0].items;
  assert.deepEqual(personal.map((item) => item.name).sort(), ["Localized Name", "Turned Off"]);
  assert.equal(personal.find((item) => item.name === "Turned Off").enabled, false);
  assert.equal(personal.find((item) => item.name === "Localized Name").enabled, true);
  const work = chrome.profiles[1].items;
  assert.equal(work.length, 1);
  assert.equal(work[0].status, "unavailable");
  assert.equal(work[0].reason, "unpacked");
  assert.deepEqual(importableItems(work), []);
});

test("lists only browsers with a readable Local State and profile", async () => {
  const home = fakeHome();
  const support = process.platform === "darwin" ? path.join(home, "Library/Application Support") : home;
  const arc = path.join(support, process.platform === "darwin" ? "Arc/User Data" : ".config/vivaldi");
  fs.mkdirSync(path.join(arc, "Default"), { recursive: true });
  const brave = path.join(support, process.platform === "darwin" ? "BraveSoftware/Brave-Browser" : ".config/BraveSoftware/Brave-Browser");
  write(path.join(brave, "Local State"), "{ not json");
  chromeProfile(brave, "Default", {});
  const found = await findImports({ home });
  assert.deepEqual(found.map((browser) => browser.key), ["chrome"]);
  assert.deepEqual(await findImports({ home: fs.mkdtempSync(path.join(os.tmpdir(), "tb-import-empty-")) }), []);
});

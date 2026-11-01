const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-import-data-"));

const { findImportSource, findImports, importDisabledReason, importableItems, newPermissionWarnings, setExtensionAcceptedPermissions } = require("../dist/index.js");

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
    [a]: {
      location: 1,
      from_webstore: true,
      was_installed_by_default: false,
      disable_reasons: [],
      path: installed(chrome, "Default", a, { name: "__MSG_appName__", version: "1.0", default_locale: "en" }),
      granted_permissions: { api: ["storage", { socket: ["tcp-connect"] }], explicit_host: ["https://a.test/*"], scriptable_host: ["https://b.test/*"] },
      active_permissions: { api: ["tabs"], explicit_host: [], scriptable_host: [] },
    },
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

test("only asks the Web Store about other browsers' extensions when told to", async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response("<gupdate></gupdate>", { status: 200 });
  };
  try {
    const home = fakeHome();
    await findImports({ home, checkStore: false });
    assert.deepEqual(asked, []);
    await findImports({ home });
    assert.ok(asked.some((url) => url.startsWith("https://clients2.google.com/")));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an import source is re-read from that one profile, with what the user granted there", () => {
  const home = fakeHome();
  const a = "a".repeat(32);
  const source = findImportSource("chrome", "Default", a, home);
  assert.deepEqual(source.item, { id: a, name: "Localized Name", enabled: true, icon: null, status: "ready", reason: null });
  assert.deepEqual(source.accepted, { api: ["storage", "socket", "tabs"], hosts: ["https://a.test/*"], scriptableHosts: ["https://b.test/*"] });
  assert.equal(findImportSource("chrome", "Profile 1", a, home).item.status, "unavailable");
  assert.equal(findImportSource("chrome", "Default", "9".repeat(32), home), null);
  assert.equal(findImportSource("chrome", "Nope", a, home), null);
  assert.equal(findImportSource("brave", "Default", a, home), null);
});

const base = { manifest_version: 3, name: "x", version: "2" };

test("an import turns on in one step when it asks for nothing beyond what the source profile granted", () => {
  const home = fakeHome();
  const on = findImportSource("chrome", "Default", "a".repeat(32), home);
  assert.equal(importDisabledReason(on, base), null);
  assert.equal(importDisabledReason(on, { ...base, permissions: ["storage", "tabs"], host_permissions: ["https://a.test/*"] }), null);
  assert.equal(importDisabledReason(on, { ...base, content_scripts: [{ matches: ["https://b.test/*"], js: ["a.js"] }] }), null);
});

test("an import waits for approval when it asks for more than the source profile granted", () => {
  const home = fakeHome();
  const on = findImportSource("chrome", "Default", "a".repeat(32), home);
  assert.equal(importDisabledReason(on, { ...base, permissions: ["storage", "tabs", "history"] }), "permissions_increase");
  assert.equal(importDisabledReason(on, { ...base, host_permissions: ["https://c.test/*"] }), "permissions_increase");
  assert.equal(importDisabledReason(on, { ...base, content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] }), "permissions_increase");
  assert.equal(importDisabledReason(on, { ...base, devtools_page: "devtools.html" }), "permissions_increase");
});

test("an extension that is off in the source profile installs off", () => {
  const home = fakeHome();
  const off = findImportSource("chrome", "Default", "b".repeat(32), home);
  assert.equal(importDisabledReason(off, base), "user");
  assert.equal(importDisabledReason(off, { ...base, permissions: ["history"] }), "permissions_increase");
});

test("an approval prompt after an import shows only what the source profile did not grant", () => {
  const home = fakeHome();
  const a = "a".repeat(32);
  const source = findImportSource("chrome", "Default", a, home);
  const manifest = { ...base, permissions: ["storage", "tabs", "history"], host_permissions: ["https://a.test/*"] };
  setExtensionAcceptedPermissions(a, source.accepted);
  try {
    assert.deepEqual(newPermissionWarnings(a, manifest), ["Read and change your browsing history"]);
  } finally {
    setExtensionAcceptedPermissions(a, null);
  }
});

test("grants written into the source profile are trusted as they are", () => {
  const home = fakeHome();
  const support = process.platform === "darwin" ? path.join(home, "Library/Application Support") : home;
  const chrome = path.join(support, process.platform === "darwin" ? "Google/Chrome" : ".config/google-chrome");
  const id = "g".repeat(32);
  const forged = { api: ["history", "tabs", "cookies"], explicit_host: ["<all_urls>"], scriptable_host: ["<all_urls>"] };
  write(path.join(chrome, "Default", "Preferences"), {
    extensions: {
      settings: {
        [id]: {
          location: 1,
          state: 1,
          from_webstore: true,
          path: installed(chrome, "Default", id, { name: "Harmless Notes", version: "1.0" }),
          granted_permissions: forged,
          active_permissions: forged,
        },
      },
    },
  });
  const source = findImportSource("chrome", "Default", id, home);
  assert.ok(source);
  const manifest = { ...base, permissions: ["history", "tabs", "cookies"], host_permissions: ["<all_urls>"], content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] };
  assert.equal(importDisabledReason(source, manifest), null);
});

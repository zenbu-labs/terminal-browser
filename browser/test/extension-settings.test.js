const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-settings-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-settings-config-"));
const electron = require("./fake-electron.js");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "tb-settings-user-"));
electron.app.getPath = () => userData;

const shared = require("shared");
const { SettingStore } = require("../dist/extensions/setting-store.js");
const { createSettingStore, installSettings, searchSuggestionProvider } = require("../dist/extensions/api/settings.js");
const { canCapturePage } = require("../dist/extensions/api/page-capture.js");
const { Router } = require("../dist/extensions/router.js");
const { channelFor } = require("../dist/extensions/protocol.js");

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

function store(file = null) {
  const settings = new SettingStore(file);
  settings.define("flag", { base: () => false, controllable: true });
  settings.define("fixed", { base: () => "off", controllable: false });
  return settings;
}

test("the most recently installed enabled extension controls a setting", () => {
  const settings = store();
  settings.setActive(new Map([[A, 1], [B, 2]]));
  settings.set(A, "flag", true);
  assert.equal(settings.value("flag"), true);
  assert.equal(settings.levelOfControl("flag", A), "controlled_by_this_extension");
  assert.equal(settings.levelOfControl("flag", B), "controllable_by_this_extension");
  settings.set(B, "flag", false);
  assert.equal(settings.value("flag"), false);
  assert.equal(settings.levelOfControl("flag", A), "controlled_by_other_extensions");
  assert.equal(settings.levelOfControl("flag", B), "controlled_by_this_extension");
  settings.clear(B, "flag");
  assert.equal(settings.value("flag"), true);
});

test("settings an extension can't change report not_controllable and keep their value", () => {
  const settings = store();
  settings.setActive(new Map([[A, 1]]));
  settings.set(A, "fixed", "on");
  assert.equal(settings.value("fixed"), "off");
  assert.equal(settings.levelOfControl("fixed", A), "not_controllable");
});

test("a disabled extension's values stop applying and come back when it's enabled", () => {
  const settings = store();
  const changes = [];
  settings.onChange((pref, value) => changes.push([pref, value]));
  settings.setActive(new Map([[A, 1]]));
  settings.set(A, "flag", true);
  settings.setActive(new Map());
  assert.equal(settings.value("flag"), false);
  settings.setActive(new Map([[A, 1]]));
  assert.equal(settings.value("flag"), true);
  assert.deepEqual(changes, [["flag", true], ["flag", false], ["flag", true]]);
});

test("onChange only fires when the value really changes", () => {
  const settings = store();
  const changes = [];
  settings.onChange((pref, value) => changes.push([pref, value]));
  settings.setActive(new Map([[A, 1], [B, 2]]));
  settings.set(A, "flag", true);
  settings.set(B, "flag", true);
  settings.clear(A, "flag");
  assert.deepEqual(changes, [["flag", true]]);
});

test("values persist across restarts and are dropped when forgotten", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-settings-file-")), "settings.json");
  const first = store(file);
  first.set(A, "flag", true);
  const second = store(file);
  assert.equal(second.value("flag"), false);
  second.setActive(new Map([[A, 1]]));
  assert.equal(second.value("flag"), true);
  second.forget(A);
  assert.equal(second.value("flag"), false);
  assert.equal(fs.existsSync(file), false);
});

test("font and Chrome setting defaults match Chrome on macOS", () => {
  const settings = createSettingStore(null);
  assert.equal(settings.value("webkit.webprefs.fonts.standard.Zyyy"), "Times");
  assert.equal(settings.value("webkit.webprefs.fonts.fixed.Zyyy"), "Menlo");
  assert.equal(settings.value("webkit.webprefs.fonts.standard.Arab"), "");
  assert.equal(settings.value("webkit.webprefs.default_font_size"), 16);
  assert.equal(settings.value("webkit.webprefs.default_fixed_font_size"), 13);
  assert.equal(settings.value("webkit.webprefs.minimum_font_size"), 0);
  assert.equal(settings.value("webRTCIPHandlingPolicy"), "default");
  assert.equal(settings.value("doNotTrackEnabled"), false);
  assert.equal(settings.value("animationPolicy"), "allowed");
  assert.equal(settings.levelOfControl("passwordSavingEnabled", A), "not_controllable");
});

function extension(id, installedAt, permissions) {
  return { id, name: id, record: { installedAt }, hasApiPermission: (permission) => permissions.includes(permission) };
}

function service() {
  const session = new electron.FakeSession("settings");
  session.webRequest = {
    sendHeaders: null,
    onBeforeSendHeaders(listener) {
      this.sendHeaders = listener;
    },
  };
  const loaded = new Map();
  const router = new Router(session, (id) => loaded.get(id) ?? null);
  const changeListeners = [];
  const uninstallListeners = [];
  const broadcasts = [];
  const fake = {
    session,
    router,
    loaded,
    onChange: (fn) => changeListeners.push(fn),
    onUnload: () => {},
    onUninstall: (fn) => uninstallListeners.push(fn),
    broadcast: (event, argsFor) => {
      for (const ext of loaded.values()) {
        const args = argsFor(ext);
        if (args) broadcasts.push([ext.id, event, args]);
      }
    },
    changed: () => changeListeners.forEach((fn) => fn()),
    uninstalled: (id) => uninstallListeners.forEach((fn) => fn(id)),
    broadcasts,
  };
  return fake;
}

const fake = service();
fake.router.listen();
const record = (id, at) => ({ id, path: "/x", version: "1", name: id, source: "unpacked", enabled: true, disabledReason: null, pinned: false, grantedPermissions: [], grantedOrigins: [], shortcuts: {}, installedAt: at, updatedAt: at, lastUpdateCheck: null, userScriptsAllowed: false });
for (const [id, at] of [[A, 1], [B, 2], [C, 3]]) shared.saveExtension(record(id, at));
fake.loaded.set(A, extension(A, 1, ["privacy", "fontSettings", "accessibilityFeatures.read", "accessibilityFeatures.modify"]));
fake.loaded.set(B, extension(B, 2, ["accessibilityFeatures.read"]));
fake.loaded.set(C, extension(C, 3, []));
installSettings(fake);

function call(id, method, ...args) {
  const handler = electron.invokeHandlers.get(channelFor(method));
  return Promise.resolve(handler({ sender: { session: fake.session }, senderFrame: { origin: `chrome-extension://${id}` } }, ...args));
}

test("ChromeSetting calls need the setting's own permission", async () => {
  await assert.rejects(call(C, "types.ChromeSetting.get", "doNotTrackEnabled", {}), {
    message: "You do not have permission to access the preference 'doNotTrackEnabled'. Be sure to declare in your manifest what permissions you need.",
  });
  assert.deepEqual(await call(B, "types.ChromeSetting.get", "animationPolicy", {}), { value: "allowed", levelOfControl: "controllable_by_this_extension" });
  await assert.rejects(call(B, "types.ChromeSetting.set", "animationPolicy", { value: "none" }), /permission to access the preference 'animationPolicy'/);
  await assert.rejects(call(A, "types.ChromeSetting.get", "proxy", {}), /Invalid setting/);
});

test("incognito reads and writes are refused, clearing incognito is a no-op", async () => {
  await assert.rejects(call(A, "types.ChromeSetting.get", "doNotTrackEnabled", { incognito: true }), {
    message: "You do not have permission to access incognito preferences.",
  });
  await assert.rejects(call(A, "types.ChromeSetting.set", "doNotTrackEnabled", { value: true, scope: "incognito_session_only" }), {
    message: "You do not have permission to access incognito preferences.",
  });
  assert.equal(await call(A, "types.ChromeSetting.clear", "doNotTrackEnabled", { scope: "incognito_persistent" }), undefined);
});

test("values of the wrong type and enabling Privacy Sandbox APIs are refused", async () => {
  await assert.rejects(call(A, "types.ChromeSetting.set", "doNotTrackEnabled", { value: "yes" }), /Invalid invocation/);
  await assert.rejects(call(A, "types.ChromeSetting.set", "webRTCIPHandlingPolicy", { value: "nope" }), /Invalid invocation/);
  await assert.rejects(call(A, "types.ChromeSetting.set", "topicsEnabled", { value: true }), {
    message: "Extensions aren’t allowed to enable Privacy Sandbox APIs.",
  });
  assert.equal(await call(A, "types.ChromeSetting.set", "topicsEnabled", { value: false }), undefined);
});

test("a change is announced to every extension that can read the setting", async () => {
  fake.broadcasts.length = 0;
  await call(A, "types.ChromeSetting.set", "animationPolicy", { value: "none" });
  assert.deepEqual(fake.broadcasts, [
    [A, "types.ChromeSetting.animationPolicy.onChange", [{ value: "none", levelOfControl: "controlled_by_this_extension" }]],
    [B, "types.ChromeSetting.animationPolicy.onChange", [{ value: "none", levelOfControl: "controllable_by_this_extension" }]],
  ]);
  await call(A, "types.ChromeSetting.clear", "animationPolicy", {});
});

test("fontSettings needs its permission and reports changes", async () => {
  await assert.rejects(call(B, "fontSettings.getFont", { genericFamily: "standard" }), /'fontSettings' permission is required/);
  assert.deepEqual(await call(A, "fontSettings.getFont", { genericFamily: "serif" }), { fontId: "Times", levelOfControl: "controllable_by_this_extension" });
  fake.broadcasts.length = 0;
  await call(A, "fontSettings.setFont", { genericFamily: "serif", script: "Arab", fontId: "Geeza Pro" });
  assert.deepEqual(fake.broadcasts, [
    [A, "fontSettings.onFontChanged", [{ fontId: "Geeza Pro", genericFamily: "serif", script: "Arab", levelOfControl: "controlled_by_this_extension" }]],
  ]);
  assert.deepEqual(await call(A, "fontSettings.getFont", { genericFamily: "serif", script: "Arab" }), { fontId: "Geeza Pro", levelOfControl: "controlled_by_this_extension" });
  await call(A, "fontSettings.clearFont", { genericFamily: "serif", script: "Arab" });
  await call(A, "fontSettings.setMinimumFontSize", { pixelSize: 9 });
  assert.deepEqual(await call(A, "fontSettings.getMinimumFontSize"), { pixelSize: 9, levelOfControl: "controlled_by_this_extension" });
  await call(A, "fontSettings.clearMinimumFontSize");
});

function send(details) {
  let response = null;
  fake.session.webRequest.sendHeaders?.({ resourceType: "xhr", requestHeaders: {}, ...details }, (r) => (response = r));
  return response;
}

test("request settings edit traffic only while they're changed", async () => {
  assert.equal(fake.session.webRequest.sendHeaders, null);
  await call(A, "types.ChromeSetting.set", "doNotTrackEnabled", { value: true });
  await call(A, "types.ChromeSetting.set", "referrersEnabled", { value: false });
  assert.deepEqual(send({ requestHeaders: { Referer: "https://a.test/" } }), { requestHeaders: { DNT: "1" } });
  await call(A, "types.ChromeSetting.set", "hyperlinkAuditingEnabled", { value: false });
  assert.deepEqual(send({ resourceType: "ping", requestHeaders: { "Content-Type": "text/ping" } }), { cancel: true });
  assert.notDeepEqual(send({ resourceType: "ping", requestHeaders: { "Content-Type": "text/plain" } }), { cancel: true });
  await call(A, "types.ChromeSetting.set", "networkPredictionEnabled", { value: false });
  assert.deepEqual(send({ requestHeaders: { "Sec-Purpose": "prefetch;prerender" } }), { cancel: true });
  for (const key of ["doNotTrackEnabled", "referrersEnabled", "hyperlinkAuditingEnabled", "networkPredictionEnabled"]) {
    await call(A, "types.ChromeSetting.clear", key, {});
  }
  assert.equal(fake.session.webRequest.sendHeaders, null);
});

test("an uninstalled extension's settings are dropped", async () => {
  await call(A, "types.ChromeSetting.set", "doNotTrackEnabled", { value: true });
  const file = path.join(userData, "extension-settings.json");
  assert.ok(fs.readFileSync(file, "utf8").includes(A));
  fake.loaded.delete(A);
  shared.deleteExtension(A);
  fake.changed();
  fake.uninstalled(A);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8").includes(A) : false, false);
});

test("an extension turning search suggestions off overrides the user's provider", async () => {
  fake.loaded.set(A, extension(A, 4, ["privacy"]));
  shared.saveExtension(record(A, 4));
  fake.changed();
  assert.equal(searchSuggestionProvider("https://suggest.test/?q="), "https://suggest.test/?q=");
  await call(A, "types.ChromeSetting.set", "searchSuggestEnabled", { value: false });
  assert.equal(searchSuggestionProvider("https://suggest.test/?q="), shared.SUGGESTIONS_OFF);
  await call(A, "types.ChromeSetting.clear", "searchSuggestEnabled", {});
});

test("pageCapture follows Chrome's capture rules", () => {
  const ext = { id: A, allowsFileAccess: false, hasActiveTab: (tabId) => tabId === 5 };
  assert.equal(canCapturePage(ext, 1, "https://example.com/"), true);
  assert.equal(canCapturePage(ext, 1, "https://chromewebstore.google.com/detail/x"), false);
  assert.equal(canCapturePage(ext, 5, "https://chromewebstore.google.com/detail/x"), true);
  assert.equal(canCapturePage(ext, 1, "file:///tmp/a.html"), false);
  assert.equal(canCapturePage({ ...ext, allowsFileAccess: true }, 1, "file:///tmp/a.html"), true);
  assert.equal(canCapturePage(ext, 1, `chrome-extension://${A}/page.html`), true);
  assert.equal(canCapturePage(ext, 1, `chrome-extension://${B}/page.html`), false);
  assert.equal(canCapturePage(ext, 1, "terminal-browser://history"), false);
  assert.equal(canCapturePage(ext, 5, "terminal-browser://history"), true);
});

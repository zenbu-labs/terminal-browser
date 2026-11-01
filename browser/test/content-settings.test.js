const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const electron = require("./fake-electron.js");

const records = new Map();
const answers = new Map();
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request !== "shared") return load.call(this, request, ...rest);
  return {
    getExtension: (id) => records.get(id) ?? null,
    sitePermission: (origin, embedder, kind) => answers.get(`${origin} ${embedder} ${kind}`) ?? null,
    setSitePermission() {},
  };
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "tb-content-settings-"));
electron.app.getPath = () => userData;

const { ContentSettingsStore, parsePattern, patternMatches, comparePatterns } = require("../dist/extensions/content-settings.js");
const { installContentSettings, getSetting, setSetting, clearSettings, popupBlocked } = require("../dist/extensions/api/content-settings.js");
const { Router } = require("../dist/extensions/router.js");
const { channelFor } = require("../dist/extensions/protocol.js");
const { PermissionPrompts } = require("../dist/session/permissions.js");

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

function host() {
  const unload = new Set();
  const change = new Set();
  const uninstall = new Set();
  return {
    loaded: new Map(),
    onUnload: (listener) => unload.add(listener),
    onUninstall: (listener) => uninstall.add(listener),
    onChange: (listener) => change.add(listener),
    add(id, installedAt) {
      records.set(id, { id, installedAt });
      this.loaded.set(id, { id, record: { installedAt } });
      for (const listener of change) listener();
    },
    unload(id) {
      this.loaded.delete(id);
      for (const listener of unload) listener(id);
      for (const listener of change) listener();
    },
    uninstall(id) {
      this.loaded.delete(id);
      for (const listener of unload) listener(id);
      assert.ok(fs.existsSync(settingsFile(id)), "unloading alone keeps the rules");
      records.delete(id);
      for (const listener of uninstall) listener(id);
      for (const listener of change) listener();
    },
  };
}

const pattern = (source) => {
  const parsed = parsePattern(source);
  assert.ok("pattern" in parsed, `${source}: ${parsed.error}`);
  return parsed.pattern;
};
const settingsFile = (id) => path.join(userData, "extension-content-settings", `${id}.json`);

test("patterns parse like Chrome's ParseExtensionPattern, with its errors", () => {
  const errors = {
    "localhost": "Missing scheme separator.",
    "ftp://a.com/*": "Invalid scheme.",
    "chrome-extension://abc/*": "Invalid scheme.",
    "terminal-browser://newtab/*": "Invalid scheme.",
    "HTTP://a.com/*": "Invalid scheme.",
    "http:a.com/*": "Wrong scheme type.",
    "http://": "Host can not be empty.",
    "http:///*": "Host can not be empty.",
    "http://*./*": "Host can not be empty.",
    "http://a.com": "Empty path.",
    "http://a.*.com/*": "Invalid host wildcard.",
    "http://a.com:x/*": "Invalid port.",
    "http://a.com:/*": "Invalid port.",
    "*://a.com:80/*": "Invalid port.",
    "http://[::1/*": "Invalid host.",
    "http://a.com/path": "Specific paths are not allowed.",
    "http://a.com/": "Specific paths are not allowed.",
    "file:///tmp/*": "Path wildcards in file URL patterns are not allowed.",
    "file:///": 'The pattern "*" is invalid.',
    "http://*.1.2.3.4/*": 'The pattern "*" is invalid.',
  };
  for (const [source, error] of Object.entries(errors)) assert.deepEqual(parsePattern(source), { error }, source);
  assert.deepEqual(pattern("<all_urls>"), { scheme: null, host: "", domainWildcard: true, port: null, path: null });
  assert.deepEqual(pattern("*://*/*"), pattern("<all_urls>"));
  assert.deepEqual(pattern("https://*.Example.COM:8443/*"), { scheme: "https", host: "example.com", domainWildcard: true, port: "8443", path: null });
  assert.deepEqual(pattern("file:///tmp/a b.html"), { scheme: "file", host: "", domainWildcard: false, port: null, path: "/tmp/a%20b.html" });
  assert.deepEqual(pattern("http://[::1]:8080/*").host, "[::1]");
});

test("patterns match URLs like ContentSettingsPattern::Matches", () => {
  const matches = (source, url) => patternMatches(pattern(source), url);
  assert.ok(matches("http://localhost/*", "http://localhost:4321/x"));
  assert.ok(matches("http://localhost:80/*", "http://localhost/"));
  assert.ok(!matches("http://localhost:80/*", "http://localhost:81/"));
  assert.ok(!matches("http://localhost/*", "https://localhost/"));
  assert.ok(matches("*://*.example.com/*", "https://a.b.example.com./"));
  assert.ok(matches("*://*.example.com/*", "http://example.com/"));
  assert.ok(!matches("*://*.example.com/*", "http://badexample.com/"));
  assert.ok(!matches("http://example.com/*", "http://a.example.com/"));
  assert.ok(matches("file:///tmp/a.html", "file:///tmp/a.html"));
  assert.ok(!matches("file:///tmp/a.html", "file:///tmp/b.html"));
  assert.ok(matches("<all_urls>", "file:///tmp/b.html"));
  assert.ok(!matches("<all_urls>", "not a url"));
});

test("more specific patterns win, like ContentSettingsPattern::Compare", () => {
  const order = (a, b) => Math.sign(comparePatterns(pattern(a), pattern(b)));
  assert.equal(order("http://a.example.com/*", "*://*.example.com/*"), 1);
  assert.equal(order("*://*.example.com/*", "*://*.a.example.com/*"), -1);
  assert.equal(order("http://example.com:8080/*", "http://example.com/*"), 1);
  assert.equal(order("http://example.com/*", "*://example.com/*"), 1);
  assert.equal(order("<all_urls>", "*://*/*"), 0);
  assert.equal(order("file:///a", "<all_urls>"), 1);
});

test("an extension's rules apply by precedence and clear only touches its own", () => {
  const extensions = host();
  const store = new ContentSettingsStore(extensions);
  extensions.add(A, 1);
  extensions.add(B, 2);
  const page = "https://mail.example.com/inbox";
  store.set(A, "javascript", pattern("https://mail.example.com/*"), pattern("<all_urls>"), "block");
  store.set(B, "javascript", pattern("*://*.example.com/*"), pattern("<all_urls>"), "allow");
  assert.equal(store.rule("javascript", page, page), "allow", "the extension installed last wins, even with a broader pattern");
  store.set(B, "javascript", pattern("*://*.example.com/*"), pattern("<all_urls>"), "block");
  assert.equal(store.ownRules(B, "javascript").length, 1, "the same patterns replace a rule");
  store.set(A, "javascript", pattern("*://*.example.com/*"), pattern("<all_urls>"), "block");
  store.set(A, "javascript", pattern("https://mail.example.com/*"), pattern("<all_urls>"), "allow");
  clearSettings(store, B, "javascript", {});
  assert.equal(store.rule("javascript", page, page), "allow", "within one extension the most specific pattern wins");
  assert.equal(store.rule("javascript", "https://www.example.com/", "https://www.example.com/"), "block");
  assert.equal(store.ownRules(A, "javascript").length, 2);
  assert.equal(store.rule("images", page, page), null);
  clearSettings(store, A, "images", {});
  assert.equal(store.ownRules(A, "javascript").length, 2, "clear only removes the given type");
  clearSettings(store, A, "javascript", { scope: "incognito_session_only" });
  assert.equal(store.ownRules(A, "javascript").length, 2, "there are no incognito rules to clear");
  clearSettings(store, A, "javascript", {});
  assert.equal(store.rule("javascript", page, page), null);
});

test("rules are withdrawn while an extension is unloaded, kept across restarts, deleted on uninstall", () => {
  const extensions = host();
  const store = new ContentSettingsStore(extensions);
  extensions.add(C, 5);
  const page = "http://localhost/";
  store.set(C, "images", pattern("http://localhost/*"), pattern("<all_urls>"), "block");
  assert.ok(fs.existsSync(settingsFile(C)));
  extensions.unload(C);
  assert.equal(store.rule("images", page, page), null);
  assert.ok(fs.existsSync(settingsFile(C)), "a disabled extension keeps its rules");

  const restarted = host();
  const again = new ContentSettingsStore(restarted);
  restarted.add(C, 5);
  assert.equal(again.rule("images", page, page), "block");
  restarted.uninstall(C);
  assert.equal(again.rule("images", page, page), null);
  assert.ok(!fs.existsSync(settingsFile(C)));
});

test("get answers like HostContentSettingsMap: rules, then the user's answers, then defaults", () => {
  const extensions = host();
  const store = new ContentSettingsStore(extensions);
  extensions.add(A, 1);
  const get = (type, primaryUrl, extra = {}) => getSetting(store, type, { primaryUrl, ...extra }).setting;
  assert.equal(get("javascript", "http://localhost:4321/"), "allow");
  setSetting(store, A, "javascript", { primaryPattern: "http://localhost/*", setting: "block" });
  assert.equal(get("javascript", "http://localhost:4321/"), "block");
  assert.equal(get("javascript", "terminal-browser://newtab/"), "allow");
  assert.equal(get("javascript", `chrome-extension://${A}/page.html`), "allow");
  setSetting(store, A, "javascript", { primaryPattern: "<all_urls>", setting: "block" });
  assert.equal(get("javascript", "terminal-browser://settings/"), "allow", "terminal-browser's own pages are never affected");
  assert.equal(get("notifications", "https://site.example/"), "ask");
  answers.set("https://site.example https://site.example notifications", true);
  assert.equal(get("notifications", "https://site.example/"), "allow");
  setSetting(store, A, "notifications", { primaryPattern: "https://site.example/*", setting: "block" });
  assert.equal(get("notifications", "https://site.example/"), "block");
  assert.equal(get("geolocation", "https://site.example/"), "block");
  assert.equal(get("cookies", "https://site.example/", { secondaryUrl: "https://other.example/" }), "allow");
  setSetting(store, A, "cookies", { primaryPattern: "https://site.example/*", secondaryPattern: "https://other.example/*", setting: "allow" });
  assert.equal(get("cookies", "https://site.example/", { secondaryUrl: "https://other.example/" }), "allow");
  answers.clear();
  clearSettings(store, A, "javascript", {});
  clearSettings(store, A, "notifications", {});
  clearSettings(store, A, "cookies", {});
});

test("get and set fail with Chrome's errors", () => {
  const extensions = host();
  const store = new ContentSettingsStore(extensions);
  extensions.add(A, 1);
  const set = (type, details) => () => setSetting(store, A, type, details);
  assert.throws(() => getSetting(store, "javascript", { primaryUrl: "nope" }), { message: 'The URL "nope" is invalid.' });
  assert.throws(() => getSetting(store, "javascript", { primaryUrl: "http://a/", secondaryUrl: "::" }), { message: 'The URL "::" is invalid.' });
  assert.throws(() => getSetting(store, "javascript", { primaryUrl: "http://a/", incognito: true }), {
    message: "You do not have permission to access incognito preferences.",
  });
  assert.throws(set("javascript", { primaryPattern: "http://a.com/x", setting: "block" }), { message: "Specific paths are not allowed." });
  assert.throws(set("javascript", { primaryPattern: "http://a.com/*", secondaryPattern: "nope", setting: "block" }), { message: "Missing scheme separator." });
  assert.throws(set("media-stream-camera", { primaryPattern: "<all_urls>", setting: "allow" }), { message: "'allow' is not supported as the default setting of camera." });
  assert.throws(set("microphone", { primaryPattern: "<all_urls>", setting: "allow" }), { message: "Invalid invocation" });
  assert.throws(set("media-stream-mic", { primaryPattern: "*://*/*", setting: "allow" }), { message: "'allow' is not supported as the default setting of microphone." });
  assert.doesNotThrow(set("media-stream-mic", { primaryPattern: "https://a.com/*", setting: "allow" }));
  assert.throws(set("javascript", { primaryPattern: "http://a.com/*", secondaryPattern: "http://b.com/*", setting: "block" }), {
    message: "Embedded patterns are not supported for this setting.",
  });
  assert.doesNotThrow(set("javascript", { primaryPattern: "http://a.com/*", secondaryPattern: "http://a.com/*", setting: "block" }));
  assert.throws(set("anti-abuse", { primaryPattern: "http://a.com/*", setting: "block" }), {
    message: "Site-specific settings are not allowed for this type. The URL pattern must be '<all_urls>'.",
  });
  assert.throws(set("javascript", { primaryPattern: "http://a.com/*", setting: "block", scope: "incognito_session_only" }), {
    message: "You do not have permission to access incognito preferences.",
  });
  assert.throws(set("javascript", { primaryPattern: "http://a.com/*", setting: "ask" }), { message: "Invalid invocation" });
  assert.throws(set("plugins", { primaryPattern: "http://a.com/*", setting: "block" }), { message: "Invalid invocation" });
  clearSettings(store, A, "javascript", {});
});

test("settings terminal-browser can't fully enforce are refused instead of stored", () => {
  const extensions = host();
  const store = new ContentSettingsStore(extensions);
  extensions.add(A, 1);
  const set = (type, setting) => () => setSetting(store, A, type, { primaryPattern: "https://a.com/*", setting });
  const refused = [
    ["cookies", "block", "'block' is not supported for cookies in terminal-browser."],
    ["cookies", "session_only", "'session_only' is not supported for cookies in terminal-browser."],
    ["geolocation", "allow", "'allow' is not supported for location in terminal-browser."],
    ["geolocation", "ask", "'ask' is not supported for location in terminal-browser."],
    ["automatic-downloads", "ask", "'ask' is not supported for automaticDownloads in terminal-browser."],
  ];
  for (const [type, setting, message] of refused) assert.throws(set(type, setting), { message }, `${type} ${setting}`);
  for (const type of ["cookies", "geolocation", "automatic-downloads"]) assert.deepEqual(store.ownRules(A, type), []);
  for (const [type, setting] of [["cookies", "allow"], ["geolocation", "block"], ["automatic-downloads", "allow"], ["automatic-downloads", "block"], ["sound", "block"], ["anti-abuse", "block"]]) {
    const pattern = type === "anti-abuse" ? "<all_urls>" : "https://a.com/*";
    assert.doesNotThrow(() => setSetting(store, A, type, { primaryPattern: pattern, setting }), `${type} ${setting}`);
    clearSettings(store, A, type, {});
  }
  clearSettings(store, A, "media-stream-mic", {});
});

function fakeService() {
  const session = new electron.FakeSession("content-settings");
  const hooks = [];
  session.webRequest = {
    onHeadersReceived: (listener) => hooks.push(listener),
    onBeforeSendHeaders() {},
  };
  const extensions = host();
  const loaded = new Map();
  const router = new Router(session, (id) => loaded.get(id) ?? null);
  const tabs = new Set();
  const service = {
    router,
    session,
    contentSettings: new ContentSettingsStore(extensions),
    onTabContents: (listener) => tabs.add(listener),
    tabReady: (contents, ref) => tabs.forEach((listener) => listener(contents, ref)),
  };
  installContentSettings(service);
  router.listen();
  const respond = (details) => {
    const listener = hooks.at(-1);
    if (!listener) return null;
    let result;
    listener({ responseHeaders: { "content-type": ["text/html"] }, ...details }, (value) => (result = value));
    return result.responseHeaders ?? null;
  };
  return { service, session, extensions, loaded, hooks, respond };
}

let routed = null;
function routedService() {
  routed ??= fakeService();
  return routed;
}

function frameEvent(session, id) {
  const frame = { origin: `chrome-extension://${id}`, parent: null };
  return { sender: { session, mainFrame: frame, id: 9 }, senderFrame: frame };
}

const invoke = (method, event, ...args) => electron.invokeHandlers.get(channelFor(method))(event, ...args);

test("only extensions with the contentSettings permission reach the store, as themselves", async () => {
  const { session, extensions, loaded } = routedService();
  loaded.set(A, { id: A, hasApiPermission: (name) => name === "contentSettings" });
  loaded.set(B, { id: B, hasApiPermission: () => false });
  extensions.add(A, 1);
  extensions.add(B, 2);
  await assert.rejects(
    async () => invoke("contentSettings.set", frameEvent(session, B), "javascript", { primaryPattern: "http://localhost/*", setting: "block" }),
    { message: "'contentSettings' permission is required to use chrome.contentSettings.set" },
  );
  await assert.rejects(async () => invoke("contentSettings.get", frameEvent(session, B), "javascript", { primaryUrl: "http://localhost/" }), /permission is required/);
  await assert.rejects(async () => invoke("contentSettings.get", { sender: { session }, senderFrame: { origin: "https://evil.example" } }, "javascript", { primaryUrl: "http://a/" }), /only available to extensions/);
  await invoke("contentSettings.set", frameEvent(session, A), "javascript", { primaryPattern: "http://localhost/*", setting: "block" });
  assert.deepEqual(await invoke("contentSettings.get", frameEvent(session, A), "javascript", { primaryUrl: "http://localhost:4321/" }), { setting: "block" });
  assert.equal(await invoke("contentSettings.getResourceIdentifiers", frameEvent(session, A), "cookies"), undefined);
  await assert.rejects(async () => invoke("contentSettings.get", frameEvent(session, A), "fullscreen", { primaryUrl: "http://a/" }), { message: "Invalid invocation" });
  await invoke("contentSettings.clear", frameEvent(session, A), "javascript", {});
  assert.deepEqual(await invoke("contentSettings.get", frameEvent(session, A), "javascript", { primaryUrl: "http://localhost:4321/" }), { setting: "allow" });
});

test("javascript and images rules add a blocking policy to the documents of matching pages", () => {
  const { service, extensions, hooks, respond } = routedService();
  const store = service.contentSettings;
  assert.equal(respond({ resourceType: "mainFrame", url: "http://localhost/" }), null, "no request hook until a rule exists");
  setSetting(store, A, "javascript", { primaryPattern: "http://localhost/*", setting: "block" });
  assert.equal(typeof hooks.at(-1), "function");
  const main = respond({ resourceType: "mainFrame", url: "http://localhost:4321/" });
  assert.deepEqual(main["Content-Security-Policy"], ["script-src 'none'"]);
  const withPolicy = respond({
    resourceType: "mainFrame",
    url: "http://localhost/",
    responseHeaders: { "content-security-policy": ["default-src 'self'"] },
  });
  assert.deepEqual(withPolicy["content-security-policy"], ["default-src 'self'", "script-src 'none'"]);
  const frame = (url) => ({ resourceType: "subFrame", url, frame: { top: { url: "http://localhost/" } } });
  assert.deepEqual(respond(frame("https://ads.example/frame"))["Content-Security-Policy"], ["script-src 'none'"]);
  assert.equal(respond({ resourceType: "mainFrame", url: "https://other.example/" })["Content-Security-Policy"], undefined);
  assert.equal(respond({ resourceType: "script", url: "http://localhost/app.js" })["Content-Security-Policy"], undefined);
  assert.equal(
    respond({ resourceType: "subFrame", url: "http://localhost/x", frame: { top: { url: "terminal-browser://newtab/" } } })["Content-Security-Policy"],
    undefined,
  );
  setSetting(store, B, "images", { primaryPattern: "<all_urls>", setting: "block" });
  assert.deepEqual(respond({ resourceType: "mainFrame", url: "http://localhost/" })["Content-Security-Policy"], ["script-src 'none'; img-src 'none'"]);
  extensions.unload(B);
  assert.deepEqual(respond({ resourceType: "mainFrame", url: "http://localhost/" })["Content-Security-Policy"], ["script-src 'none'"]);
  clearSettings(store, A, "javascript", {});
  assert.equal(hooks.at(-1), null, "the request hook goes once no rule needs it");
});

let nextContentsId = 100;
class FakeContents extends EventEmitter {
  constructor(session, url) {
    super();
    this.id = nextContentsId++;
    this.session = session;
    this.url = url;
    this.muted = false;
    this.reloads = 0;
  }
  isAudioMuted() {
    return this.muted;
  }
  setAudioMuted(muted) {
    this.muted = muted;
  }
  reloadIgnoringCache() {
    this.reloads++;
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return false;
  }
}

test("a popups block rule stops windows opened without a click", () => {
  const { service, session } = routedService();
  setSetting(service.contentSettings, A, "popups", { primaryPattern: "https://popups.example/*", setting: "block" });
  assert.equal(popupBlocked(service, new FakeContents(session, "https://popups.example/")), true);
  assert.equal(popupBlocked(service, new FakeContents(session, "https://elsewhere.example/")), false);
  assert.equal(popupBlocked(service, new FakeContents(new electron.FakeSession("ssh"), "https://popups.example/")), false);
  const clicked = new FakeContents(session, "https://popups.example/");
  electron.app.emit("web-contents-created", {}, clicked);
  clicked.emit("input-event", {}, { type: "mouseDown" });
  assert.equal(popupBlocked(service, clicked), false);
  clearSettings(service.contentSettings, A, "popups", {});
});

test("an automaticDownloads block rule lets a page start one download until the user loads a page", () => {
  const { service, session } = routedService();
  const page = new FakeContents(session, "https://files.example/");
  electron.app.emit("web-contents-created", {}, page);
  const download = () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    session.emit("will-download", event, {}, page);
    return !event.defaultPrevented;
  };
  assert.ok(download() && download(), "no rule, no limit");
  setSetting(service.contentSettings, A, "automatic-downloads", { primaryPattern: "https://files.example/*", setting: "block" });
  page.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, initiator: null });
  assert.equal(download(), true);
  assert.equal(download(), false);
  page.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, initiator: {} });
  assert.equal(download(), false, "a page navigating itself doesn't reset the limit");
  page.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, initiator: null });
  assert.equal(download(), true);
  clearSettings(service.contentSettings, A, "automatic-downloads", {});
});

test("permission prompts follow an extension's rule before the user's own answers", async () => {
  const extensions = host();
  const store = new ContentSettingsStore(extensions);
  extensions.add(A, 1);
  const prompted = [];
  const prompts = new PermissionPrompts({
    requestRender: () => prompted.push(true),
    deviceAccess: async () => true,
    extensionHasPermission: () => false,
    contentSetting: (check) => store.permissionRule(check),
  });
  const ask = (permission, extra = {}) => ({
    permission,
    origin: "https://cam.example",
    embedder: "https://cam.example",
    mediaTypes: [],
    externalURL: null,
    signal: new AbortController().signal,
    ...extra,
  });
  answers.set("https://cam.example https://cam.example notifications", true);
  assert.equal(prompts.check(ask("notifications")), true);
  setSetting(store, A, "notifications", { primaryPattern: "https://cam.example/*", setting: "block" });
  assert.equal(prompts.check(ask("notifications")), false);
  assert.equal(await prompts.request(1, ask("notifications")), false);
  setSetting(store, A, "notifications", { primaryPattern: "https://cam.example/*", setting: "ask" });
  assert.equal(prompts.check(ask("notifications")), "prompt");
  setSetting(store, A, "media-stream-camera", { primaryPattern: "https://cam.example/*", setting: "allow" });
  assert.equal(await prompts.request(1, ask("media", { mediaTypes: ["video"] })), true);
  assert.equal(prompts.check(ask("media", { mediaTypes: ["video", "audio"] })), "prompt", "the microphone has no rule");
  assert.equal(prompts.check(ask("media", { mediaTypes: ["video"], embedder: "https://other.example" })), "prompt");
  setSetting(store, A, "geolocation", { primaryPattern: "https://cam.example/*", setting: "block" });
  assert.equal(prompts.check(ask("geolocation")), false);
  assert.equal(prompted.length, 0);
  answers.clear();
});

test("a sound block rule mutes matching tabs and unmutes only what it muted", () => {
  const { service, session } = routedService();
  const store = service.contentSettings;
  const tab = new FakeContents(session, "https://loud.example/");
  const userMuted = new FakeContents(session, "https://loud.example/other");
  userMuted.muted = true;
  const elsewhere = new FakeContents(new electron.FakeSession("ssh"), "https://loud.example/");
  for (const contents of [tab, userMuted, elsewhere]) service.tabReady(contents, { tab: { ref: { current: null } } });
  setSetting(store, A, "sound", { primaryPattern: "https://loud.example/*", setting: "block" });
  assert.equal(tab.muted, true);
  assert.equal(elsewhere.muted, false, "other sessions' tabs are untouched");
  tab.url = "https://quiet.example/";
  tab.emit("did-navigate");
  assert.equal(tab.muted, false);
  tab.url = "https://loud.example/again";
  tab.emit("did-navigate");
  assert.equal(tab.muted, true);
  clearSettings(store, A, "sound", {});
  assert.equal(tab.muted, false);
  assert.equal(userMuted.muted, true, "a tab the user muted stays muted");
});

test("a blocked page whose document skipped the policy header is reloaded past the service worker once", async () => {
  const { service, session, respond } = routedService();
  const store = service.contentSettings;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  setSetting(store, A, "javascript", { primaryPattern: "https://sw.example/*", setting: "block" });
  const page = new FakeContents(session, "https://sw.example/");
  electron.app.emit("web-contents-created", {}, page);
  respond({ resourceType: "mainFrame", url: "https://sw.example/", webContentsId: page.id });
  page.emit("did-frame-navigate", {}, "https://sw.example/#top", 200, "OK", true);
  await settle();
  assert.equal(page.reloads, 0, "a document that got the header is left alone");
  page.emit("did-frame-navigate", {}, "https://sw.example/", 200, "OK", true);
  await settle();
  assert.equal(page.reloads, 1);
  page.emit("did-frame-navigate", {}, "https://sw.example/", 200, "OK", true);
  await settle();
  assert.equal(page.reloads, 1, "never reloads in a loop");
  page.emit("did-frame-navigate", {}, "https://free.example/", 200, "OK", true);
  page.emit("did-frame-navigate", {}, "about:blank", 200, "OK", false);
  await settle();
  assert.equal(page.reloads, 1);
  clearSettings(store, A, "javascript", {});
});

test("service workers of blocked sites are unregistered when a rule appears or one registers", async () => {
  const { service, session } = routedService();
  const store = service.contentSettings;
  const commands = [];
  const tab = new FakeContents(session, "https://any.example/");
  tab.debugger = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    async sendCommand(method, params) {
      commands.push(params ? [method, params.scopeURL] : [method]);
      if (method === "ServiceWorker.enable") {
        setImmediate(() =>
          tab.debugger.emit("message", {}, "ServiceWorker.workerRegistrationUpdated", {
            registrations: [
              { scopeURL: "https://sw.example/", isDeleted: false },
              { scopeURL: "https://sw.example/gone/", isDeleted: true },
              { scopeURL: "https://free.example/", isDeleted: false },
            ],
          }),
        );
      }
      return {};
    },
  });
  const all = electron.webContents.getAllWebContents;
  electron.webContents.getAllWebContents = () => [tab];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  try {
    setSetting(store, A, "javascript", { primaryPattern: "https://sw.example/*", setting: "block" });
    await settle();
    assert.deepEqual(commands, [["ServiceWorker.enable"], ["ServiceWorker.unregister", "https://sw.example/"], ["ServiceWorker.disable"]]);
    commands.length = 0;
    session.serviceWorkers.emit("registration-completed", {}, { scope: "https://sw.example/" });
    await settle();
    assert.deepEqual(commands.map(([method]) => method), ["ServiceWorker.enable", "ServiceWorker.unregister", "ServiceWorker.disable"]);
    commands.length = 0;
    clearSettings(store, A, "javascript", {});
    await settle();
    assert.deepEqual(commands, [], "nothing to sweep without rules");
  } finally {
    electron.webContents.getAllWebContents = all;
  }
});

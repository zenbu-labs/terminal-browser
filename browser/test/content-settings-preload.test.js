const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { contextBridge: {}, ipcRenderer: {} };
  return load.call(this, request, ...rest);
};

const { installChromeApis } = require("../dist/extensions/preload.js");
const { API_SPEC } = require("../dist/extensions/protocol.js");
const { API_SCHEMAS } = require("../dist/extensions/api-schemas.js");

const ID = "abcdefghijklmnopabcdefghijklmnop";
const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });

function context(granted) {
  const invoked = [];
  const chrome = {
    runtime: {
      id: ID,
      getManifest: () => ({ manifest_version: 3, name: "x", version: "1", permissions: granted }),
      onMessage: event(),
      onMessageExternal: event(),
      onConnect: event(),
      onConnectExternal: event(),
    },
  };
  globalThis.chrome = chrome;
  globalThis.location = { protocol: "chrome-extension:", href: `chrome-extension://${ID}/sw.js`, origin: `chrome-extension://${ID}` };
  const bridge = {
    invoke: (method, args) => {
      invoked.push([method, args]);
      return Promise.resolve(method === "runtime.watchSenderTabs" ? { tabs: [] } : method === "contentSettings.get" ? { setting: "allow" } : undefined);
    },
    listen() {},
    unlisten() {},
    onEvent() {},
    ready() {},
    viewInfo: () => null,
    startup: () => ({ permissions: granted }),
  };
  installChromeApis(bridge, true, API_SPEC, API_SCHEMAS);
  return { chrome, calls: () => invoked.filter(([method]) => method.startsWith("contentSettings.")) };
}

const TYPES = [
  "automaticDownloads", "autoVerify", "camera", "clipboard", "cookies", "fullscreen", "images", "javascript",
  "location", "microphone", "mouselock", "notifications", "plugins", "popups", "sound", "unsandboxedPlugins",
];

test("chrome.contentSettings only exists with the permission and has exactly Chrome's members", () => {
  assert.equal(context([]).chrome.contentSettings, undefined);
  const { chrome } = context(["contentSettings"]);
  const settings = chrome.contentSettings;
  const objects = Object.keys(settings).filter((key) => /^[a-z]/.test(key)).sort();
  assert.deepEqual(objects, [...TYPES].sort());
  for (const type of TYPES) assert.deepEqual(Object.keys(settings[type]).sort(), ["clear", "get", "getResourceIdentifiers", "set"]);
  const enums = Object.keys(settings).filter((key) => /^[A-Z]/.test(key)).sort();
  assert.deepEqual(enums, [
    "AutoVerifyContentSetting", "CameraContentSetting", "ClipboardContentSetting", "CookiesContentSetting",
    "FullscreenContentSetting", "ImagesContentSetting", "JavascriptContentSetting", "LocationContentSetting",
    "MicrophoneContentSetting", "MouselockContentSetting", "MultipleAutomaticDownloadsContentSetting",
    "NotificationsContentSetting", "PluginsContentSetting", "PopupsContentSetting", "PpapiBrokerContentSetting",
    "Scope", "SoundContentSetting",
  ]);
  assert.deepEqual(settings.CookiesContentSetting, { ALLOW: "allow", BLOCK: "block", SESSION_ONLY: "session_only" });
  assert.deepEqual(settings.Scope, { REGULAR: "regular", INCOGNITO_SESSION_ONLY: "incognito_session_only" });
});

test("calls send Chrome's internal type name and are checked like Chrome's ContentSetting", async () => {
  const { chrome, calls } = context(["contentSettings"]);
  const settings = chrome.contentSettings;
  assert.deepEqual(await settings.location.get({ primaryUrl: "https://a.example/" }), { setting: "allow" });
  await settings.camera.set({ primaryPattern: "https://a.example/*", setting: "ask" });
  await settings.automaticDownloads.clear({});
  assert.deepEqual(calls(), [
    ["contentSettings.get", ["geolocation", { primaryUrl: "https://a.example/" }]],
    ["contentSettings.set", ["media-stream-camera", { primaryPattern: "https://a.example/*", setting: "ask" }]],
    ["contentSettings.clear", ["automatic-downloads", {}]],
  ]);
  assert.throws(() => settings.javascript.get({}), {
    name: "TypeError",
    message:
      "Error in invocation of contentSettings.ContentSetting.get(object details, optional function callback): Error at parameter 'details': Missing required property 'primaryUrl'.",
  });
  assert.throws(() => settings.javascript.set({ primaryPattern: "<all_urls>", setting: "ask" }), {
    name: "TypeError",
    message: "Invalid invocation: Error at property 'setting': Value must be one of allow, block.",
  });
  assert.throws(() => settings.images.set({ primaryPattern: "<all_urls>", setting: 1 }), {
    message: "Invalid invocation: Error at property 'setting': Invalid type: expected contentSettings.ImagesContentSetting, found integer.",
  });
  assert.equal(calls().length, 3);
});

test("deprecated types answer at once without asking the browser, like Chrome", () => {
  const { chrome, calls } = context(["contentSettings"]);
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const got = [];
    assert.equal(chrome.contentSettings.plugins.get({ primaryUrl: "https://a.example/" }, (value) => got.push(value)), undefined);
    assert.equal(chrome.contentSettings.fullscreen.get({ primaryUrl: "https://a.example/" }), undefined);
    chrome.contentSettings.mouselock.get({ primaryUrl: "https://a.example/" }, (value) => got.push(value));
    chrome.contentSettings.unsandboxedPlugins.set({ primaryPattern: "<all_urls>", setting: "allow" }, (...args) => got.push(args));
    assert.deepEqual(got, [{ setting: "block" }, { setting: "allow" }, []]);
    assert.deepEqual(warnings, [
      "contentSettings.plugins is deprecated.",
      "contentSettings.fullscreen is deprecated.",
      "contentSettings.mouselock is deprecated.",
      "contentSettings.ppapi-broker is deprecated.",
    ]);
  } finally {
    console.warn = warn;
  }
  assert.equal(calls().length, 0);
});

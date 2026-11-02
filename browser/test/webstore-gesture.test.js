const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-webstore-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-webstore-config-"));
const electron = require("./fake-electron.js");

const shared = require("shared");
const { Router } = require("../dist/extensions/router.js");
const { WebStore, WEBSTORE_ORIGIN } = require("../dist/extensions/webstore.js");

const ID = "e".repeat(32);
const OTHER = "f".repeat(32);

const store = Object.assign(new EventEmitter(), { id: 7 });
const frame = { parent: null, origin: WEBSTORE_ORIGIN };
store.mainFrame = frame;

function setup() {
  const prompts = [];
  const installs = [];
  const window = { host: { prompt: async (request) => (prompts.push(request.kind), true) } };
  const session = new electron.FakeSession("extensions");
  store.session = session;
  const service = {
    session,
    loadErrors: new Map(),
    get: () => null,
    onChange() {},
    tabRef: (id) => (id === store.id ? { window, tab: {} } : null),
    installer: {
      prepareFromStore: async (id) => (installs.push(id), { id }),
      installFromStore: async (id) => (installs.push(id), true),
      commit: async () => {},
      isInstalling: () => false,
      acceptNewPermissions: async () => {},
    },
    manager: {
      summary: () => ({ name: "x", warnings: [], hosts: [], permissions: [] }),
      setEnabled: async () => {},
      remove: async () => {},
      managementInfo: () => ({}),
    },
  };
  new WebStore(service);
  return { prompts, installs };
}

const call = (method, ...args) =>
  electron.invokeHandlers.get(`tb-webstore:${method}`)({ sender: store, senderFrame: frame }, ...args);

test("the Web Store only installs and uninstalls right after the user clicked or typed in it", async () => {
  new Router({}, () => null).listen();
  electron.app.emit("web-contents-created", {}, store);
  shared.saveExtension({ id: OTHER, path: "/x", version: "1", name: "x", source: "webstore", enabled: true, disabledReason: null, pinned: false, grantedPermissions: [], grantedOrigins: [], shortcuts: {}, installedAt: 1, updatedAt: 1, lastUpdateCheck: null, userScriptsAllowed: false });
  const { prompts, installs } = setup();

  assert.deepEqual(await call("begin-install", { id: ID }), {
    result: "user_gesture_required",
    error: "This function must be called during a user gesture",
  });
  await assert.rejects(call("install", ID), /This function must be called during a user gesture/);
  await assert.rejects(call("management-uninstall", OTHER), /chrome.management.uninstall requires a user gesture./);
  assert.deepEqual(installs, []);
  assert.deepEqual(prompts, []);

  store.emit("input-event", {}, { type: "mouseDown" });
  assert.deepEqual(await call("begin-install", { id: ID }), { result: "" });
  await call("management-uninstall", OTHER);
  assert.deepEqual(installs, [ID]);
  assert.deepEqual(prompts, ["remove"]);
});

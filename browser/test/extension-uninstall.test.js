const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-uninstall-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-uninstall-config-"));
const electron = require("./fake-electron.js");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "tb-uninstall-user-"));
electron.app.getPath = () => userData;

const shared = require("shared");
const { ExtensionManager } = require("../dist/extensions/manage.js");
const { DeclarativeContentStore } = require("../dist/extensions/api/declarative-content.js");

const ID = "d".repeat(32);

function fakeService() {
  const unload = [];
  const uninstall = [];
  const seen = [];
  return {
    seen,
    errors: new Map(),
    loadErrors: new Map(),
    session: { clearStorageData: async () => {} },
    actions: { clearDeclarative() {} },
    onUnload: (fn) => unload.push(fn),
    onUninstall: (fn) => uninstall.push(fn),
    onActivate() {},
    async unload(id) {
      seen.push(["unload", id, shared.getExtension(id) !== null]);
      unload.forEach((fn) => fn(id));
    },
    uninstalled(id) {
      seen.push(["uninstalled", id, shared.getExtension(id) !== null]);
      uninstall.forEach((fn) => fn(id));
    },
    broadcast() {},
    lastFocusedWindow: () => null,
    changed() {},
  };
}

test("removing an extension announces the uninstall after its record is gone, and its content rules go with it", async () => {
  shared.saveExtension({ id: ID, path: "/x", version: "1", name: "x", source: "unpacked", enabled: true, disabledReason: null, pinned: false, grantedPermissions: [], grantedOrigins: [], shortcuts: {}, installedAt: 1, updatedAt: 1, lastUpdateCheck: null, userScriptsAllowed: false });
  const service = fakeService();
  new DeclarativeContentStore(service);
  const rules = path.join(userData, "extension-content-rules", `${ID}.json`);
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(rules, "[]");

  await service.unload(ID);
  assert.ok(fs.existsSync(rules), "disabling keeps the rules");

  await new ExtensionManager(service).remove(ID);
  assert.deepEqual(service.seen.slice(1), [
    ["unload", ID, true],
    ["uninstalled", ID, false],
  ]);
  assert.equal(fs.existsSync(rules), false);
});

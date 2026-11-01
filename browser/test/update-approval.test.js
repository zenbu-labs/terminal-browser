const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-update-approval-data-"));
require("./fake-electron");
const { getExtension, readCrxFile, saveExtension, updateExtension } = require("shared");
const { Installer } = require("../dist/extensions/install.js");

const CRX = path.join(__dirname, "../../shared/test/fixtures/json-formatter.crx");
const STORE_PACKAGE = "https://clients2.googleusercontent.com/crx/blobs/json-formatter.crx";

// The installed version only had storage; the store's next version also runs
// content scripts on every site, so it waits for the user's approval.
function installOlderVersion(pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-update-approval-ext-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: pkg.name, version: "0.10.1", permissions: ["storage"] }));
  const now = Date.now();
  saveExtension({
    id: pkg.id,
    path: dir,
    version: "0.10.1",
    name: pkg.name,
    source: "webstore",
    enabled: true,
    disabledReason: null,
    pinned: true,
    grantedPermissions: [],
    grantedOrigins: [],
    shortcuts: {},
    installedAt: now,
    updatedAt: now,
    lastUpdateCheck: null,
    userScriptsAllowed: false,
  });
}

function serveStore(pkg) {
  const bytes = fs.readFileSync(CRX);
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("response=updatecheck")) {
      return new Response(`<gupdate><app appid="${pkg.id}"><updatecheck status="ok" codebase="${STORE_PACKAGE}" version="${pkg.version}"/></app></gupdate>`);
    }
    if (href === STORE_PACKAGE) return new Response(bytes);
    throw new Error(`unexpected fetch ${href}`);
  };
}

function service(window) {
  return {
    lastFocusedWindow: () => window,
    load: async () => null,
    unload: async () => {},
    changed: () => {},
    manager: {
      setEnabled: async (id, enabled) => {
        updateExtension(id, { enabled, disabledReason: enabled ? null : "user" });
      },
    },
  };
}

test("an update that asks for more turns the extension off without a prompt, and only the user's click asks", async () => {
  const pkg = readCrxFile(CRX);
  installOlderVersion(pkg);
  serveStore(pkg);
  const prompts = [];
  const window = {
    host: {
      prompt: async (request) => {
        prompts.push(request);
        return true;
      },
    },
  };
  const installer = new Installer(service(window));

  const results = await installer.update();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(results.map((result) => result.status), ["needs_permission"]);
  assert.equal(prompts.length, 0);
  assert.equal(getExtension(pkg.id).enabled, false);
  assert.equal(getExtension(pkg.id).disabledReason, "permissions_increase");
  assert.deepEqual(installer.awaitingApproval().map((entry) => entry.id), [pkg.id]);

  assert.equal(await installer.approveNewPermissions(pkg.id, window), true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].kind, "update");
  assert.deepEqual(prompts[0].warnings, ["Read and change all your data on all websites"]);
  assert.equal(getExtension(pkg.id).enabled, true);
  assert.deepEqual(installer.awaitingApproval(), []);
});

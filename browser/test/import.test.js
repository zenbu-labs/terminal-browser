const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-browser-import-"));
const realShared = require("shared");

class CrxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ID = "a".repeat(32);
const store = { installed: new Set(), downloads: [], packages: new Map(), sources: new Map() };
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request !== "shared") return load.call(this, request, ...rest);
  return {
    CrxError,
    isExtensionId: (id) => /^[a-p]{32}$/.test(id),
    getExtension: (id) => (store.installed.has(id) ? { id } : null),
    findImports: async () => [],
    findImportSource: (browser, profile, id) => store.sources.get(`${browser}/${profile}/${id}`) ?? null,
    importDisabledReason: realShared.importDisabledReason,
    fetchStorePackage: async (id) => {
      store.downloads.push(id);
      const pkg = store.packages.get(id);
      if (pkg instanceof Error) throw pkg;
      return pkg;
    },
  };
};

const { Importer } = require("../dist/extensions/import.js");

function importer() {
  store.installed.clear();
  store.downloads = [];
  store.packages.clear();
  store.sources.clear();
  const installs = [];
  const service = {
    installer: {
      installPrepared: async (pkg, disabledReason) => {
        installs.push({ id: pkg.id, disabledReason });
        return { id: pkg.id, name: pkg.name, version: pkg.version };
      },
    },
  };
  return { importer: new Importer(service), installs };
}

const STORAGE = { manifest_version: 3, name: "Dark Reader", version: "4.9", permissions: ["storage"], content_scripts: [{ matches: ["https://a.test/*"], js: ["a.js"] }] };

function source(id, { enabled = true, status = "ready", accepted = { api: ["storage"], hosts: [], scriptableHosts: ["https://a.test/*"] } } = {}) {
  store.sources.set(`chrome/Default/${id}`, { item: { id, name: "Dark Reader", enabled, icon: null, status, reason: null }, accepted });
}

function pkg(manifest = STORAGE) {
  return { id: ID, name: manifest.name, version: manifest.version, manifest };
}

test("installs a verified Web Store package in one step, on or off as in the source profile", async () => {
  const { importer: subject, installs } = importer();
  store.packages.set(ID, pkg());
  source(ID, { enabled: false });
  assert.deepEqual(await subject.install("chrome", "Default", ID), { id: ID, name: "Dark Reader", version: "4.9", enabled: false, needsApproval: false });
  assert.deepEqual(store.downloads, [ID]);
  assert.deepEqual(installs, [{ id: ID, disabledReason: "user" }]);
  assert.equal(subject.justImported(ID), true);

  store.installed.clear();
  source(ID);
  assert.equal((await subject.install("chrome", "Default", ID)).enabled, true);
  assert.deepEqual(installs[1], { id: ID, disabledReason: null });
});

test("only ids the chosen profile really has are installed, whatever the page sends", async () => {
  const { importer: subject, installs } = importer();
  store.packages.set(ID, pkg());
  source(ID);
  await assert.rejects(subject.install("chrome", "Profile 1", ID), { message: "Not in this profile" });
  await assert.rejects(subject.install("brave", "Default", ID), { message: "Not in this profile" });
  const other = "b".repeat(32);
  store.packages.set(other, { ...pkg(), id: other });
  await assert.rejects(subject.install("chrome", "Default", other), { message: "Not in this profile" });
  source(other, { status: "unavailable" });
  await assert.rejects(subject.install("chrome", "Default", other), { message: "Not in this profile" });
  assert.deepEqual(store.downloads, []);
  assert.deepEqual(installs, []);
});

test("a store version that asks for more than the source profile accepted waits for approval", async () => {
  const { importer: subject, installs } = importer();
  source(ID);
  store.packages.set(ID, pkg({ ...STORAGE, content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] }));
  assert.deepEqual(await subject.install("chrome", "Default", ID), { id: ID, name: "Dark Reader", version: "4.9", enabled: false, needsApproval: true });
  assert.deepEqual(installs, [{ id: ID, disabledReason: "permissions_increase" }]);

  store.installed.clear();
  source(ID, { enabled: false });
  store.packages.set(ID, pkg({ ...STORAGE, permissions: ["storage", "history"] }));
  assert.deepEqual(await subject.install("chrome", "Default", ID), { id: ID, name: "Dark Reader", version: "4.9", enabled: false, needsApproval: false });
  assert.deepEqual(installs[1], { id: ID, disabledReason: "permissions_increase" });
});

test("a package that fails verification is not installed", async () => {
  const { importer: subject, installs } = importer();
  source(ID);
  store.packages.set(ID, new CrxError("bad_signature", "CRX signature is invalid"));
  await assert.rejects(subject.install("chrome", "Default", ID), { message: "Signature check failed" });
  assert.deepEqual(installs, []);
  assert.equal(subject.justImported(ID), false);
});

test("reports missing store items and already installed extensions without installing", async () => {
  const { importer: subject, installs } = importer();
  source(ID);
  store.packages.set(ID, new CrxError("not_found", "gone"));
  await assert.rejects(subject.install("chrome", "Default", ID), { message: "Not on the Chrome Web Store" });
  store.installed.add(ID);
  await assert.rejects(subject.install("chrome", "Default", ID), { message: "Already installed" });
  assert.deepEqual(store.downloads, [ID]);
  assert.deepEqual(installs, []);
  await assert.rejects(subject.install("chrome", "Default", "not-an-id"), { message: "not-an-id is not an extension id" });
});

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
const store = { installed: new Set(), downloads: [], packages: new Map(), sources: new Map(), accepted: new Map() };
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
    setExtensionAcceptedPermissions: (id, accepted) => (accepted === null ? store.accepted.delete(id) : store.accepted.set(id, accepted)),
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
  store.accepted.clear();
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

const STORAGE = { manifest_version: 3, name: "Dark Reader", version: "4.9", permissions: ["storage"] };
const WARNS = { ...STORAGE, permissions: ["storage", "history"], content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] };

const GRANTED = { api: ["storage"], hosts: [], scriptableHosts: [] };

function source(id, { enabled = true, status = "ready", accepted = GRANTED } = {}) {
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

test("an extension the source profile granted everything it asks for installs on in one step", async () => {
  const { importer: subject, installs } = importer();
  source(ID, { accepted: { api: ["storage", "history"], hosts: [], scriptableHosts: ["<all_urls>"] } });
  store.accepted.set(ID, { api: [], hosts: [], scriptableHosts: [] });
  store.packages.set(ID, pkg(WARNS));
  assert.deepEqual(await subject.install("chrome", "Default", ID), { id: ID, name: "Dark Reader", version: "4.9", enabled: true, needsApproval: false });
  assert.deepEqual(installs, [{ id: ID, disabledReason: null }]);
  assert.equal(store.accepted.has(ID), false);
});

test("a store version that asks for more than the source profile granted waits for approval of just the new part", async () => {
  const { importer: subject, installs } = importer();
  source(ID);
  store.packages.set(ID, pkg(WARNS));
  assert.deepEqual(await subject.install("chrome", "Default", ID), { id: ID, name: "Dark Reader", version: "4.9", enabled: false, needsApproval: true });
  assert.deepEqual(installs, [{ id: ID, disabledReason: "permissions_increase" }]);
  assert.deepEqual(store.accepted.get(ID), GRANTED);

  store.installed.clear();
  source(ID, { enabled: false });
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

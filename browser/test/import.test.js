const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

class CrxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ID = "a".repeat(32);
const store = { installed: new Set(), downloads: [], packages: new Map() };
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request !== "shared") return load.call(this, request, ...rest);
  return {
    CrxError,
    isExtensionId: (id) => /^[a-p]{32}$/.test(id),
    getExtension: (id) => (store.installed.has(id) ? { id } : null),
    findImports: async () => [],
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
  const installs = [];
  const service = {
    installer: {
      installPrepared: async (pkg, enabled) => {
        installs.push({ id: pkg.id, enabled });
        return { id: pkg.id, name: pkg.name, version: pkg.version };
      },
    },
  };
  return { importer: new Importer(service), installs };
}

test("installs a verified Web Store package in one step, keeping it off when asked", async () => {
  const { importer: subject, installs } = importer();
  store.packages.set(ID, { id: ID, name: "Dark Reader", version: "4.9" });
  assert.deepEqual(await subject.install(ID, false), { id: ID, name: "Dark Reader", version: "4.9" });
  assert.deepEqual(store.downloads, [ID]);
  assert.deepEqual(installs, [{ id: ID, enabled: false }]);
  assert.equal(subject.justImported(ID), true);
});

test("a package that fails verification is not installed", async () => {
  const { importer: subject, installs } = importer();
  store.packages.set(ID, new CrxError("bad_signature", "CRX signature is invalid"));
  await assert.rejects(subject.install(ID, true), { message: "Signature check failed" });
  assert.deepEqual(installs, []);
  assert.equal(subject.justImported(ID), false);
});

test("reports missing store items and already installed extensions without installing", async () => {
  const { importer: subject, installs } = importer();
  store.packages.set(ID, new CrxError("not_found", "gone"));
  await assert.rejects(subject.install(ID, true), { message: "Not on the Chrome Web Store" });
  store.installed.add(ID);
  await assert.rejects(subject.install(ID, true), { message: "Already installed" });
  assert.deepEqual(store.downloads, [ID]);
  assert.deepEqual(installs, []);
  await assert.rejects(subject.install("not-an-id", true), { message: "not-an-id is not an extension id" });
});

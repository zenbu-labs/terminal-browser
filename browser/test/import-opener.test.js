const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-import-opener-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-import-opener-config-"));
const electron = require("./fake-electron.js");

let lookups = 0;
const service = { manager: {}, importer: { find: async (checkStore = true) => (checkStore && lookups++, []) } };
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "../extensions/service" && parent?.filename?.endsWith(path.join("pages", "extensions-api.js"))) {
    return { extensionService: () => service };
  }
  return load.call(this, request, parent, ...rest);
};

const { extensionsHandlers } = require("../dist/pages/extensions-api.js");
const { guardInternalNavigation } = require("../dist/pages/navigation.js");
const { expectExtensionNavigation } = require("../dist/pages/opened-by.js");

const IMPORT = "terminal-browser://extensions/import";
guardInternalNavigation();
const handlers = extensionsHandlers();

function page(url, { byExtension = false } = {}) {
  const contents = new EventEmitter();
  electron.app.emit("web-contents-created", {}, contents);
  if (byExtension) expectExtensionNavigation(url);
  contents.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
  return contents;
}

const settled = (promise) => Promise.race([promise.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))]);

test("the import page the browser opened looks extensions up on the Web Store right away", async () => {
  lookups = 0;
  await handlers.importFind(page(IMPORT));
  assert.equal(lookups, 1);
});

test("the import page an extension opened waits for the user before looking anything up", async () => {
  lookups = 0;
  const contents = page(IMPORT, { byExtension: true });
  const found = handlers.importFind(contents);
  contents.emit("input-event", {}, { type: "mouseMove" });
  assert.equal(await settled(found), "waiting");
  assert.equal(lookups, 0);
  contents.emit("input-event", {}, { type: "mouseDown" });
  assert.equal(await settled(found), "done");
  assert.equal(lookups, 1);
});

test("an extension's announcement only covers the navigation it announced", async () => {
  lookups = 0;
  expectExtensionNavigation(IMPORT);
  const contents = page("terminal-browser://extensions/");
  contents.emit("did-start-navigation", { url: IMPORT, isMainFrame: true, isSameDocument: false });
  assert.equal(await settled(handlers.importFind(contents)), "waiting");
  const later = page(IMPORT);
  await handlers.importFind(later);
  assert.equal(lookups, 1);
});

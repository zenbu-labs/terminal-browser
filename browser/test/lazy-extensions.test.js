const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-lazy-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-lazy-config-"));
const electron = require("./fake-electron.js");
const { startBrowsing } = require("../dist/browsing/index.js");
const { startExtensions } = require("../dist/extensions/index.js");

// The settings watchers started by startBrowsing keep the process alive.
test.after(() => setImmediate(() => process.exit(0)));
startBrowsing();

const session = electron.session.defaultSession;
const extensionPreloads = () => session.preloads.filter((script) => script.filePath.endsWith("extension-preload.js"));
const extensionChannels = () => [...electron.invokeHandlers.keys()].filter((channel) => channel.startsWith("tb-ext:"));

test("with no extension installed nothing extension-specific is registered", async () => {
  const service = startExtensions();
  await service.whenReady();
  assert.deepEqual(extensionPreloads(), []);
  assert.deepEqual(extensionChannels(), []);
  assert.equal(electron.ipcMain.listenerCount("tb-ext:listen"), 0);
  assert.equal(session.serviceWorkers.listenerCount("running-status-changed"), 0);
  assert.ok(session.preloads.some((script) => script.filePath.endsWith("chrome-web-store-preload.js")));
  assert.ok([...electron.invokeHandlers.keys()].some((channel) => channel.startsWith("tb-webstore:")));

  service.activate();
  assert.deepEqual(extensionPreloads().map((script) => script.type).sort(), ["frame", "service-worker"]);
  assert.ok(extensionChannels().length > 100);
  assert.ok(session.serviceWorkers.listenerCount("running-status-changed") > 0);

  const channels = extensionChannels().length;
  service.activate();
  assert.equal(extensionChannels().length, channels);
  assert.equal(extensionPreloads().length, 2);
});

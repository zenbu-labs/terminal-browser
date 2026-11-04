const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-commands-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-commands-config-"));
const electron = require("./fake-electron.js");
electron.app.getPath = () => fs.mkdtempSync(path.join(os.tmpdir(), "tb-commands-user-"));

const shared = require("shared");
const { commandsFor } = require("../dist/extensions/commands.js");
const { ExtensionManager } = require("../dist/extensions/manage.js");

const manifest = { commands: { "toggle-feature": { description: "Toggle" } } };
const record = (shortcut) => ({ shortcuts: { "toggle-feature": shortcut } });
const shortcutOn = (platform, recorded) => commandsFor(manifest, record(recorded), platform)[0].shortcut;

// The shortcuts page records what Chrome's does: on a Mac, Command is "Command" and Control is "MacCtrl".
test("shortcuts recorded on the shortcuts page keep their keys", () => {
  assert.equal(shortcutOn("darwin", "MacCtrl+Shift+Y"), "ctrl+shift+y");
  assert.equal(shortcutOn("darwin", "Command+Shift+Y"), "cmd+shift+y");
  assert.equal(shortcutOn("darwin", "Alt+Shift+Y"), "alt+shift+y");
  assert.equal(shortcutOn("darwin", "MacCtrl+Comma"), "ctrl+,");
  assert.equal(shortcutOn("linux", "Ctrl+Shift+Y"), "ctrl+shift+y");
  assert.equal(shortcutOn("darwin", ""), "");
});

test("the shortcuts page can't save a shortcut Chrome wouldn't accept", () => {
  const id = "e".repeat(32);
  shared.saveExtension({
    id, path: "/x", version: "1", name: "X", source: "unpacked", enabled: true, disabledReason: null, pinned: false,
    grantedPermissions: [], grantedOrigins: [], shortcuts: {}, installedAt: 0, updatedAt: 0, lastUpdateCheck: null, userScriptsAllowed: false,
  });
  const manager = new ExtensionManager({ get: () => null, changed() {} });
  assert.throws(() => manager.setShortcut(id, "toggle-feature", "Shift+Y"), /Invalid shortcut/);
  assert.throws(() => manager.setShortcut(id, "toggle-feature", "Hyper+Y"), /Invalid shortcut/);
  manager.setShortcut(id, "toggle-feature", process.platform === "darwin" ? "MacCtrl+Shift+Y" : "Ctrl+Shift+Y");
  manager.setShortcut(id, "toggle-feature", "");
  assert.equal(shared.getExtension(id).shortcuts["toggle-feature"], "");
});

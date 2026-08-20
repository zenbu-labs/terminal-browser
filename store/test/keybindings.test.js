const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  keybindingConflicts,
  keybindingSetting,
  listKeybindings,
  normalizeKeybinding,
  resetKeybinding,
  setKeybinding,
} = require("../dist/keybindings");

test("validates, stores, and resets global keybindings", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "terminal-browser-keybindings-test-"),
  );
  const file = path.join(directory, "keybindings.json");
  try {
    assert.ok(
      listKeybindings(file).some((setting) => setting.id === "close-tab"),
    );
    assert.equal(
      normalizeKeybinding("Shift+Ctrl+T ctrl+t"),
      "ctrl+shift+t ctrl+t",
    );
    assert.equal(setKeybinding("close-tab", "Alt+W", file).binding, "alt+w");
    assert.equal(keybindingSetting("close-tab", file).overridden, true);
    resetKeybinding("close-tab", file);
    assert.equal(keybindingSetting("close-tab", file).overridden, false);
    setKeybinding("record", "none", file);
    assert.equal(keybindingSetting("record", file).binding, "none");
    resetKeybinding(null, file);
    assert.equal(keybindingSetting("record", file).overridden, false);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("reports conflicts and rejects malformed bindings", () => {
  const settings = [
    { id: "new-tab", binding: "ctrl+t" },
    { id: "close-tab", binding: "ctrl+t" },
  ];
  assert.deepEqual(keybindingConflicts(settings), [
    { binding: "ctrl+t", actions: ["new-tab", "close-tab"] },
  ]);
  assert.throws(
    () => normalizeKeybinding("hyper+t"),
    /unknown keybinding modifier/,
  );
  assert.throws(() => normalizeKeybinding(""), /cannot be empty/);
  assert.throws(() => normalizeKeybinding("none ctrl+t"), /cannot be combined/);
});

test("puts terminal-safe alternatives first for known Linux collisions", () => {
  if (process.platform !== "linux") return;
  const settings = listKeybindings("/does/not/exist/keybindings.json");
  const binding = (id) => settings.find((setting) => setting.id === id).binding;

  assert.equal(binding("next-tab"), "alt+shift+right ctrl+tab");
  assert.equal(binding("previous-tab"), "alt+shift+left ctrl+shift+tab");
  assert.equal(binding("reopen-tab"), "alt+shift+t ctrl+shift+t");
  assert.equal(binding("devtools"), "f12 ctrl+shift+i");
  assert.equal(binding("zoom-in"), "ctrl+= super+=");
});

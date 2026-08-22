const assert = require("node:assert/strict");
const { test } = require("node:test");

const { terminalKeybindingConflicts } = require("../dist/terminal-keybindings");

test("compares browser settings with bindings reported by the detected terminal", async () => {
  const settings = [
    { id: "find", binding: "ctrl+f ctrl+shift+f" },
    { id: "devtools", binding: "f12 ctrl+shift+i" },
    { id: "palette", binding: "ctrl+k" },
  ];
  const terminal = {
    name: "example",
    keybindings: async () => [
      {
        action: "terminal-search",
        binding: "ctrl+shift+f",
        delivery: "consumed",
      },
      {
        action: "terminal-inspector",
        binding: "ctrl+shift+i",
        delivery: "conditional",
      },
    ],
  };

  assert.deepEqual(await terminalKeybindingConflicts(settings, terminal), [
    {
      action: "find",
      binding: "ctrl+shift+f",
      terminal: "example",
      terminalAction: "terminal-search",
      delivery: "consumed",
    },
    {
      action: "devtools",
      binding: "ctrl+shift+i",
      terminal: "example",
      terminalAction: "terminal-inspector",
      delivery: "conditional",
    },
  ]);
});

test("silently skips terminals without readable keybindings", async () => {
  assert.deepEqual(await terminalKeybindingConflicts([], null), []);
  assert.deepEqual(
    await terminalKeybindingConflicts([], {
      name: "example",
      keybindings: async () => {
        throw new Error("unavailable");
      },
    }),
    [],
  );
});

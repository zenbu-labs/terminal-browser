const assert = require("node:assert/strict");
const { test } = require("node:test");

const { ghosttyKeybindings } = require("../dist/terminals/ghostty.js");

test("reads Ghostty delivery semantics from its effective keybindings", () => {
  const config = `
keybind = ctrl+tab=next_tab
keybind = performable:ctrl+shift+c=copy_to_clipboard:mixed
keybind = unconsumed:ctrl+k=reload_config
keybind = alt+arrow_right=goto_split:right
keybind = ctrl+x=ignore
`;

  assert.deepEqual(ghosttyKeybindings(config), [
    { action: "next_tab", binding: "ctrl+tab", delivery: "consumed" },
    {
      action: "copy_to_clipboard:mixed",
      binding: "ctrl+shift+c",
      delivery: "conditional",
    },
    {
      action: "goto_split:right",
      binding: "alt+right",
      delivery: "consumed",
    },
  ]);
});

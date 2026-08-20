const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  bindingLabel,
  matchesBinding,
  parseKeyBindings,
} = require("../dist/session/keybindings");

test("parses multiple bindings and matches exact modifiers", () => {
  const bindings = parseKeyBindings("ctrl+k alt+k");
  assert.equal(bindings.length, 2);
  assert.equal(bindingLabel(bindings), "ctrl+k");
  assert.equal(
    matchesBinding(
      {
        key: "k",
        mods: { super: false, ctrl: true, alt: false, shift: false },
      },
      bindings,
    ),
    true,
  );
  assert.equal(parseKeyBindings("none").length, 0);
});

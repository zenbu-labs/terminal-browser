const assert = require("node:assert/strict");
const { test } = require("node:test");

const { ghosttyEatsReleasesAtThePrompt } = require("../../dist/terminal/tty.js");

test("only Ghostty before 1.4 keeps the release of a click at its prompt", () => {
  assert.deepEqual(
    ["ghostty 1.2.3", "ghostty 1.3.1", "ghostty 1.4.0", "ghostty 2.0.0", "kitty(0.40.0)", null].map(ghosttyEatsReleasesAtThePrompt),
    [true, true, false, false, false, false],
  );
});

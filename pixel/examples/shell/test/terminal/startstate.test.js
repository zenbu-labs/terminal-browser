const assert = require("node:assert/strict");
const { test } = require("node:test");

const { runFake, pxsh, screenOf } = require("../../test-support/harness.js");

for (const [where, oldOutput] of [["below old output", 25], ["on the top row, where the answer looks like an F3 key", 0]]) {
  test(`started ${where}, the cursor position answer never reaches zsh, even with keys typed in the same read`, () => {
    const run = runFake({
      name: `startstate-typeahead-${oldOutput}`,
      command: pxsh,
      oldOutput,
      dsrTypeahead: "echo ty{reply}ped\\r",
      steps: [{ wait_for: "\\r\\ntyped" }, { sleep: 300 }, { mark: "done" }, { send: "exit\\r" }],
    });
    const screen = screenOf(run, "done");
    assert.equal(screen.text[oldOutput], "echo typed", `the terminal echoed the keys typed early on the row pxsh started at:\n${screen.text.join("\n")}`);
    const prompt = screen.text.indexOf("READY> echo typed");
    assert.equal(prompt, oldOutput + 1, "and zsh read them intact");
    assert.equal(screen.text[prompt + 1], "typed");
    assert.equal(screen.text[prompt + 2], "READY>");
    const echoed = Buffer.concat(run.tap.filter((r) => r.from === "raw").map((r) => r.bytes)).toString("latin1");
    assert.doesNotMatch(echoed, /\d+;\d+R|\^\[/, "zsh never saw the answer");
  });
}

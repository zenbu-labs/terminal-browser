const assert = require("node:assert/strict");
const { test } = require("node:test");

const { askMessage } = require("../../dist/ai/turn.js");

const context = { cwd: "/tmp/w", commandLine: "", recentOutput: "", selection: "", lastRun: null };

test("a follow-up after running a command from the bar tells the model how it ended", () => {
  const text = askMessage("why did it fail", { ...context, lastRun: { command: "ls nope", exitCode: 1 } });
  assert.match(text, /They ran ls nope and it exited with code 1\./);
});

test("a command still running is reported as running", () => {
  assert.match(askMessage("q", { ...context, lastRun: { command: "sleep 9", exitCode: null } }), /sleep 9 and it is still running/);
});

test("no run means no run line", () => {
  assert.doesNotMatch(askMessage("q", context), /They ran/);
});

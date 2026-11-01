const assert = require("node:assert/strict");
const { test } = require("node:test");

const { debuggingPortRefusal, requestedDebuggingPort } = require("../dist/debugging-port.js");

test("--remote-debugging-port is off unless asked for, and takes an optional port", () => {
  assert.equal(requestedDebuggingPort(["https://example.com"]), null);
  assert.equal(requestedDebuggingPort(["--remote-debugging-port"]), 0);
  assert.equal(requestedDebuggingPort(["--remote-debugging-port=9222"]), 9222);
  for (const bad of ["--remote-debugging-port=", "--remote-debugging-port=abc", "--remote-debugging-port=70000", "--remote-debugging-port=-1"]) {
    assert.throws(() => requestedDebuggingPort([bad]), /invalid/, bad);
  }
});

test("a running browser serves only the debugging port it started with", () => {
  assert.equal(debuggingPortRefusal([], null), null);
  assert.equal(debuggingPortRefusal([], 9222), null);
  assert.equal(debuggingPortRefusal(["--remote-debugging-port"], 9222), null);
  assert.equal(debuggingPortRefusal(["--remote-debugging-port=9222"], 9222), null);
  assert.match(debuggingPortRefusal(["--remote-debugging-port"], null), /without --remote-debugging-port/);
  assert.match(debuggingPortRefusal(["--remote-debugging-port=9333"], 9222), /=9222/);
});

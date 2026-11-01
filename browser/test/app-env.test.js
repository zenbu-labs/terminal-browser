const assert = require("node:assert/strict");
const { test } = require("node:test");

const { appEnvironment } = require("../dist/session/app-env.js");

test("launched apps don't inherit the Claude bridge's address or token, or NODE_OPTIONS", () => {
  const env = appEnvironment({
    PATH: "/bin",
    TERMINAL_BROWSER_AGENT_BRIDGE: "http://127.0.0.1:1",
    TERMINAL_BROWSER_AGENT_TOKEN: "ab".repeat(24),
    TERMINAL_BROWSER_AGENT_TOKEN_ON_STDIN: "1",
    TERMINAL_BROWSER_INTEROP_DIR: "/x",
    NODE_OPTIONS: "--inspect=127.0.0.1:9229",
  });
  assert.deepEqual(env, { PATH: "/bin", TERMINAL_BROWSER_INTEROP_DIR: "/x" });
});

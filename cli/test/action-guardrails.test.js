const assert = require("node:assert/strict");
const { test } = require("node:test");

const { checkGuardrails } = require("../dist/action.js");

test("command flags and output flags pass through", () => {
  checkGuardrails(["snapshot", "-i", "-c", "-d", "3"]);
  checkGuardrails(["screenshot", "--full", "--json"]);
  checkGuardrails(["wait", "--load", "networkidle"]);
  checkGuardrails(["fill", "@e2", "-5"]);
});

test("flags that make agent-browser launch or reach another browser are refused", () => {
  const launching = [
    "--color-scheme", "--user-agent", "--proxy", "--args", "--state", "--allowed-domains", "-p", "--config",
    "--allow-file-access", "--download-path", "--engine", "--init-script", "--enable", "--extension",
    "--ca-cert", "--hide-scrollbars", "--webgpu", "--no-webmcp", "--headers", "--device", "--port",
  ];
  for (const flag of launching) {
    assert.throws(() => checkGuardrails([flag, "x", "get", "url"]), /not available/, flag);
    assert.throws(() => checkGuardrails(["get", "url", `${flag}=x`]), /not available/, flag);
  }
});

test("the connection and session flags keep their explanations", () => {
  assert.throws(() => checkGuardrails(["--cdp", "9222", "snapshot"]), /picks the port/);
  assert.throws(() => checkGuardrails(["--session", "other", "snapshot"]), /names the session/);
});

test("the command is found the way agent-browser finds it, so flag values can't hide one", () => {
  for (const args of [
    ["--max-output", "1", "connect", "ws+unix:/tmp/fake.sock"],
    ["--json", "true", "plugin", "add", "@attacker/pkg"],
    ["--max-output", "1", "install", "-d"],
    ["upgrade"],
    ["plugin", "add", "@attacker/pkg"],
    ["plugins"],
    ["skills"],
    ["chat"],
    ["mcp"],
    ["doctor"],
    ["dashboard", "start"],
    ["inspect"],
    ["stream", "enable"],
    ["profiles"],
  ]) {
    assert.throws(() => checkGuardrails(args), /not available through terminal-browser action/, args.join(" "));
  }
  checkGuardrails(["--json", "true", "snapshot", "-i"]);
  checkGuardrails(["--max-output", "200", "get", "title"]);
});

test("every entry of a batch is checked, and a batch read from stdin or nested is refused", () => {
  checkGuardrails(["batch", "eval document.title", "snapshot -i", "--bail"]);
  for (const args of [
    ["batch", "connect ws+unix:/tmp/fake.sock", "eval document.title"],
    ["batch", "eval 1", "plugin add @attacker/pkg"],
    ["batch", "--cdp 9222 get url"],
    ["batch", "'install' -d"],
    ["batch", 'batch "eval 1"'],
    ["batch"],
    ["batch", "--bail"],
  ]) {
    assert.throws(() => checkGuardrails(args), /not available|needs its commands/, args.join(" | "));
  }
});

test("an empty word is a command like any other and is refused", () => {
  assert.throws(() => checkGuardrails(["", "install"]), /not available through terminal-browser action/);
  assert.throws(() => checkGuardrails(["batch", '"" install']), /not available/);
});

test("a release never runs an agent-browser override, whatever it claims to be", () => {
  const { findAgentBrowser } = require("../dist/action.js");
  assert.throws(
    () => findAgentBrowser({ TERMINAL_BROWSER_AGENT: "/bin/echo" }, "/opt/terminal-browser"),
    /not used by installed terminal-browser releases/,
  );
  assert.equal(findAgentBrowser({ TERMINAL_BROWSER_AGENT: "/bin/echo" }, null), "/bin/echo");
});

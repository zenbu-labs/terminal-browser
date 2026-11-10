const assert = require("node:assert/strict");
const { test } = require("node:test");

const { AgentPaneFinder } = require("../dist/grab/target.js");

const FILE = "/tmp/terminal-browser/screenshots/page.png";

const SELF = { id: "1", tab: "t" };
const AGENT_PANE = { id: "2", tab: "t", tty: "/dev/ttys002", command: "claude" };
const SHELL_PANE = { id: "3", tab: "t", tty: "/dev/ttys003", command: "zsh" };

function finder(panes, { pasteKey = true } = {}) {
  const calls = [];
  const terminal = {
    name: "fake",
    listPanes: async () => panes,
    sendText: async (pane, text) => calls.push(["sendText", pane, text]),
    focusPane: async (pane) => calls.push(["focusPane", pane]),
  };
  if (pasteKey) terminal.pasteKey = async (pane) => calls.push(["pasteKey", pane]);
  const agentPanes = new AgentPaneFinder({ terminal, parentTty: null, cwd: "/", self: async () => SELF });
  const screenshot = {
    file: () => FILE,
    copyToClipboard: async () => calls.push(["copyToClipboard"]),
  };
  return { agentPanes, calls, screenshot };
}

test("an agent pane gets the text, then the image on the clipboard, then the paste key", async () => {
  const { agentPanes, calls, screenshot } = finder([AGENT_PANE, SHELL_PANE]);
  const delivery = await agentPanes.send("<Button>", screenshot);
  assert.deepEqual(delivery, { target: { pane: "2", tier: "agent", agent: true }, pasted: true });
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["sendText", "copyToClipboard", "pasteKey", "focusPane"],
  );
  assert.equal(calls[0][2], "<Button>\n\n");
  assert.equal(calls[2][1], "2");
});

test("a terminal that cannot press keys gets the file path inside the text instead", async () => {
  const { agentPanes, calls, screenshot } = finder([AGENT_PANE], { pasteKey: false });
  const delivery = await agentPanes.send("<Button>", screenshot);
  assert.equal(delivery.pasted, false);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["sendText", "focusPane"],
  );
  assert.equal(calls[0][2], `<Button>\n${FILE}\n\n`);
});

test("a plain shell never receives a paste key", async () => {
  const { agentPanes, calls, screenshot } = finder([SHELL_PANE]);
  const delivery = await agentPanes.send("<Button>", screenshot);
  assert.deepEqual(delivery, { target: { pane: "3", tier: "neighbor", agent: false }, pasted: false });
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["sendText", "focusPane"],
  );
  assert.equal(calls[0][2], `'<Button> ${FILE}'`);
});

test("without a screenshot nothing touches the clipboard", async () => {
  const { agentPanes, calls } = finder([AGENT_PANE]);
  const delivery = await agentPanes.send("<Button>", null);
  assert.equal(delivery.pasted, false);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["sendText", "focusPane"],
  );
});

test("nobody to send to means no delivery at all", async () => {
  const { agentPanes, calls, screenshot } = finder([]);
  assert.equal(await agentPanes.send("<Button>", screenshot), null);
  assert.deepEqual(calls, []);
});

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { detect } = require("@zenbu-labs/pixel/terminal");
const { AgentPaneFinder } = require("../dist/grab/target.js");

function insideHerdrApp() {
  if (!process.env.HC_TERMINAL_ID) return false;
  try {
    execFileSync("herdr-app", ["status"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const inHerdrApp = { skip: !insideHerdrApp() && "needs a pane in the Herdr desktop app" };

const OWN = process.env.HC_TERMINAL_ID;
const herdrApp = (...args) => JSON.parse(execFileSync("herdr-app", args, { encoding: "utf8" }) || "null");
const hcGet = (terminal) => JSON.parse(execFileSync("hc", ["get", terminal, "--json"], { encoding: "utf8" }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function split(direction, argv) {
  const own = herdrApp("ls").spaces.flatMap((space) => space.tabs).flatMap((tab) => tab.terminals).find((entry) => entry.terminal === OWN);
  return herdrApp("do", "pane.split", JSON.stringify({ direction, pane: own.pane, argv }));
}

async function ttyOf(terminal) {
  for (let waited = 0; waited < 5000; waited += 100) {
    const tty = execFileSync("ps", ["-o", "tty=", "-p", String(hcGet(terminal).pid)], { encoding: "utf8" }).trim();
    if (tty && !tty.startsWith("?")) return `/dev/${tty}`;
    await sleep(100);
  }
  throw new Error(`no tty for ${terminal}`);
}

// a stand-in coding agent: it tells Herdr it is claude, then writes down everything typed into it
const FAKE_AGENT = `
import os, sys
out = sys.argv[1]
sys.stdout.write("\\x1b]7501;state=idle:app=claude\\x1b\\\\")
sys.stdout.flush()
while True:
    chunk = os.read(0, 4096)
    if not chunk:
        break
    with open(out, "ab") as f:
        f.write(chunk)
`;

test("send to agent skips the shell the browser was opened from and reaches the agent in the tab", inHerdrApp, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-app-send-"));
  const agentScript = path.join(dir, "claude");
  const received = path.join(dir, "received");
  fs.writeFileSync(agentScript, FAKE_AGENT);
  const shell = split("right", ["/bin/zsh", "-f", "-i"]);
  const agent = split("down", ["python3", agentScript, received]);
  try {
    const terminal = detect(process.env);
    const self = await terminal.getCurrentPane({ tty: null, cwd: "/" });
    for (let waited = 0; waited < 5000 && !hcGet(agent.terminal).status?.app; waited += 100) await sleep(100);
    const finder = new AgentPaneFinder({
      terminal,
      parentTty: await ttyOf(shell.terminal),
      cwd: "/",
      self: async () => self,
    });
    const delivery = await finder.send("<Button>", null);
    assert.deepEqual(delivery?.target, { pane: agent.terminal, tier: "agent", agent: true });
    for (let waited = 0; waited < 5000 && !fs.existsSync(received); waited += 100) await sleep(100);
    assert.match(fs.readFileSync(received, "utf8"), /<Button>/);
    assert.doesNotMatch(execFileSync("hc", ["read", shell.terminal], { encoding: "utf8" }), /<Button>/);
  } finally {
    for (const pane of [shell.pane, agent.pane]) {
      try {
        herdrApp("do", "pane.close", JSON.stringify({ pane }));
      } catch {}
    }
    herdrApp("do", "pane.focus", JSON.stringify({ terminal: OWN }));
  }
});

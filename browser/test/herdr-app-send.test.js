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

const herdrApp = (...args) => JSON.parse(execFileSync("herdr-app", args, { encoding: "utf8" }) || "null");
const hcGet = (terminal) => JSON.parse(execFileSync("hc", ["get", terminal, "--json"], { encoding: "utf8" }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function paneOf(terminal) {
  const panes = herdrApp("ls").spaces.flatMap((space) => space.tabs).flatMap((tab) => tab.terminals);
  return panes.find((entry) => entry.terminal === terminal).pane;
}

const split = (pane, direction, argv) => herdrApp("do", "pane.split", JSON.stringify({ direction, pane, argv }));

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

// "ssh-relay" stands for an agent reached over ssh: only Herdr's status says it is an agent
for (const program of ["claude", "ssh-relay"]) {
  test(`send to agent skips the shell the browser was opened from and reaches the ${program} agent in the tab`, inHerdrApp, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-app-send-"));
    const agentScript = path.join(dir, program);
    const received = path.join(dir, "received");
    fs.writeFileSync(agentScript, FAKE_AGENT);
    // a tab of its own, so no agent the person is running can receive the text
    const own = herdrApp("do", "tab.new", JSON.stringify({ name: "herdr-app-send-test", argv: ["sleep", "600"], focus: false }));
    try {
      const shell = split(paneOf(own.terminal), "right", ["/bin/zsh", "-f", "-i"]);
      const agent = split(shell.pane, "down", ["python3", agentScript, received]);
      const terminal = detect(process.env);
      const self = { id: own.terminal, tab: own.tab };
      const agentInFront = () => {
        const info = hcGet(agent.terminal);
        return info.status?.app && !/sh$/.test(info.foreground?.name ?? "sh");
      };
      for (let waited = 0; waited < 5000 && !agentInFront(); waited += 100) await sleep(100);
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

      // the agent quits and the pane goes on to run some other program, which must not get the next selection
      const other = path.join(dir, "other");
      process.kill(hcGet(agent.terminal).foreground.pid);
      for (let waited = 0; waited < 5000 && !/sh$/.test(hcGet(agent.terminal).foreground?.name ?? ""); waited += 100) {
        await sleep(100);
      }
      execFileSync("hc", ["send", agent.terminal, "--", `exec cat > ${other}`]);
      for (let waited = 0; waited < 5000 && hcGet(agent.terminal).foreground?.name !== "cat"; waited += 100) await sleep(100);
      assert.equal(await finder.send("<AfterExit>", null), null);
      await sleep(4000);
      assert.doesNotMatch(fs.readFileSync(other, "utf8"), /<AfterExit>/);
    } finally {
      herdrApp("do", "tab.close", JSON.stringify({ id: own.tab, confirmed: true }));
    }
  });
}

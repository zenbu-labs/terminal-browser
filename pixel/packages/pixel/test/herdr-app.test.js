const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { detect } = require("../dist/terminal/index.js");

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

function herdrPanes() {
  return herdrApp("ls").spaces.flatMap((space) =>
    space.tabs.flatMap((tab) => tab.terminals.map((entry) => ({ ...entry, tab: tab.id }))),
  );
}

const OWN = process.env.HC_TERMINAL_ID;

// The marker in argv picks out our pane, so cleanup never closes a pane someone else opened meanwhile
async function withSplit(direction, run, command = ["sleep", "600"]) {
  const terminal = detect(process.env);
  const marker = `herdr-app-test-${crypto.randomUUID()}`;
  const argv = ["sh", "-c", 'exec "$@"', marker, ...command];
  const before = new Set(herdrPanes().map((entry) => entry.terminal));
  const from = await terminal.getCurrentPane({ tty: null, cwd: process.cwd() });
  const isOurs = (entry) => {
    try {
      return hcGet(entry.terminal).argv.includes(marker);
    } catch {
      return false;
    }
  };
  const ours = () => herdrPanes().find((entry) => !before.has(entry.terminal) && isOurs(entry));
  try {
    await terminal.split({ from, direction, command: argv, size: null, tty: null });
    const created = ours();
    assert.ok(created, `split ${direction} did not add a pane`);
    await run({ terminal, from, created });
  } finally {
    const created = ours();
    if (created) herdrApp("do", "pane.close", JSON.stringify({ pane: created.pane }));
    herdrApp("do", "pane.focus", JSON.stringify({ terminal: OWN }));
  }
}

test("a Herdr desktop pane is herdr-app, not the ghostty it draws with", inHerdrApp, async () => {
  const terminal = detect(process.env);
  assert.equal(process.env.TERM_PROGRAM, "ghostty");
  assert.equal(terminal?.name, "herdr-app");
  const own = herdrPanes().find((entry) => entry.terminal === OWN);
  assert.deepEqual(await terminal.getCurrentPane({ tty: null, cwd: process.cwd() }), { id: OWN, tab: own.tab });
});

// a pane opened a moment ago is not in the window yet, and only the window answers the graphics probe
test("herdr-app draws in a pane it just opened, before the window answers the graphics probe", inHerdrApp, async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-app-")), "graphics");
  const dist = JSON.stringify(path.join(__dirname, "../dist/terminal/index.js"));
  const check = `const t = require(${dist}); t.checkTerminal(t.detect()).then((c) => require("fs").writeFileSync(${JSON.stringify(out)}, c.graphics)); setTimeout(() => {}, 60000)`;
  await withSplit("right", async () => {
    for (let waited = 0; waited < 5000 && !fs.existsSync(out); waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(fs.readFileSync(out, "utf8"), "supported");
  }, [process.execPath, "-e", check]);
});

test("herdr-app lists every pane with the tty its shell runs on", inHerdrApp, async () => {
  const panes = await detect(process.env).listPanes();
  assert.deepEqual(
    panes.map((pane) => pane.id).sort(),
    herdrPanes().map((entry) => entry.terminal).sort(),
  );
  const tty = execFileSync("ps", ["-o", "tty=", "-p", String(hcGet(OWN).pid)], { encoding: "utf8" }).trim();
  assert.equal(panes.find((pane) => pane.id === OWN).tty, `/dev/${tty}`);
});

for (const direction of ["right", "left", "down", "up"]) {
  test(`herdr-app splits ${direction} of this pane and runs the command there`, inHerdrApp, async () => {
    await withSplit(direction, async ({ from, created }) => {
      assert.equal(created.tab, from.tab);
      assert.deepEqual(hcGet(created.terminal).argv.slice(-2), ["sleep", "600"]);
      const order = herdrPanes()
        .filter((entry) => entry.terminal === OWN || entry.terminal === created.terminal)
        .map((entry) => entry.terminal);
      const before = direction === "left" || direction === "up";
      assert.deepEqual(order, before ? [created.terminal, OWN] : [OWN, created.terminal]);
    });
  });
}

test("herdr-app refuses a split size it cannot apply, before opening a pane", inHerdrApp, async () => {
  const terminal = detect(process.env);
  const before = herdrPanes().length;
  const from = await terminal.getCurrentPane({ tty: null, cwd: process.cwd() });
  await assert.rejects(
    terminal.split({ from, direction: "right", command: ["sleep", "600"], size: 0.75, tty: null }),
    /--size/,
  );
  assert.equal(herdrPanes().length, before);
});

test("herdr-app focuses a pane by its terminal", inHerdrApp, async () => {
  await withSplit("right", async ({ terminal, created }) => {
    await terminal.focusPane(OWN);
    await terminal.focusPane(created.terminal);
    assert.equal(herdrApp("status").focused_pane, created.pane);
  });
});

test("herdr-app will not send text to a plain program, where Enter would run it", inHerdrApp, async () => {
  await withSplit("right", async ({ terminal, created }) => {
    await assert.rejects(terminal.sendText(created.terminal, "echo should-not-run"), /not running a coding agent/);
  });
});

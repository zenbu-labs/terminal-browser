const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { detect } = require("../dist/terminal/index.js");

// drives the real Herdr desktop app, so it only runs from a pane inside it
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

function herdrPanes() {
  return herdrApp("ls").spaces.flatMap((space) =>
    space.tabs.flatMap((tab) => tab.terminals.map((entry) => ({ ...entry, tab: tab.id }))),
  );
}

async function splitAndFind(terminal, direction) {
  const before = new Set(herdrPanes().map((entry) => entry.terminal));
  const from = await terminal.getCurrentPane({ tty: null, cwd: process.cwd() });
  await terminal.split({ from, direction, command: ["sleep", "600"], size: null, tty: null });
  const created = herdrPanes().find((entry) => !before.has(entry.terminal));
  assert.ok(created, `split ${direction} did not add a pane`);
  return { from, created };
}

const closePane = (pane) => herdrApp("do", "pane.close", JSON.stringify({ pane }));

test("a Herdr desktop pane is herdr-app, not the ghostty it draws with", inHerdrApp, async () => {
  const terminal = detect(process.env);
  assert.equal(process.env.TERM_PROGRAM, "ghostty");
  assert.equal(terminal?.name, "herdr-app");
  const own = herdrPanes().find((entry) => entry.terminal === process.env.HC_TERMINAL_ID);
  assert.deepEqual(await terminal.getCurrentPane({ tty: null, cwd: process.cwd() }), {
    id: process.env.HC_TERMINAL_ID,
    tab: own.tab,
  });
});

// a pane opened a moment ago is not in the window yet, and only the window answers the graphics probe
test("herdr-app draws in a pane it just opened, before the window answers the graphics probe", inHerdrApp, async () => {
  const terminal = detect(process.env);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-app-")), "graphics");
  const dist = JSON.stringify(path.join(__dirname, "../dist/terminal/index.js"));
  const check = `const t = require(${dist}); t.checkTerminal(t.detect()).then((c) => require("fs").writeFileSync(${JSON.stringify(out)}, c.graphics)); setTimeout(() => {}, 60000)`;
  const before = new Set(herdrPanes().map((entry) => entry.terminal));
  const from = await terminal.getCurrentPane({ tty: null, cwd: process.cwd() });
  await terminal.split({ from, direction: "right", command: [process.execPath, "-e", check], size: null, tty: null });
  const created = herdrPanes().find((entry) => !before.has(entry.terminal));
  try {
    for (let waited = 0; waited < 5000 && !fs.existsSync(out); waited += 100) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.readFileSync(out, "utf8"), "supported");
  } finally {
    if (created) closePane(created.pane);
  }
});

test("herdr-app lists every pane with the tty its shell runs on", inHerdrApp, async () => {
  const terminal = detect(process.env);
  const panes = await terminal.listPanes();
  assert.deepEqual(
    panes.map((pane) => pane.id).sort(),
    herdrPanes().map((entry) => entry.terminal).sort(),
  );
  const shellPid = JSON.parse(execFileSync("hc", ["get", process.env.HC_TERMINAL_ID, "--json"], { encoding: "utf8" })).pid;
  const tty = execFileSync("ps", ["-o", "tty=", "-p", String(shellPid)], { encoding: "utf8" }).trim();
  assert.equal(panes.find((pane) => pane.id === process.env.HC_TERMINAL_ID).tty, `/dev/${tty}`);
});

for (const direction of ["right", "down", "left"]) {
  test(`herdr-app splits ${direction} beside this pane and runs the command there`, inHerdrApp, async () => {
    const terminal = detect(process.env);
    const { from, created } = await splitAndFind(terminal, direction);
    try {
      assert.equal(created.tab, from.tab);
      const argv = JSON.parse(execFileSync("hc", ["get", created.terminal, "--json"], { encoding: "utf8" })).argv;
      assert.deepEqual(argv, ["sleep", "600"]);
    } finally {
      closePane(created.pane);
    }
  });
}

test("herdr-app focuses a pane by its terminal", inHerdrApp, async () => {
  const terminal = detect(process.env);
  const { created } = await splitAndFind(terminal, "right");
  try {
    await terminal.focusPane(process.env.HC_TERMINAL_ID);
    await terminal.focusPane(created.terminal);
    assert.equal(herdrApp("status").focused_pane, created.pane);
  } finally {
    closePane(created.pane);
    await terminal.focusPane(process.env.HC_TERMINAL_ID);
  }
});

test("herdr-app will not send text to a plain program, where Enter would run it", inHerdrApp, async () => {
  const terminal = detect(process.env);
  const { created } = await splitAndFind(terminal, "right");
  try {
    await assert.rejects(terminal.sendText(created.terminal, "echo should-not-run"), /not running a coding agent/);
  } finally {
    closePane(created.pane);
    await terminal.focusPane(process.env.HC_TERMINAL_ID);
  }
});

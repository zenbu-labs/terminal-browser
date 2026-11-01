const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { mock, test } = require("node:test");

for (const key of ["XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "TERMINAL_BROWSER_APPDATA", "TERMINAL_BROWSER_DIST_ROOT"]) {
  delete process.env[key];
}

const { claimLaunch, launchPane, stashLaunch } = require("../dist/session/pane-launch.js");
const { shellQuote } = require(path.join(path.dirname(require.resolve("@zenbu-labs/pixel/package.json")), "dist/terminal/shared.js"));

const EXTENSION_BASE = `chrome-extension://${"a".repeat(32)}/`;
const marker = () => path.join(os.tmpdir(), `tb-pane-launch-${process.pid}-${Math.random().toString(36).slice(2)}`);

function payloads(file) {
  return [
    `mailto:X\\';touch ${file};\\'`,
    `mailto:X\\';(touch ${file});\\'`,
    `https://a.example/#X\\';{touch,${file}};\\'`,
    `https://a.example/#'; touch ${file}; '`,
    `https://a.example/?q=$(touch ${file})`,
    `https://a.example/?q=\`touch ${file}\``,
    `https://a.example/?q=(touch ${file})`,
    `https://a.example/#x\ntouch ${file}\n`,
    `https://a.example/#x\\\\'\\''; touch ${file}; #`,
  ];
}

function fakeDist() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-pane-launch-dist-"));
  const seen = path.join(root, "seen.json");
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(
    path.join(root, "bin", "terminal-browser"),
    `#!/bin/sh\nprintf '%s\\n' "$TERMINAL_BROWSER_LAUNCH" "$@" > '${seen}'\n`,
    { mode: 0o755 },
  );
  return { root, seen };
}

async function launch(url, root) {
  const splits = [];
  const terminal = { name: "fake", split: async (request) => splits.push(request) };
  const from = { id: "pane-1", tab: "1" };
  const token = crypto.randomUUID();
  const argv = [url, "--split-dir=right", "--parent-tty=/dev/ttys001"];
  const opened = await launchPane({ terminal, from, env: { TERMINAL_BROWSER_DIST_ROOT: root }, argv, token, tty: null });
  assert.equal(opened, true);
  assert.equal(splits.length, 1);
  return { command: splits[0].command, token, argv };
}

function shell(name) {
  const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  return found || null;
}

const SHELLS = [
  ["bash", ["--noprofile", "--norc", "-c"]],
  ["zsh", ["-f", "-c"]],
  ["fish", ["--no-config", "-c"]],
];

test("a pane launch command carries only constants and the launch token, never the URL", async () => {
  const { root } = fakeDist();
  for (const raw of payloads(marker())) {
    const url = new URL(raw, EXTENSION_BASE).href;
    const { command, token, argv } = await launch(url, root);
    assert.deepEqual(command, [
      "/usr/bin/env",
      `TERMINAL_BROWSER_DIST_ROOT=${root}`,
      `TERMINAL_BROWSER_LAUNCH=${token}`,
      path.join(root, "bin", "terminal-browser"),
      "open",
    ]);
    const line = shellQuote(command);
    for (const word of ["touch", "a.example", url, "--split-dir", "--parent-tty"]) assert.equal(line.includes(word), false, word);
    for (const part of command) assert.match(part, /^[\w\-./:=+@%,]+$/);
    assert.deepEqual(claimLaunch(token), argv);
    assert.equal(claimLaunch(token), null);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [name, flags] of SHELLS) {
  const binary = shell(name);
  test(`${name}: running the quoted pane command executes nothing from the URL, and the URL arrives intact`, { skip: !binary && `${name} is not installed` }, async () => {
    const { root, seen } = fakeDist();
    const file = marker();
    for (const raw of payloads(file)) {
      const url = new URL(raw, EXTENSION_BASE).href;
      const { command, token, argv } = await launch(url, root);
      const run = spawnSync(binary, [...flags, shellQuote(command)], { encoding: "utf8", timeout: 10_000 });
      assert.equal(fs.existsSync(file), false, `${name} ran a command from ${JSON.stringify(raw)}`);
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(fs.readFileSync(seen, "utf8").split("\n").slice(0, -1), [token, "open"]);
      assert.deepEqual(claimLaunch(token), argv);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("a launch can be claimed once, and expires", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const kept = stashLaunch(["https://a.example/"]);
    const expired = stashLaunch(["https://b.example/"]);
    assert.deepEqual(claimLaunch(kept), ["https://a.example/"]);
    assert.equal(claimLaunch(kept), null);
    mock.timers.tick(30_001);
    assert.equal(claimLaunch(expired), null);
  } finally {
    mock.timers.reset();
  }
});

test("a failed split forgets its launch", async () => {
  const { root } = fakeDist();
  const token = crypto.randomUUID();
  const terminal = { name: "fake", split: async () => { throw new Error("split failed"); } };
  await assert.rejects(launchPane({ terminal, from: { id: "p", tab: "1" }, env: { TERMINAL_BROWSER_DIST_ROOT: root }, argv: ["https://a.example/"], token, tty: null }));
  assert.equal(claimLaunch(token), null);
  fs.rmSync(root, { recursive: true, force: true });
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { checkTerminal, detect } = require("../dist/terminal/index.js");

const FIXTURES = path.join(__dirname, "fixtures");

// both draw with ghostty's engine and report ghostty everywhere they can
const GHOSTTY_LOOKALIKE = {
  TERM: "xterm-ghostty",
  TERM_PROGRAM: "ghostty",
  GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty",
};
const GHOSTTY_LOOKALIKES = new Set(["cmux", "supacode"]);

/** Answers from recorded output, and remembers what was asked. */
function recorder(exec) {
  const commands = [];
  const run = async (bin, args) => {
    const command = [bin, ...args].join(" ");
    commands.push(command);
    const output = exec[command];
    if (output === undefined) throw new Error(`nothing recorded for: ${command}`);
    return output;
  };
  return { run, commands };
}

for (const file of fs.readdirSync(FIXTURES)) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
  const { env, exec, expect } = fixture;

  test(`${expect.name}: knows which pane it is in`, async () => {
    const { run } = recorder(exec);
    const terminal = detect(env, run);
    assert.equal(terminal?.name, expect.name);
    if (GHOSTTY_LOOKALIKES.has(expect.name)) {
      assert.equal(detect({ ...env, ...GHOSTTY_LOOKALIKE }, run)?.name, expect.name);
    }
    assert.deepEqual(await terminal.getCurrentPane({ tty: null, cwd: "/" }), expect.currentPane);
  });

  test(`${expect.name}: opens a split`, async () => {
    const { run, commands } = recorder(exec);
    const terminal = detect(env, run);
    await terminal.split(expect.split.request);
    assert.deepEqual(commands, expect.split.commands);
  });

  if (expect.pasteKey) {
    test(`${expect.name}: presses ctrl+v as a key, never as pasted text`, async () => {
      const { run, commands } = recorder({ ...exec, ...Object.fromEntries(expect.pasteKey.commands.map((c) => [c, ""])) });
      const terminal = detect(env, run);
      await terminal.pasteKey(expect.currentPane.id);
      assert.deepEqual(commands, expect.pasteKey.commands);
      assert.ok(commands.every((command) => !command.includes("\x1b[200~")));
    });
  }
}

test("an unknown terminal is nobody", () => {
  assert.equal(detect({ TERM: "xterm-256color" }, async () => ""), null);
});

test("vscode draws but cannot open panes", () => {
  const terminal = detect({ TERM_PROGRAM: "vscode" }, async () => "");
  assert.equal(terminal?.name, "vscode");
  assert.equal(terminal?.split, undefined);
});

// there is no tty here, so nothing answers and recognising the terminal is all we have
test("a terminal we know draws when the tty will not say, a stranger does not", async () => {
  const known = await checkTerminal(detect({ TERM_PROGRAM: "vscode" }, async () => ""), {});
  assert.equal(known.graphics, "supported");
  const stranger = await checkTerminal(detect({ TERM: "xterm-256color" }, async () => ""), {});
  assert.equal(stranger.graphics, "unsupported");
});

test("a multiplexer wins over the terminal it runs in", () => {
  const terminal = detect({ TMUX: "/tmp/x,1,0", TERM_PROGRAM: "ghostty" }, async () => "");
  assert.equal(terminal?.name, "tmux");
});

// a terminal opened from ghostty inherits every ghostty variable, and answering "ghostty"
// there sends apple events from the wrong app — which macOS asks the person to allow
test("a pane variable beats the variables the terminal was launched with", () => {
  const terminal = detect(
    {
      TTY7_PANE: "%3",
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty",
    },
    async () => "",
  );
  assert.equal(terminal?.name, "tty7");
});

test("plain ghostty is still ghostty", () => {
  assert.equal(detect(GHOSTTY_LOOKALIKE, async () => "")?.name, "ghostty");
});


function tempHerdrConfig(initialContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-cfg-"));
  const configPath = path.join(dir, "config.toml");
  if (initialContent !== null) fs.writeFileSync(configPath, initialContent);
  return configPath;
}

test("herdr prepare enables kitty graphics from a blank config", async () => {
  const configPath = tempHerdrConfig(null);
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const { run, commands } = recorder({
    "herdr server reload-config": JSON.stringify({ result: { status: "applied" } }),
  });
  await detect(env, run).prepare();
  assert.equal(fs.readFileSync(configPath, "utf8"), "[experimental]\nkitty_graphics = true\n");
  assert.deepEqual(commands, ["herdr server reload-config"]);
});

test("herdr prepare inserts into an existing experimental table instead of duplicating it", async () => {
  const configPath = tempHerdrConfig(
    "onboarding = false\n\n[experimental]\nreveal_hidden_cursor_for_cjk_ime = true\n",
  );
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const { run } = recorder({
    "herdr server reload-config": JSON.stringify({ result: { status: "applied" } }),
  });
  await detect(env, run).prepare();
  const content = fs.readFileSync(configPath, "utf8");
  assert.match(content, /\[experimental\]\nkitty_graphics = true\nreveal_hidden_cursor_for_cjk_ime = true/);
  assert.equal((content.match(/\[experimental\]/g) ?? []).length, 1);
});

test("herdr prepare flips an explicit kitty_graphics = false instead of duplicating the key", async () => {
  const configPath = tempHerdrConfig("[experimental]\nkitty_graphics = false\n");
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const { run } = recorder({
    "herdr server reload-config": JSON.stringify({ result: { status: "applied" } }),
  });
  await detect(env, run).prepare();
  assert.equal(fs.readFileSync(configPath, "utf8"), "[experimental]\nkitty_graphics = true\n");
});

test("herdr prepare leaves an already-enabled config alone and never reloads", async () => {
  const configPath = tempHerdrConfig("[experimental]\nkitty_graphics = true\n");
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const { run, commands } = recorder({});
  await detect(env, run).prepare();
  assert.deepEqual(commands, []);
});

test("herdr prepare stays silent when herdr itself cannot be run", async () => {
  const configPath = tempHerdrConfig(null);
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const run = async () => {
    throw new Error("spawn herdr ENOENT");
  };
  const originalError = console.error;
  const warnings = [];
  console.error = (message) => warnings.push(message);
  try {
    await assert.doesNotReject(detect(env, run).prepare());
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(warnings, []);
});


test("tmux finds the pane touching the given side, across the divider", async () => {
  const listing = "%18\t0\t0\t157\t20\n%19\t0\t22\t157\t41\n%20\t159\t0\t200\t41\n";
  const { run } = recorder({ "tmux list-panes -t %18 -F #{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_right}\t#{pane_bottom}": listing });
  const terminal = detect({ TMUX: "/tmp/x,1,0", TMUX_PANE: "%18" }, run);
  const from = { id: "%18", tab: "main:@1" };
  assert.deepEqual(await terminal.neighbor(from, "down"), { id: "%19", tab: "main:@1" });
  assert.deepEqual(await terminal.neighbor(from, "right"), { id: "%20", tab: "main:@1" });
  assert.equal(await terminal.neighbor(from, "up"), null);
  assert.equal(await terminal.neighbor(from, "left"), null);
});

test("herdr asks the terminal for the neighbor", async () => {
  const answer = JSON.stringify({ result: { neighbor: { neighbor_pane_id: "wJ:p3", layout: { tab_id: "wJ:t1" } } } });
  const none = JSON.stringify({ result: { neighbor: { neighbor_pane_id: null, layout: { tab_id: "wJ:t1" } } } });
  const { run } = recorder({
    "herdr pane neighbor --pane wJ:p1 --direction right": answer,
    "herdr pane neighbor --pane wJ:p1 --direction left": none,
  });
  const terminal = detect({ HERDR_PANE_ID: "wJ:p1", HERDR_TAB_ID: "wJ:t1", TERM_PROGRAM: "herdr" }, run);
  assert.equal(terminal?.name, "herdr");
  assert.deepEqual(await terminal.neighbor({ id: "wJ:p1", tab: "wJ:t1" }, "right"), { id: "wJ:p3", tab: "wJ:t1" });
  assert.equal(await terminal.neighbor({ id: "wJ:p1", tab: "wJ:t1" }, "left"), null);
});

test("kitty rebuilds pane rectangles from the splits pair tree", async () => {
  const ls = JSON.stringify([{ id: 1, tabs: [{
    id: 7, is_active: true, layout: "splits", enabled_layouts: ["splits"],
    layout_state: { pairs: { horizontal: true, bias: 0.4, one: 10, two: { horizontal: false, one: 11, two: 12 } } },
    groups: [{ id: 10, windows: [100] }, { id: 11, windows: [101] }, { id: 12, windows: [102] }],
    windows: [{ id: 100 }, { id: 101 }, { id: 102 }],
  }] }]);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-kitten-"));
  fs.writeFileSync(path.join(bin, "kitten"), "#!/bin/sh\n", { mode: 0o755 });
  const { run } = recorder({ [`${path.join(bin, "kitten")} @ ls`]: ls });
  const terminal = detect({ TERM: "xterm-kitty", KITTY_WINDOW_ID: "100", KITTY_PID: "1", PATH: bin }, run);
  const from = { id: "100", tab: "1:7" };
  assert.deepEqual(await terminal.neighbor(from, "right"), { id: "101", tab: "1:7" });
  assert.equal(await terminal.neighbor(from, "left"), null);
  assert.deepEqual(await terminal.neighbor({ id: "102", tab: "1:7" }, "up"), { id: "101", tab: "1:7" });
  assert.deepEqual(await terminal.neighbor({ id: "102", tab: "1:7" }, "left"), { id: "100", tab: "1:7" });
});

test("cmux uses pane frames from the socket and answers with the neighbor's shown surface", async () => {
  const paneList = JSON.stringify({ panes: [
    { id: "pane-a", pixel_frame: { x: 0, y: 0, width: 600, height: 800 } },
    { id: "pane-b", pixel_frame: { x: 604, y: 0, width: 596, height: 400 } },
    { id: "pane-c", pixel_frame: { x: 604, y: 404, width: 596, height: 396 } },
  ] });
  const exec = {
    'cmux rpc pane.list {"workspace_id":"ws-1"} --json --id-format both': paneList,
    "cmux list-pane-surfaces --pane pane-a --json --id-format both": JSON.stringify({ surfaces: [{ id: "s-a", focused: true }] }),
    "cmux list-pane-surfaces --pane pane-b --json --id-format both": JSON.stringify({ surfaces: [{ id: "s-b1" }, { id: "s-b2", focused: true }] }),
    "cmux list-pane-surfaces --pane pane-c --json --id-format both": JSON.stringify({ surfaces: [{ id: "s-c" }] }),
  };
  const { run } = recorder(exec);
  const terminal = detect({ CMUX_SURFACE_ID: "s-a", CMUX_WORKSPACE_ID: "ws-1" }, run);
  assert.equal(terminal?.name, "cmux");
  const from = { id: "s-a", tab: "ws-1" };
  assert.deepEqual(await terminal.neighbor(from, "right"), { id: "s-b2", tab: "ws-1" });
  assert.equal(await terminal.neighbor(from, "left"), null);
  assert.deepEqual(await terminal.neighbor({ id: "s-c", tab: "ws-1" }, "up"), { id: "s-b2", tab: "ws-1" });
  assert.deepEqual(await terminal.neighbor({ id: "s-b1", tab: "ws-1" }, "left"), { id: "s-a", tab: "ws-1" });
});

const GHOSTTY_ENV = {
  TERM: "xterm-ghostty",
  TERM_PROGRAM: "ghostty",
  TERM_PROGRAM_VERSION: "1.3.1",
  GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty",
};
const onMac = { skip: process.platform !== "darwin" };
const GHOSTTY_BIN = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
const FORKY_BIN = "/Applications/Forky.app/Contents/MacOS/ghostty";
const processTable = (rows) => rows.map((row) => row.join(" ")).join("\n") + "\n";

// a test process lives under whatever launched node, so the pretend ghostty is grafted
// in as our own parent to get a shell -> ghostty ancestry without knowing the real tree
test("ghostty scripts the instance this shell runs inside, not the newest one", onMac, async () => {
  const { run, commands } = recorder({
    "ps -axo pid=,ppid=,tty=,command=": processTable([
      [process.pid, process.ppid, "ttys001", "node test"],
      [process.ppid, 1, "??", FORKY_BIN],
      [9001, 1, "??", GHOSTTY_BIN],
      [9002, 1, "??", `${GHOSTTY_BIN} -e sh -c python3 probe.py`],
    ]),
    [`osascript -l JavaScript - ${process.ppid} list`]: "w1\tt1\tAAAA\t\t\t/Users/me\n",
  });
  const terminal = detect(GHOSTTY_ENV, run);
  assert.deepEqual(await terminal.listPanes(), [
    { id: "AAAA", tab: "w1:t1", tty: null, command: null },
  ]);
  assert.ok(commands.includes(`osascript -l JavaScript - ${process.ppid} list`));
  assert.ok(!commands.includes("osascript -l JavaScript - 9001 list"));
  assert.ok(!commands.includes("osascript -l JavaScript - 9002 list"));
});

test("ghostty falls back to the only instance when this shell is not inside one", onMac, async () => {
  const { run, commands } = recorder({
    "ps -axo pid=,ppid=,tty=,command=": processTable([
      [process.pid, 1, "ttys001", "node test"],
      [7000, 1, "??", GHOSTTY_BIN],
    ]),
    "osascript -l JavaScript - 7000 list": "w1\tt1\tAAAA\t\t\t/Users/me\n",
  });
  await detect(GHOSTTY_ENV, run).listPanes();
  assert.ok(commands.includes("osascript -l JavaScript - 7000 list"));
});

test("ghostty finds the instance through the caller tty when ancestry does not reach one", onMac, async () => {
  const { run, commands } = recorder({
    "ps -axo pid=,ppid=,tty=,command=": processTable([
      [process.pid, 1, "??", "node daemon"],
      [7000, 1, "??", GHOSTTY_BIN],
      [7001, 7000, "ttys009", "login"],
      [7002, 7001, "ttys009", "-zsh"],
      [8000, 1, "??", `${GHOSTTY_BIN} -e probe`],
    ]),
    "osascript -l JavaScript - 7000 list": "w1\tt1\tAAAA\t\t/dev/ttys009\t/Users/me\n",
  });
  const terminal = detect(GHOSTTY_ENV, run);
  const pane = await terminal.getCurrentPane({ tty: "/dev/ttys009", cwd: "/" });
  assert.deepEqual(pane, { id: "AAAA", tab: "w1:t1", tty: "/dev/ttys009", command: null });
  const panes = await terminal.listPanes({ commands: () => true, tty: "/dev/ttys009" });
  assert.deepEqual(panes, [{ id: "AAAA", tab: "w1:t1", tty: "/dev/ttys009", command: null }]);
  assert.ok(commands.includes("osascript -l JavaScript - 7000 list"));
});

// the ttys are plain files reached through /dev/.., and the pretend ghostty reports as a
// pane's directory whatever OSC 7 was last written to that pane's tty
test("ghostty only writes to ttys that its own panes hold", onMac, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ttys-"));
  const fakeTty = (name) => {
    fs.writeFileSync(path.join(dir, name), "");
    return path.relative("/dev", path.join(dir, name));
  };
  const pane = fakeTty("pane");
  const orphan = fakeTty("orphan");
  const rows = [
    [process.pid, 1, "??", "node daemon"],
    [7000, 1, "??", GHOSTTY_BIN],
    [7001, 7000, pane, "login"],
    [7002, 7001, pane, "claude"],
    [9000, 1, orphan, "claude"],
  ];
  const directory = () => {
    const written = /file:\/\/[^/]*(\/[^\x07]*)\x07/.exec(fs.readFileSync(`/dev/${pane}`, "utf8"));
    return written ? decodeURIComponent(written[1]) : "/Users/me";
  };
  const exec = {
    "ps -axo pid=,ppid=,tty=,command=": () => processTable(rows),
    "ps -axo ppid=,tty=": () => processTable(rows.map(([, parent, tty]) => [parent, tty])),
    "ps -e -o pid=,tty=,args=": () => processTable(rows.map(([pid, , tty, command]) => [pid, tty, command])),
    "osascript -l JavaScript - 7000 list": () => `w1\tt1\tAAAA\t\t\t${directory()}\n`,
  };
  const run = async (bin, args) => {
    const output = exec[[bin, ...args].join(" ")];
    if (!output) throw new Error(`nothing recorded for: ${[bin, ...args].join(" ")}`);
    return output();
  };
  const terminal = detect(GHOSTTY_ENV, run);
  const panes = await terminal.listPanes({ commands: (command) => command.includes("claude") });
  assert.deepEqual(panes, [{ id: "AAAA", tab: "w1:t1", tty: `/dev/${pane}`, command: "login\nclaude" }]);
  await assert.rejects(terminal.getCurrentPane({ tty: `/dev/${orphan}`, cwd: "/" }), /not a Ghostty pane/);
  assert.equal(fs.readFileSync(path.join(dir, "orphan"), "utf8"), "");
  assert.equal(directory(), "/Users/me");
});

test("ghostty refuses to guess between instances it cannot connect to this shell", onMac, async () => {
  const { run } = recorder({
    "ps -axo pid=,ppid=,tty=,command=": processTable([
      [process.pid, 1, "ttys001", "node test"],
      [7000, 1, "??", GHOSTTY_BIN],
      [8000, 1, "??", `${GHOSTTY_BIN} -e probe`],
    ]),
  });
  await assert.rejects(detect(GHOSTTY_ENV, run).listPanes(), /2 Ghostty processes.*7000, 8000/);
});

test("ghostty splits through the owning instance with the direction code", onMac, async () => {
  const { run, commands } = recorder({
    [`ps -o pid=,ppid=,command= -p ${process.pid}`]: `${process.pid} ${process.ppid} node test\n`,
    [`ps -o pid=,ppid=,command= -p ${process.ppid}`]: `${process.ppid} 1 ${GHOSTTY_BIN}\n`,
    [`osascript -l JavaScript - ${process.ppid} split AAAA GSrt ${process.cwd()} /bin/sh -c 'pixel open; exit $?'`]: "BBBB",
  });
  await detect(GHOSTTY_ENV, run).split({
    from: { id: "AAAA", tab: "w1:t1" },
    direction: "right",
    command: ["pixel", "open"],
    size: null,
    tty: null,
  });
  assert.deepEqual(commands, [
    `ps -o pid=,ppid=,command= -p ${process.pid}`,
    `ps -o pid=,ppid=,command= -p ${process.ppid}`,
    `osascript -l JavaScript - ${process.ppid} split AAAA GSrt ${process.cwd()} /bin/sh -c 'pixel open; exit $?'`,
  ]);
});

test("ghostty asks the owning instance for a split's neighbor by window and tab", onMac, async () => {
  const { run, commands } = recorder({
    "ps -axo pid=,ppid=,tty=,command=": processTable([
      [process.pid, process.ppid, "ttys001", "node test"],
      [process.ppid, 1, "??", GHOSTTY_BIN],
    ]),
    [`osascript -l JavaScript - ${process.ppid} neighbor w1 t1 AAAA right`]: "BBBB\n",
  });
  const found = await detect(GHOSTTY_ENV, run).neighbor({ id: "AAAA", tab: "w1:t1" }, "right");
  assert.deepEqual(found, { id: "BBBB", tab: "w1:t1" });
  assert.equal(commands.at(-1), `osascript -l JavaScript - ${process.ppid} neighbor w1 t1 AAAA right`);
});


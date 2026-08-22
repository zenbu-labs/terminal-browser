const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { runCli } = require("../dist/program");

function harness() {
  const calls = [];
  let stdout = "";
  let stderr = "";
  const record = (name) => (...args) => {
    calls.push({ args, name });
    return 0;
  };
  const actions = {
    action: record("action"),
    keybindings: record("keybindings"),
    ls: record("ls"),
    newTab: record("newTab"),
    open: record("open"),
    profile: record("profile"),
    setup: record("setup"),
    shutdown: record("shutdown"),
    upgrade: record("upgrade"),
  };
  return {
    calls,
    run: (args) =>
      runCli(args, actions, {
        cwd: process.cwd(),
        version: "1.2.3",
        writeErr: (text) => {
          stderr += text;
        },
        writeOut: (text) => {
          stdout += text;
        },
      }),
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

test("routes explicit and implicit browser opens with normalized options", async () => {
  let cli = harness();
  assert.equal(await cli.run([]), 0);
  assert.equal(cli.calls[0].args[0].target, undefined);

  cli = harness();
  assert.equal(await cli.run(["github.com"]), 0);
  assert.deepEqual(cli.calls, [
    {
      args: [
        {
          browserArgs: [],
          profile: undefined,
          size: undefined,
          split: undefined,
          target: "github.com",
        },
      ],
      name: "open",
    },
  ]);

  cli = harness();
  assert.equal(await cli.run(["best terminal browser"]), 0);
  assert.equal(cli.calls[0].args[0].target, "best terminal browser");

  cli = harness();
  assert.equal(await cli.run(["open", "kittens"]), 0);
  assert.equal(cli.calls[0].args[0].target, "kittens");

  cli = harness();
  assert.equal(
    await cli.run([
      "--split",
      "down",
      "--size=0.4",
      "--profile",
      "work",
      "--preload",
      "./preload.js",
      "--no-toolbar",
      "github.com",
    ]),
    0,
  );
  assert.deepEqual(cli.calls[0], {
    args: [
      {
        browserArgs: ["--no-toolbar", "--preload=./preload.js"],
        profile: "work",
        size: 0.4,
        split: "down",
        target: "github.com",
      },
    ],
    name: "open",
  });
});

test("routes every top-level command", async () => {
  const cases = [
    [["ls", "--all", "--json"], "ls", [true, true]],
    [["setup"], "setup", []],
    [["upgrade"], "upgrade", []],
    [["shutdown"], "shutdown", []],
    [
      ["new-tab", "--browser", "90107-1", "terminal browser profiles"],
      "newTab",
      [{ browserKey: "90107-1", target: "terminal browser profiles" }],
    ],
  ];
  for (const [args, name, expected] of cases) {
    const cli = harness();
    assert.equal(await cli.run(args), 0);
    assert.deepEqual(cli.calls, [{ args: expected, name }]);
  }
});

test("normalizes every browser launch option for the Electron session", async () => {
  const cli = harness();
  assert.equal(
    await cli.run([
      "open",
      "github.com",
      "--app-mode",
      "--no-toolbar",
      "--no-shortcuts",
      "--no-context-menu",
      "--no-overlays",
      "--no-frame",
      "--open-tabs-in-popup-stack",
      "--allow-clipboard-read",
      "--partition",
      "work",
      "--preload=./preload.js",
      "--main-script",
      "./main.js",
      "--palette-key",
      "ctrl+k",
      "--find-key=ctrl+f",
      "--devtools-key",
      "f12",
      "--console-key=ctrl+j",
      "--ssh",
      "dev@build-box",
      "--ssh-bundle",
      "./fixtures/app",
      "--ssh-bundle-dir",
      "/srv/terminal-browser",
      "--split-dir",
      "left",
      "--parent-tty=/dev/pts/2",
    ]),
    0,
  );
  assert.deepEqual(cli.calls[0].args[0].browserArgs, [
    "--app-mode",
    "--no-toolbar",
    "--no-shortcuts",
    "--no-context-menu",
    "--no-overlays",
    "--no-frame",
    "--open-tabs-in-popup-stack",
    "--allow-clipboard-read",
    "--partition=work",
    "--preload=./preload.js",
    "--main-script=./main.js",
    "--palette-key=ctrl+k",
    "--find-key=ctrl+f",
    "--devtools-key=f12",
    "--console-key=ctrl+j",
    "--ssh=dev@build-box",
    `--ssh-bundle=${path.resolve("./fixtures/app")}`,
    "--ssh-bundle-dir=/srv/terminal-browser",
    "--split-dir=left",
    "--parent-tty=/dev/pts/2",
  ]);
});

test("routes all profile subcommands into typed requests", async () => {
  const cases = [
    [["profile", "ls", "--json"], { action: "ls", json: true }],
    [
      ["profile", "default", "work"],
      { action: "default", json: false, name: "work", reset: false },
    ],
    [
      ["profile", "default-source", "brave", "--source-profile", "Default"],
      {
        action: "default-source",
        browser: "brave",
        browserPath: undefined,
        clear: false,
        json: false,
        sourceDir: undefined,
        sourceProfile: "Default",
      },
    ],
    [
      ["profile", "create", "scratch", "--empty"],
      { action: "create", empty: true, name: "scratch" },
    ],
    [
      ["profile", "settings", "work", "--search-engine", "brave"],
      { action: "settings", json: false, name: "work", searchEngine: "brave" },
    ],
    [
      ["profile", "search-engines", "--json"],
      { action: "search-engines", json: true },
    ],
    [["profile", "sources", "--json"], { action: "sources", json: true }],
    [
      [
        "profile",
        "import",
        "chrome",
        "--name",
        "work",
        "--source-dir=/tmp/chrome",
        "--replace",
      ],
      {
        action: "import",
        browser: "chrome",
        browserPath: undefined,
        name: "work",
        replace: true,
        sourceDir: "/tmp/chrome",
        sourceProfile: undefined,
      },
    ],
    [
      ["profile", "sync", "work", "--replace"],
      { action: "sync", name: "work", replace: true },
    ],
    [["profile", "remove", "work"], { action: "remove", name: "work" }],
  ];
  for (const [args, request] of cases) {
    const cli = harness();
    assert.equal(await cli.run(args), 0);
    assert.deepEqual(cli.calls, [{ args: [request], name: "profile" }]);
  }
});

test("routes all keybinding subcommands into typed requests", async () => {
  const cases = [
    [["keybindings", "ls", "--json"], { action: "ls", json: true }],
    [
      ["keybindings", "set", "palette", "ctrl+k", "alt+k"],
      { action: "set", binding: ["ctrl+k", "alt+k"], id: "palette" },
    ],
    [
      ["keybindings", "reset", "close-tab"],
      { action: "reset", all: false, id: "close-tab" },
    ],
    [
      ["keybindings", "reset", "--all"],
      { action: "reset", all: true, id: undefined },
    ],
  ];
  for (const [args, request] of cases) {
    const cli = harness();
    assert.equal(await cli.run(args), 0);
    assert.deepEqual(cli.calls, [{ args: [request], name: "keybindings" }]);
  }
});

test("passes action arguments after the required delimiter untouched", async () => {
  const cli = harness();
  assert.equal(
    await cli.run([
      "action",
      "--browser",
      "90107-1",
      "--tab",
      "t2",
      "--follow",
      "--",
      "eval",
      "--profile",
      "one",
      "--",
      "--profile",
      "two",
    ]),
    0,
  );
  assert.deepEqual(cli.calls, [
    {
      args: [
        {
          browserKey: "90107-1",
          follow: true,
          passthrough: ["eval", "--profile", "one", "--", "--profile", "two"],
          receipt: false,
          tabId: 2,
          targetId: undefined,
        },
      ],
      name: "action",
    },
  ]);
});

test("keeps nested open distinct from top-level open and parses action receipts", async () => {
  const cli = harness();
  assert.equal(
    await cli.run([
      "action",
      "--browser",
      "90107-1",
      "--tab",
      "t2",
      "--receipt",
      "--",
      "open",
      "https://example.com/next",
    ]),
    0,
  );
  assert.deepEqual(cli.calls, [
    {
      args: [
        {
          browserKey: "90107-1",
          follow: false,
          passthrough: ["open", "https://example.com/next"],
          receipt: true,
          tabId: 2,
          targetId: undefined,
        },
      ],
      name: "action",
    },
  ]);
});

test("rejects unquoted searches and preserves typo suggestions", async () => {
  let cli = harness();
  assert.equal(await cli.run(["best", "terminal", "browser"]), 1);
  assert.match(cli.stderr(), /terminal-browser "best terminal browser"/);
  assert.equal(cli.calls.length, 0);

  cli = harness();
  assert.equal(await cli.run(["open", "best", "terminal", "browser"]), 1);
  assert.match(cli.stderr(), /terminal-browser open "best terminal browser"/);

  cli = harness();
  assert.equal(await cli.run(["profle", "--help"]), 1);
  assert.match(cli.stderr(), /unknown command 'profle'/);
  assert.match(cli.stderr(), /Did you mean profile/);
  assert.match(cli.stderr(), /terminal-browser open profle/);
  assert.equal(cli.stdout(), "");

  cli = harness();
  assert.equal(await cli.run(["kittens"]), 1);
  assert.match(cli.stderr(), /terminal-browser open kittens/);
});

test("rejects malformed options before invoking an action", async () => {
  const cases = [
    [["profile", "ls", "--json", "--json"], /may only be specified once/],
    [["open", "github.com", "--profile="], /--profile requires a value/],
    [["open", "github.com", "--profile", "--no-toolbar"], /--profile requires a value/],
    [["open", "github.com", "--ssh="], /--ssh requires a value/],
    [["open", "--ssh-bundle", "./app"], /--ssh-bundle needs --ssh/],
    [["open", "--ssh", "dev@host", "--ssh-bundle-dir", "/srv"], /needs --ssh-bundle/],
    [["open", "github.com", "--wat"], /unknown option '--wat'/],
    [["action", "snapshot"], /action requires --/],
  ];
  for (const [args, message] of cases) {
    const cli = harness();
    assert.equal(await cli.run(args), 1);
    assert.match(cli.stderr(), message);
    assert.equal(cli.calls.length, 0);
  }
});

test("generates root, command, nested, and version output", async () => {
  const cases = [
    [["--help"], /Commands:/],
    [["open", "--help"], /--split <direction>/],
    [["profile", "import", "--help"], /--source-profile <name>/],
    [["action", "--help"], /Everything after -- is passed to agent-browser/],
    [["--version"], /^terminal-browser 1\.2\.3/m],
  ];
  for (const [args, expected] of cases) {
    const cli = harness();
    assert.equal(await cli.run(args), 0);
    assert.match(cli.stdout(), expected);
    assert.equal(cli.calls.length, 0);
  }
});

test("rejects an unknown help topic", async () => {
  const cli = harness();
  assert.equal(await cli.run(["help", "profle"]), 1);
  assert.match(cli.stderr(), /no help for profle/);
  assert.equal(cli.stdout(), "");
});

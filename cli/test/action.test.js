const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

function readJsonLines(file) {
  const contents = fs.readFileSync(file, "utf8").trim();
  return contents ? contents.split("\n").map((line) => JSON.parse(line)) : [];
}

function runNode(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

test("action commands preserve terminal-browser tab identity and lifecycle", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-action-"));
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  process.env.XDG_RUNTIME_DIR = path.join(root, "runtime");

  const callsFile = path.join(root, "agent-calls.jsonl");
  const stateFile = path.join(root, "agent-state.json");
  const agent = path.join(root, "agent-browser");
  fs.writeFileSync(
    agent,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.ACTION_STATE_FILE, "utf8"));
const command = args.slice(args.indexOf("--cdp") + 2);
fs.appendFileSync(process.env.ACTION_CALLS_FILE, JSON.stringify(args) + "\\n");
const current = () => state.tabs.find((tab) => tab.tabId === state.active);
if (command[0] === "tab" && command[1] === "list") {
  process.stdout.write(JSON.stringify({ data: { tabs: state.tabs.map((tab) => ({ ...tab, active: tab.tabId === state.active })) } }));
} else if (command[0] === "tab") {
  state.active = command[1];
  fs.writeFileSync(process.env.ACTION_STATE_FILE, JSON.stringify(state));
} else if (command[0] === "eval" && command[1] === "performance.timeOrigin") {
  process.stdout.write(JSON.stringify({ data: { result: current().timeOrigin } }));
} else if (command[0] === "open") {
  current().url = command[1] || "about:blank";
  current().title = "Navigated";
  fs.writeFileSync(process.env.ACTION_STATE_FILE, JSON.stringify(state));
  process.stdout.write("delegated open output\\n");
} else if (command[0] === "click" && command[1] === "@e999") {
  process.stderr.write("✗ Unknown ref: e999\\n");
  process.exitCode = 7;
} else if (command[0] === "get" && command[1] === "url") {
  process.stdout.write(current().url + "\\n");
}
`,
  );
  fs.chmodSync(agent, 0o755);
  process.env.ACTION_CALLS_FILE = callsFile;
  process.env.ACTION_STATE_FILE = stateFile;
  process.env.TERMINAL_BROWSER_AGENT = agent;

  const initialState = {
    active: "t1",
    tabs: [
      {
        active: true,
        tabId: "t1",
        timeOrigin: 101,
        title: "Duplicate one",
        url: "https://example.test/items/2",
      },
      {
        active: false,
        tabId: "t2",
        timeOrigin: 202,
        title: "Duplicate two",
        url: "https://example.test/items/2",
      },
      {
        active: false,
        tabId: "t3",
        timeOrigin: 303,
        title: "Similar",
        url: "https://example.test/items/20",
      },
    ],
  };
  const controlRequests = [];
  const reset = () => {
    fs.writeFileSync(callsFile, "");
    fs.writeFileSync(stateFile, JSON.stringify(initialState));
    controlRequests.length = 0;
  };

  const socket = path.join(root, "browser.sock");
  const server = net.createServer((connection) => {
    connection.setEncoding("utf8");
    connection.once("data", (chunk) => {
      const request = JSON.parse(chunk.trim());
      controlRequests.push(request);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const tab = (id, tabId, targetId) => {
        const agentTab = state.tabs.find((entry) => entry.tabId === tabId);
        return {
          active: state.active === tabId,
          id,
          targetId,
          timeOrigin: agentTab.timeOrigin,
          title: agentTab.title,
          url: agentTab.url,
        };
      };
      let data;
      if (request.cmd === "where") {
        data = { pane: null, tab: null, terminal: null };
      } else if (request.cmd === "targets") {
        data = {
          tabs: [
            tab(1, "t1", "target-1"),
            tab(2, "t2", "target-2"),
            tab(3, "t3", "target-3"),
          ],
        };
      } else if (request.cmd === "open-tab") {
        data = { openedTab: 4 };
      } else {
        data = {};
      }
      connection.end(`${JSON.stringify({ data, ok: true })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { force: true, recursive: true });
  });

  const { upsertInstance } = require("pixel-store");
  const actionPath = path.resolve(__dirname, "../dist/action");
  const runAction = (options) =>
    runNode(
      `
const { actionCommand } = require(${JSON.stringify(actionPath)});
actionCommand(null, ${JSON.stringify(options)}).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(String(error) + "\\n");
  process.exitCode = 1;
});
`,
      { ...process.env },
    );
  await upsertInstance({
    cdpPort: 9222,
    key: "browser-1",
    pid: process.pid,
    socket,
    startedAt: Date.now(),
    url: "https://example.test/items/2",
  });

  await t.test("delegates nested open to the selected duplicate tab without opening a tab", async () => {
    reset();
    const result = await runAction({
      browserKey: "browser-1",
      follow: false,
      passthrough: ["open", "https://example.test/after"],
      receipt: true,
      tabId: 2,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "delegated open output\n");

    assert.deepEqual(readJsonLines(callsFile), [
      ["--session", "terminal-browser-browser-1", "--cdp", "9222", "tab", "list", "--json"],
      ["--session", "terminal-browser-browser-1", "--cdp", "9222", "tab", "t1"],
      [
        "--session",
        "terminal-browser-browser-1",
        "--cdp",
        "9222",
        "eval",
        "performance.timeOrigin",
        "--json",
      ],
      ["--session", "terminal-browser-browser-1", "--cdp", "9222", "tab", "t2"],
      [
        "--session",
        "terminal-browser-browser-1",
        "--cdp",
        "9222",
        "eval",
        "performance.timeOrigin",
        "--json",
      ],
      [
        "--session",
        "terminal-browser-browser-1",
        "--cdp",
        "9222",
        "open",
        "https://example.test/after",
      ],
    ]);
    assert.equal(controlRequests.some((request) => request.cmd === "open-tab"), false);
    assert.equal(
      JSON.parse(fs.readFileSync(stateFile, "utf8")).tabs[1].url,
      "https://example.test/after",
    );
    assert.match(
      result.stderr,
      /browser browser-1, tab 2, target target-2, url https:\/\/example\.test\/items\/2, exit 0/,
    );

    fs.writeFileSync(callsFile, "");
    const followup = await runAction({
      browserKey: "browser-1",
      follow: false,
      passthrough: ["get", "url"],
      receipt: false,
      tabId: 2,
    });
    assert.equal(followup.code, 0);
    assert.equal(followup.stdout, "https://example.test/after\n");
    assert.equal(followup.stderr, "");
    assert.deepEqual(readJsonLines(callsFile), [
      ["--session", "terminal-browser-browser-1", "--cdp", "9222", "tab", "list", "--json"],
      ["--session", "terminal-browser-browser-1", "--cdp", "9222", "get", "url"],
    ]);
  });

  await t.test("keeps nested tab new on the terminal-browser lifecycle path", async () => {
    reset();
    const result = await runAction({
      browserKey: "browser-1",
      follow: false,
      passthrough: ["tab", "new", "https://example.test/new"],
      receipt: false,
      tabId: 1,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(readJsonLines(callsFile).length, 0);
    assert.deepEqual(
      controlRequests.filter((request) => request.cmd === "open-tab"),
      [{ cmd: "open-tab", url: "https://example.test/new" }],
    );
    assert.match(result.stdout, /"openedTab": 4/);
  });

  await t.test("selects an exact URL instead of a similar tab", async () => {
    reset();
    const result = await runAction({
      browserKey: "browser-1",
      follow: false,
      passthrough: ["get", "url"],
      receipt: false,
      tabId: 3,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "https://example.test/items/20\n");
    assert.equal(result.stderr, "");
    assert.deepEqual(readJsonLines(callsFile), [
      ["--session", "terminal-browser-browser-1", "--cdp", "9222", "tab", "list", "--json"],
      ["--session", "terminal-browser-browser-1", "--cdp", "9222", "tab", "t3"],
      ["--session", "terminal-browser-browser-1", "--cdp", "9222", "get", "url"],
    ]);
  });

  await t.test("adds tab context after preserving an Unknown ref failure", async () => {
    reset();
    const result = await runAction({
      browserKey: "browser-1",
      follow: false,
      passthrough: ["click", "@e999"],
      receipt: false,
      tabId: 3,
    });
    assert.equal(result.code, 7);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^✗ Unknown ref: e999/m);
    assert.match(
      result.stderr,
      /browser browser-1, tab 3, target target-3, url https:\/\/example\.test\/items\/20, exit 7/,
    );
    assert.match(result.stderr, /take a fresh snapshot/i);
  });
});

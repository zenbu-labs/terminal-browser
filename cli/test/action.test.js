const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("keeps every agent-browser command attached to the terminal browser CDP endpoint", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-action-"));
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  process.env.XDG_RUNTIME_DIR = path.join(root, "runtime");

  const callsFile = path.join(root, "agent-calls.jsonl");
  const agent = path.join(root, "agent-browser");
  fs.writeFileSync(
    agent,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ACTION_CALLS_FILE, JSON.stringify(args) + "\\n");
if (args.includes("list")) {
  process.stdout.write(JSON.stringify({ data: { tabs: [{ active: true, tabId: "t1", title: "GitHub", url: "https://github.com/example/repo" }] } }));
}
`,
  );
  fs.chmodSync(agent, 0o755);
  process.env.ACTION_CALLS_FILE = callsFile;
  process.env.TERMINAL_BROWSER_AGENT = agent;

  const socket = path.join(root, "browser.sock");
  const server = net.createServer((connection) => {
    connection.setEncoding("utf8");
    connection.once("data", (chunk) => {
      const request = JSON.parse(chunk.trim());
      const data =
        request.cmd === "where"
          ? { pane: null, tab: null, terminal: null }
          : {
              tabs: [
                {
                  active: true,
                  id: 1,
                  targetId: "page-target",
                  timeOrigin: 1,
                  title: "GitHub",
                  url: "https://github.com/example/repo",
                },
              ],
            };
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
  const { actionCommand } = require("../dist/action");
  await upsertInstance({
    cdpPort: 9222,
    key: "browser-1",
    pid: process.pid,
    socket,
    startedAt: Date.now(),
    url: "https://github.com/example/repo",
  });

  assert.equal(
    await actionCommand(null, {
      browserKey: "browser-1",
      follow: false,
      passthrough: ["eval", "location.href"],
      tabId: 1,
    }),
    0,
  );

  const calls = fs
    .readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls, [
    ["--session", "terminal-browser-browser-1", "--cdp", "9222", "tab", "list", "--json"],
    ["--session", "terminal-browser-browser-1", "--cdp", "9222", "eval", "location.href"],
  ]);
});

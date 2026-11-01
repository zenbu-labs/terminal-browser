const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { listenPrivately, privateServer } = require("@zenbu-labs/pixel/private-socket");

const CLI = path.join(__dirname, "..", "dist", "main.js");

function isolatedEnv(root) {
  const env = { ...process.env, HOME: path.join(root, "home"), PIXEL_TTY: "/dev/null", PIXEL_EMBED: path.join(root, "embed.sock") };
  for (const name of ["DATA", "STATE", "CACHE", "CONFIG"]) env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase());
  env.XDG_RUNTIME_DIR = path.join(root, "run");
  for (const name of Object.keys(env)) if (name.startsWith("TERMINAL_BROWSER_AGENT")) delete env[name];
  return env;
}

function daemonSocket(env) {
  const script = 'console.log(require("shared").DAEMON_SOCKET)';
  return require("node:child_process")
    .execFileSync(process.execPath, ["--no-warnings", "-e", script], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" })
    .trim();
}

test("the bridge token reaches the daemon as its own field over the private socket, never in the copied environment", async (t) => {
  const root = fs.mkdtempSync("/tmp/tb-open-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...isolatedEnv(root), TERMINAL_BROWSER_AGENT_BRIDGE: "http://127.0.0.1:1", TERMINAL_BROWSER_AGENT_TOKEN_ON_STDIN: "1" };
  const token = "ab".repeat(24);
  const received = new Promise((resolve) => {
    const server = privateServer((connection) => {
      let buffer = "";
      connection.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
        connection.end(`${JSON.stringify({ ok: false, error: "test daemon" })}\n`);
        server.close();
      });
    });
    listenPrivately(server, daemonSocket(env));
  });
  const cli = spawn(process.execPath, ["--no-warnings", CLI, "open", "about:blank"], { env, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => cli.kill());
  cli.stdin.end(`${token}\n`);
  const open = await received;
  assert.equal(open.cmd, "open");
  assert.equal(open.agentToken, token);
  assert.doesNotMatch(JSON.stringify(open.env), new RegExp(token));
});

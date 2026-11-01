const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");

function socketsWith(runtime) {
  const env = { ...process.env, XDG_STATE_HOME: "/tmp/state-home" };
  if (runtime === undefined) delete env.XDG_RUNTIME_DIR;
  else env.XDG_RUNTIME_DIR = runtime;
  const script = 'const p = require("./dist/paths.js"); console.log(JSON.stringify([p.CDP_SOCKET, p.DAEMON_SOCKET, p.AGENT_SOCKETS_DIR]))';
  return JSON.parse(execFileSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" }));
}

test("an empty or relative XDG_RUNTIME_DIR falls back to the state directory", () => {
  for (const runtime of [undefined, "", "relative/run", "./run"]) {
    for (const socket of socketsWith(runtime)) {
      assert.ok(path.isAbsolute(socket), `${JSON.stringify(runtime)} gave ${socket}`);
      assert.ok(socket.startsWith("/tmp/state-home/"), socket);
    }
  }
});

test("an absolute XDG_RUNTIME_DIR is used", () => {
  for (const socket of socketsWith("/tmp/run-home")) assert.ok(socket.startsWith("/tmp/run-home/"), socket);
});

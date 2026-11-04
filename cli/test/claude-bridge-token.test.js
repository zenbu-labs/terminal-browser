const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const CLI = path.join(__dirname, "..", "dist", "main.js");

function isolated(t) {
  const root = fs.mkdtempSync("/tmp/tb-bridge-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(root, "home"), XDG_RUNTIME_DIR: path.join(root, "run") };
  for (const name of ["DATA", "STATE", "CACHE", "CONFIG"]) env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase());
  return { root, env };
}

function request(socketPath, pathname, headers = {}) {
  return new Promise((resolve) => {
    const req = require("node:http").request({ socketPath, path: pathname, headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

test("the bridge listens on a private Unix socket, never TCP, and the token stays out of argv", async (t) => {
  const { env } = isolated(t);
  const launched = spawnSync(process.execPath, ["--no-warnings", CLI, "claude-bridge", "launch", "--tty", "/dev/null"], {
    encoding: "utf8",
    env,
  });
  const report = JSON.parse(launched.stdout);
  const { pid, socket, token } = report;
  assert.equal(report.port, undefined);
  t.after(() => {
    try {
      process.kill(pid);
    } catch {}
  });
  const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  assert.match(command, /claude-bridge serve/);
  assert.doesNotMatch(command, new RegExp(token));
  // SIGUSR1 would otherwise make this long-lived CLI process open a debugger on 127.0.0.1:9229.
  process.kill(pid, "SIGUSR1");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const tcp = spawnSync("lsof", ["-a", "-p", String(pid), "-iTCP", "-nP"], { encoding: "utf8" }).stdout.trim();
  assert.equal(tcp, "", "the bridge holds no TCP socket, even after SIGUSR1");
  assert.match(path.dirname(socket), /\/bridge$/);
  assert.equal(fs.statSync(path.dirname(socket)).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(socket).mode & 0o777, 0o600);
  assert.equal(socket, fs.realpathSync(socket));
  assert.equal(await request(socket, "/state?version=-1"), 401);
  assert.equal(await request(socket, "/state?version=-1", { authorization: "Bearer wrong" }), 401);
  assert.equal(await request(socket, "/state?version=-1", { authorization: `Bearer ${token}` }), 200);

  const idle = [];
  for (let i = 0; i < 80; i++) {
    const connection = require("node:net").connect(socket);
    connection.on("error", () => {});
    idle.push(new Promise((resolve) => connection.on("close", () => resolve(true))));
  }
  const closed = await Promise.all(idle.map((done) => Promise.race([done, new Promise((r) => setTimeout(() => r(false), 500))])));
  assert.ok(closed.filter(Boolean).length >= 16, `only ${closed.filter(Boolean).length} of 80 over-cap connections were turned away`);
});

test("claude-bridge serve refuses a socket outside its own folder and leaves that folder alone", async (t) => {
  const { root, env } = isolated(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project, { mode: 0o755 });
  fs.writeFileSync(path.join(project, "keep.txt"), "mine");
  const serve = spawn(process.execPath, ["--no-warnings", CLI, "claude-bridge", "serve", "--tty", "/dev/null", "--socket", path.join(project, "x.sock")], {
    env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  serve.stdin.end(`${"ab".repeat(24)}\n`);
  const code = await new Promise((resolve) => serve.on("exit", resolve));
  assert.equal(code, 2);
  assert.equal(fs.readFileSync(path.join(project, "keep.txt"), "utf8"), "mine");
  assert.equal(fs.statSync(project).mode & 0o777, 0o755);
});

test("the release wrapper runs the CLI with --disable-sigusr1 and the release checks the inspector fuses", () => {
  const release = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "release.sh"), "utf8");
  assert.match(release, /exec "\\\$ROOT\/\$ELECTRON_EXE" --disable-sigusr1 /);
  assert.match(release, /EnableNodeCliInspectArguments is Disabled/);
  assert.match(release, /EnableNodeOptionsEnvironmentVariable is Disabled/);
});

test("the bridge refuses a request body over its cap instead of buffering it", async (t) => {
  const { env } = isolated(t);
  const launched = spawnSync(process.execPath, ["--no-warnings", CLI, "claude-bridge", "launch", "--tty", "/dev/null"], { encoding: "utf8", env });
  const { pid, socket, token } = JSON.parse(launched.stdout);
  t.after(() => {
    try {
      process.kill(pid);
    } catch {}
  });
  const status = await new Promise((resolve) => {
    const req = require("node:http").request(
      { socketPath: socket, path: "/input", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on("error", () => resolve("closed"));
    req.end(JSON.stringify({ events: ["x".repeat(4 * 1024 * 1024)] }));
  });
  assert.ok(status === 413 || status === "closed", `got ${status}`);
  assert.ok(process.kill(pid, 0), "the bridge is still running");
});

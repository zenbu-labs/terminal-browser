const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

async function herdrSession(t, graphics) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-"));
  const socketPath = path.join(dir, "h.sock");
  const configPath = path.join(dir, "config.toml");
  const callsPath = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "herdr");
  fs.writeFileSync(configPath, "[experimental]\nkitty_graphics = true\n");
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.HERDR_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stderr.write("browser split requested\\n");
process.exit(42);
`, { mode: 0o755 });
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      requests.push(JSON.parse(buffer.split("\n")[0]));
      socket.end(JSON.stringify(graphics) + "\n");
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    requests,
    calls: () => fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse) : [],
    run: (args, extraEnv = {}) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "../dist/main.js"), ...args], {
        env: {
          PATH: process.env.PATH,
          XDG_STATE_HOME: dir,
          XDG_DATA_HOME: dir,
          XDG_CACHE_HOME: dir,
          XDG_RUNTIME_DIR: dir,
          HERDR_PANE_ID: "w1:p1",
          HERDR_TAB_ID: "w1:t1",
          HERDR_CONFIG_PATH: configPath,
          HERDR_SOCKET_PATH: socketPath,
          HERDR_BIN_PATH: bin,
          HERDR_TEST_CALLS: callsPath,
          TERMINAL_BROWSER_NO_MERGE: "1",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("CLI did not exit"));
      }, 5000);
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout, stderr });
      });
    }),
  };
}

const NO_CELL_SIZE = { error: { code: "cell_size_unavailable", message: "host cell size is unavailable" } };

for (const args of [["open", "https://example.com", "--split", "right"], ["new-tab", "https://example.com"]]) {
  test(`${args[0]} explains reattachment before creating a blank browser pane`, async (t) => {
    const session = await herdrSession(t, NO_CELL_SIZE);
    const result = await session.run(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /host cell size is unavailable/);
    assert.match(result.stderr, /Ctrl\+B.*Q/);
    assert.deepEqual(session.calls(), []);
    assert.equal(session.requests[0].method, "pane.graphics.info");
  });
}

test("open proceeds to the requested split when Herdr graphics is ready", async (t) => {
  const session = await herdrSession(t, { result: {
    file_frame_transport: "direct-kitty",
    file_frame_directory: "/tmp/frames",
    cell_width_px: 16,
    cell_height_px: 34,
  } });
  const result = await session.run(["open", "https://example.com", "--split", "right"]);
  assert.match(result.stderr, /browser split requested/);
  assert.equal(session.requests[0].method, "pane.graphics.info");
  assert.deepEqual(session.calls()[0], ["pane", "split", "--pane", "w1:p1", "--direction", "right", "--focus", "--right-click", "pane"]);
});

test("ls stays available when the attached client cannot display graphics", async (t) => {
  const session = await herdrSession(t, NO_CELL_SIZE);
  const result = await session.run(["ls", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).browsers, []);
  assert.deepEqual(session.requests, []);
});

test("the explicit graphics-check override still allows a launch attempt", async (t) => {
  const session = await herdrSession(t, NO_CELL_SIZE);
  const result = await session.run(["open", "https://example.com", "--split", "right"], {
    TERMINAL_BROWSER_SKIP_GRAPHICS_CHECK: "1",
  });
  assert.match(result.stderr, /browser split requested/);
  assert.deepEqual(session.requests, []);
});

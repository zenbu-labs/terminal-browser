const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const { transferToLocalRendering, handleLocalRendering } = require("@zenbu-labs/pixel/pair");

const FRONTEND = `
const net = require("node:net");
const stream = require(${JSON.stringify(require.resolve("@zenbu-labs/pixel/pair").replace(/pair[\\/]index\.js$/, "terminal/stream.js"))});
const out = net.connect(process.env.PIXEL_TERMINAL_STREAM, () => {
  if (process.env.MODE === "graceful") return process.on("SIGTERM", () => out.end("torn down", () => process.exit(0)));
  if (process.env.MODE === "hang") return;
  const big = Number(process.env.BIG || 0);
  if (big) out.write(Buffer.alloc(big, 120));
  out.write(JSON.stringify({ meta: JSON.parse(process.env.META), args: process.argv.slice(2), terminal: stream.terminalFromEnv(), inherited: process.env.TERM ?? null }), () => process.exit(Number(process.env.EXIT_CODE) || 0));
});
`;

const RESET = "\x1b_Ga=d,d=A";

const ENV = { TERM: "xterm-ghostty", NODE_OPTIONS: "--require /tmp/nope.js" };

function pty() {
  const holder = spawn("python3", [path.join(__dirname, "pty-holder.py")], { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = Buffer.alloc(0);
  let device = null;
  const ready = new Promise((resolve) => {
    holder.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (device) return;
      const end = buffer.indexOf(10);
      if (end < 0) return;
      device = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 1);
      resolve(device);
    });
  });
  return { ready, written: () => buffer.toString("latin1"), close: () => holder.stdin.end() };
}

function connection() {
  const ends = { remote: null, screen: null };
  const deliver = (to) => (message) => {
    const copy = Uint8Array.from(message);
    setImmediate(() => ends[to]?.receive(copy));
  };
  return { ends, toScreen: deliver("screen"), toRemote: deliver("remote") };
}

async function rig({ env = {}, start, signal } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pair-rig-"));
  const frontend = path.join(base, "frontend.js");
  fs.writeFileSync(frontend, FRONTEND);
  const c = connection();
  const terminal = pty();
  const device = await terminal.ready;
  c.ends.screen = handleLocalRendering({
    send: c.toRemote,
    start: start ?? ((launch) => ({ command: process.execPath, args: [frontend, ...launch.args], env: { ...env, META: JSON.stringify(launch.meta) } })),
  });
  c.ends.remote = transferToLocalRendering({ send: c.toScreen, tty: device, env: ENV, signal, args: ["--open", "x.db"], meta: { machine: "remote" } });
  return {
    c,
    result: c.ends.remote.done.then(async (result) => {
      for (let i = 0; i < 100 && !terminal.written().includes('{"meta"'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const written = terminal.written();
      terminal.close();
      const at = written.indexOf('{"meta"');
      return { result, written, report: at >= 0 ? JSON.parse(written.slice(at).split("\x1b")[0]) : null };
    }),
  };
}

test("transferToLocalRendering and handleLocalRendering render on the other side with nothing but send and receive", async () => {
  const r = await rig();
  const { result, report, written } = await r.result;
  assert.deepEqual(result, { started: true, code: 0, lost: false });
  assert.ok(!written.includes(RESET));
  assert.deepEqual(report, {
    meta: { machine: "remote" },
    args: ["--open", "x.db"],
    terminal: { TERM: "xterm-ghostty", PIXEL_TERMINAL_FEATURES: "local-terminal" },
    inherited: process.env.TERM ?? null,
  });
  await r.c.ends.screen.closed;
});

test("output past the window waits for acks and all of it arrives", async () => {
  const r = await rig({ env: { BIG: String(9 * 1024 * 1024) } });
  const { result, written, report } = await r.result;
  assert.deepEqual(result, { started: true, code: 0, lost: false });
  assert.equal(written.indexOf('{"meta"'), 9 * 1024 * 1024);
  assert.equal(report.meta.machine, "remote");
});

test("the frontend's exit code comes back, and a failing exit resets the terminal", async () => {
  const r = await rig({ env: { EXIT_CODE: "3" } });
  const { result, written } = await r.result;
  assert.deepEqual(result, { started: true, code: 3, lost: false });
  assert.ok(written.includes(RESET));
});

test("disconnected after the frontend started reports lost, and the screen side stops it", async () => {
  const r = await rig({ env: { MODE: "hang" } });
  setTimeout(() => {
    r.c.ends.screen.disconnected();
    r.c.ends.remote.disconnected();
  }, 1500);
  assert.deepEqual((await r.result).result, { started: true, code: 1, lost: true });
  await r.c.ends.screen.closed;
});

test("disconnected before the frontend starts", async () => {
  const terminal = pty();
  const remote = transferToLocalRendering({ send: () => {}, tty: await terminal.ready });
  remote.disconnected();
  assert.deepEqual(await remote.done, { started: false, error: { kind: "disconnected" } });
  terminal.close();
});

test("without a tty there's no terminal to transfer", async () => {
  const remote = transferToLocalRendering({ send: () => {}, tty: "/dev/null" });
  assert.deepEqual(await remote.done, { started: false, error: { kind: "noTerminal" } });
});

test("protocol ranges that don't overlap are refused, naming the older side", async () => {
  const c = connection();
  c.ends.screen = handleLocalRendering({ send: c.toRemote, start: () => assert.fail("must not start") });
  const terminal = pty();
  const device = await terminal.ready;
  process.env.PIXEL_PAIR_PROTOCOL = "0-0";
  c.ends.remote = transferToLocalRendering({ send: c.toScreen, tty: device });
  delete process.env.PIXEL_PAIR_PROTOCOL;
  const result = await c.ends.remote.done;
  assert.equal(result.started, false);
  assert.equal(result.error.kind, "protocol");
  assert.equal(result.error.older, "remote");
  terminal.close();
});

test("the screen side keeps only terminal variables from what the remote describes, as data, not environment", async () => {
  let launched = null;
  const screen = handleLocalRendering({
    send: () => {},
    start: (launch) => {
      launched = launch;
      return { pid: 1, stop() {}, exited: new Promise(() => {}) };
    },
  });
  const hello = {
    type: "hello",
    protocol: [1, 1],
    session: "s",
    terminal: { cols: 80, rows: 24, env: { TERM: "xterm-ghostty", NODE_OPTIONS: "--require /tmp/nope.js", DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", KITTY_WINDOW_ID: "3" } },
    args: [],
    meta: null,
  };
  screen.receive(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(hello))]));
  for (let i = 0; i < 50 && !launched; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(launched);
  assert.deepEqual(Object.keys(launched.env).sort(), ["PIXEL_TERMINAL_ENV", "PIXEL_TERMINAL_SIZE", "PIXEL_TERMINAL_STREAM"]);
  assert.deepEqual(JSON.parse(launched.env.PIXEL_TERMINAL_ENV), { TERM: "xterm-ghostty", PIXEL_TERMINAL_FEATURES: "local-terminal" });
  screen.stop();
});

test("cancelling stops the app gracefully, and its own teardown reaches the terminal without a reset", async () => {
  const cancel = new AbortController();
  const r = await rig({ env: { MODE: "graceful" }, signal: cancel.signal });
  setTimeout(() => cancel.abort(), 1500);
  const { result, written } = await r.result;
  assert.deepEqual(result, { started: true, code: 0, lost: false });
  assert.ok(written.includes("torn down"));
  assert.ok(!written.includes(RESET));
  await r.c.ends.screen.closed;
});

test("cancelling an app that dies without tearing down resets the terminal", async () => {
  const cancel = new AbortController();
  const r = await rig({ env: { MODE: "hang" }, signal: cancel.signal });
  setTimeout(() => cancel.abort(), 1500);
  const { result, written } = await r.result;
  assert.equal(result.started, true);
  assert.notEqual(result.code, 0);
  assert.ok(written.includes(RESET));
  await r.c.ends.screen.closed;
});

test("cancelling before the app starts drawing", async () => {
  const cancel = new AbortController();
  const terminal = pty();
  const remote = transferToLocalRendering({ send: () => {}, tty: await terminal.ready, signal: cancel.signal });
  cancel.abort();
  assert.deepEqual(await remote.done, { started: false, error: { kind: "cancelled" } });
  terminal.close();
});

test("a program that doesn't exist is refused, and the screen side keeps running", async () => {
  const r = await rig({ start: () => ({ command: "/nonexistent/pixel-app", args: [] }) });
  assert.deepEqual((await r.result).result, { started: false, error: { kind: "refused", message: "the app exited with code 127 before it started" } });
});

test("an app that exits before it starts drawing is refused, not started", async () => {
  const r = await rig({ start: () => ({ command: process.execPath, args: ["-e", "process.exit(3)"] }) });
  assert.deepEqual((await r.result).result, { started: false, error: { kind: "refused", message: "the app exited with code 3 before it started" } });
});

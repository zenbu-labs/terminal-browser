const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");

const { attach, host } = require("@zenbu-labs/pixel/pair");

const FRONTEND = `
const net = require("node:net");
const pair = require(${JSON.stringify(require.resolve("@zenbu-labs/pixel/pair"))});
const stream = require(${JSON.stringify(require.resolve("@zenbu-labs/pixel/pair").replace(/pair[\\/]index\.js$/, "terminal/stream.js"))});
const out = net.connect(process.env.PIXEL_TERMINAL_STREAM, () => {
  if (process.env.MODE === "hang") return;
  const big = Number(process.env.BIG || 0);
  if (big) out.write(Buffer.alloc(big, 120));
  out.write(JSON.stringify({ meta: pair.paired().meta, args: process.argv.slice(2), terminal: stream.terminalFromEnv(), inherited: process.env.TERM ?? null }), () => process.exit(Number(process.env.EXIT_CODE) || 0));
});
`;

const fakeTerminal = (output = new PassThrough()) => ({ input: new PassThrough(), output, size: () => ({ cols: 80, rows: 24 }), onResize: () => () => {}, env: { TERM: "xterm-ghostty", NODE_OPTIONS: "--require /tmp/nope.js" } });

function connection() {
  const ends = { remote: null, screen: null };
  const deliver = (to) => (message) => {
    const copy = Uint8Array.from(message);
    setImmediate(() => ends[to]?.receive(copy));
  };
  return { ends, toScreen: deliver("screen"), toRemote: deliver("remote") };
}

function rig({ env = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pair-rig-"));
  const frontend = path.join(base, "frontend.js");
  fs.writeFileSync(frontend, FRONTEND);
  const c = connection();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => (written += chunk));
  c.ends.screen = host({ send: c.toRemote, start: (launch) => ({ command: process.execPath, args: [frontend, ...launch.args], env }) });
  c.ends.remote = attach({ send: c.toScreen, args: ["--open", "x.db"], meta: { machine: "remote" }, terminal: fakeTerminal(output) });
  return {
    c,
    result: c.ends.remote.done.then((result) => {
      const at = written.indexOf('{"meta"');
      return { result, written, report: at >= 0 ? JSON.parse(written.slice(at).split("\x1b")[0]) : null };
    }),
  };
}

test("attach and host run the frontend with nothing but send and receive", async () => {
  const r = rig();
  const { result, report } = await r.result;
  assert.deepEqual(result, { started: true, code: 0, lost: false });
  assert.deepEqual(report, {
    meta: { machine: "remote" },
    args: ["--open", "x.db"],
    terminal: { TERM: "xterm-ghostty", PIXEL_TERMINAL_FEATURES: "local-terminal" },
    inherited: process.env.TERM ?? null,
  });
  await r.c.ends.screen.closed;
});

test("output past the window waits for acks and all of it arrives", async () => {
  const r = rig({ env: { BIG: String(9 * 1024 * 1024) } });
  const { result, written, report } = await r.result;
  assert.deepEqual(result, { started: true, code: 0, lost: false });
  assert.equal(written.indexOf('{"meta"'), 9 * 1024 * 1024);
  assert.equal(report.meta.machine, "remote");
});

test("the frontend's exit code comes back", async () => {
  const r = rig({ env: { EXIT_CODE: "3" } });
  assert.deepEqual((await r.result).result, { started: true, code: 3, lost: false });
});

test("disconnected after the frontend started reports lost, and the screen side stops it", async () => {
  const r = rig({ env: { MODE: "hang" } });
  setTimeout(() => {
    r.c.ends.screen.disconnected();
    r.c.ends.remote.disconnected();
  }, 1500);
  assert.deepEqual((await r.result).result, { started: true, code: 1, lost: true });
  await r.c.ends.screen.closed;
});

test("disconnected before the frontend starts", async () => {
  const remote = attach({ send: () => {}, terminal: fakeTerminal() });
  remote.disconnected();
  assert.deepEqual(await remote.done, { started: false, error: { kind: "disconnected" } });
});

test("protocol ranges that don't overlap are refused, naming the older side", async () => {
  const c = connection();
  c.ends.screen = host({ send: c.toRemote, start: () => assert.fail("must not start") });
  process.env.PIXEL_PAIR_PROTOCOL = "1-1";
  c.ends.remote = attach({ send: c.toScreen, terminal: fakeTerminal() });
  delete process.env.PIXEL_PAIR_PROTOCOL;
  const result = await c.ends.remote.done;
  assert.equal(result.started, false);
  assert.equal(result.error.kind, "protocol");
  assert.equal(result.error.older, "remote");
});

test("the screen side keeps only terminal variables from what the remote describes, as data, not environment", async () => {
  let launched = null;
  const screen = host({
    send: () => {},
    start: (launch) => {
      launched = launch;
      return { pid: 1, stop() {}, exited: new Promise(() => {}) };
    },
  });
  const hello = {
    type: "hello",
    protocol: [5, 5],
    session: "s",
    terminal: { cols: 80, rows: 24, env: { TERM: "xterm-ghostty", NODE_OPTIONS: "--require /tmp/nope.js", DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", KITTY_WINDOW_ID: "3" } },
    args: [],
    meta: null,
  };
  screen.receive(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(hello))]));
  for (let i = 0; i < 50 && !launched; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(launched);
  assert.deepEqual(Object.keys(launched.env).sort(), ["PIXEL_PAIRED", "PIXEL_TERMINAL_ENV", "PIXEL_TERMINAL_SIZE", "PIXEL_TERMINAL_STREAM"]);
  assert.deepEqual(JSON.parse(launched.env.PIXEL_TERMINAL_ENV), { TERM: "xterm-ghostty", PIXEL_TERMINAL_FEATURES: "local-terminal" });
  screen.stop();
});

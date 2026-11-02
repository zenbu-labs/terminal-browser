const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");
const { test } = require("node:test");

// The checks run in a child process, because a regex that backtracks forever
// would freeze this one before any timeout could fire.
async function child() {
  const records = new Map();
  const manager = {
    determiner: null,
    created: { add() {} },
    changed: { add() {} },
    erased: { add() {} },
    get: (id) => records.get(id) ?? null,
    list: () => [...records.values()],
    canResume: () => false,
    remainingMs: () => null,
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return { app: { on() {}, getPath: () => "/tmp" }, ipcMain: { handle() {}, on() {} }, webContents: { getAllWebContents: () => [] }, session: {}, shell: {} };
    if (request === "shared") return {};
    if (request === "../../browsing") return { browsing: () => ({ downloads: manager }) };
    if (request === "../action") return { extensionIcon: () => null };
    return load.call(this, request, ...rest);
  };
  const { installDownloads } = require("../dist/extensions/api/downloads.js");
  const handlers = new Map();
  installDownloads({
    loaded: new Map(),
    router: { handle: (name, run) => handlers.set(name, run) },
    events: { hasListener: () => false, listenerRemoved: { add() {} } },
    broadcast() {},
    dispatch() {},
    get: () => null,
  });
  const add = (id, url) =>
    records.set(id, { id, url, finalUrl: url, filename: `/tmp/f${id}`, mime: "", startTime: id, endTime: null, state: "complete", error: null, paused: false, totalBytes: 0, receivedBytes: 0, byExtensionId: null });
  add(1, `https://attacker.example/${"a".repeat(40)}!`);
  add(2, "https://ATTACKER.example/x");
  const caller = { kind: "worker", extension: { id: "x", hadRecentUserGesture: () => false, hasApiPermission: () => true } };
  const search = (query) =>
    Promise.resolve(handlers.get("downloads.search")(caller, query)).then(
      (items) => items.map((item) => item.id),
      (error) => error.message,
    );
  const out = {};
  out.catastrophic = await search({ urlRegex: "^https://attacker\\.example/(a+)+$" });
  out.re2Syntax = await search({ urlRegex: "(?i)^https://attacker\\.example/x$" });
  out.lookahead = await search({ urlRegex: "(?=https)" });
  out.backreference = await search({ urlRegex: "(a)\\1" });
  add(3, `https://big.example/${"abc".repeat(700_000)}`);
  let ticks = 0;
  const ticking = setInterval(() => ticks++, 50);
  const started = Date.now();
  out.slow = await search({ urlRegex: "(?:[a-c]{1,50}){1,20}[0-9]" });
  out.slowMs = Date.now() - started;
  clearInterval(ticking);
  out.ticks = ticks;
  out.afterSlow = await search({ filenameRegex: "f2$" });
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

if (process.argv[2] === "child") {
  void child();
} else {
  test("downloads.search regexes use Chrome's RE2 rules and can't freeze the main thread", () => {
    const run = spawnSync(process.execPath, [__filename, "child"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(run.signal, null, "the search hung");
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual(out.catastrophic, []);
    assert.deepEqual(out.re2Syntax, [2]);
    assert.equal(out.lookahead, "Invalid query filter");
    assert.equal(out.backreference, "Invalid query filter");
    assert.equal(out.slow, "Invalid query filter");
    assert.ok(out.slowMs < 10_000, `took ${out.slowMs}ms`);
    assert.ok(out.ticks >= 10, `main thread only ticked ${out.ticks} times`);
    assert.deepEqual(out.afterSlow, [2]);
  });
}

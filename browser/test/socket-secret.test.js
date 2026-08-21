const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { promisify } = require("node:util");

const run = promisify(execFile);
const BROWSER_DIR = path.dirname(__dirname);
const SHAPE = /^[0-9a-f]{64}$/;
const MINT = "return secret.loadOrCreateSocketSecret();";

/**
 * The secret's path is fixed when pixel-store loads, so every case runs in child processes with
 * their own XDG_RUNTIME_DIR: that is the only way to get a first-launch install per test, and
 * separate processes are what actually race for the file.
 */
async function child(body, runtimeDir, env = {}) {
  const source = `
    const secret = require(${JSON.stringify(path.join(BROWSER_DIR, "dist/socket-secret.js"))});
    const store = require("pixel-store");
    const answer = (() => { ${body} })();
    process.stdout.write(JSON.stringify({ answer, file: store.SOCKET_SECRET_FILE }));
  `;
  const { stdout } = await run(process.execPath, ["-e", source], {
    cwd: BROWSER_DIR,
    encoding: "utf8",
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir, ...env },
  });
  return JSON.parse(stdout);
}

const installs = [];
after(() => {
  for (const dir of installs) fs.rmSync(dir, { recursive: true, force: true });
});

function freshInstall(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tb-secret-${name}-`));
  installs.push(dir);
  return dir;
}

test("a second mint cannot replace the secret already on disk", async () => {
  const runtime = freshInstall("no-clobber");
  const first = await child(MINT, runtime);
  assert.match(first.answer, SHAPE);

  // What the losing daemon does: mint a value of its own and try to store it. The winner's
  // secret is the one the running daemon authenticates with, so it has to survive.
  const second = await child(
    `store.writeSocketControlSecret("b".repeat(64)); return store.readSocketControlSecret();`,
    runtime,
  );
  assert.equal(second.answer, first.answer);
  assert.equal(fs.readFileSync(first.file, "utf8"), first.answer);
});

test("daemons minting at the same instant agree on one secret", async () => {
  const runtime = freshInstall("race");
  // Long enough for six node processes to load pixel-store before the gun goes off, because a
  // child that arrives late reads the secret already there and proves nothing.
  const at = Date.now() + 3000;
  const body = `
    const at = Number(process.env.TB_MINT_AT);
    const gate = new Int32Array(new SharedArrayBuffer(4));
    for (let left = at - Date.now(); left > 2; left = at - Date.now()) {
      Atomics.wait(gate, 0, 0, left - 2);
    }
    while (Date.now() < at) {}
    const startedAt = Date.now();
    return { secret: secret.loadOrCreateSocketSecret(), offset: startedAt - at };
  `;
  const settled = await Promise.all(
    Array.from({ length: 6 }, () => child(body, runtime, { TB_MINT_AT: String(at) })),
  );

  const late = settled.filter((row) => row.answer.offset > 500);
  assert.deepEqual(
    late.map((row) => row.answer.offset),
    [],
    "children did not reach the gate together, so nothing raced and this test proved nothing",
  );
  for (const row of settled) assert.match(row.answer.secret, SHAPE);
  const distinct = new Set(settled.map((row) => row.answer.secret));
  assert.deepEqual([...distinct], [fs.readFileSync(settled[0].file, "utf8")]);
});

test("a secret nothing can authenticate with is replaced, not kept", async () => {
  const runtime = freshInstall("corrupt");
  const probe = await child("return null;", runtime);
  fs.mkdirSync(path.dirname(probe.file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probe.file, "not-a-secret");

  const minted = await child(MINT, runtime);
  assert.match(minted.answer, SHAPE);
  assert.equal(fs.readFileSync(minted.file, "utf8"), minted.answer);
});

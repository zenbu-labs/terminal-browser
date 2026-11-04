const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const SHARED = path.resolve(__dirname, "..", "dist", "index.js");
const PRE_EXTENSIONS = "0003_secret_stark_industries";

function profile(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-private-state-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  delete env.XDG_RUNTIME_DIR;
  delete env.TERMINAL_BROWSER_CONFIG_DIR;
  return { root, env };
}

// Runs `body` in a fresh process with umask 000, so paths and umask are those of a new start.
function run(env, body) {
  const script = `
    process.umask(0);
    const fs = require("node:fs");
    const path = require("node:path");
    const shared = require(${JSON.stringify(SHARED)});
    const out = (value) => process.stdout.write(JSON.stringify(value));
    ${body}
  `;
  const result = spawnSync(process.execPath, ["--no-warnings", "-e", script], { env, encoding: "utf8" });
  return { ...result, json: () => JSON.parse(result.stdout) };
}

const PATHS = `out({ data: shared.DATA_DIR, logs: shared.LOGS_DIR, config: shared.CONFIG_DIR, db: shared.DB_FILE, settings: shared.SETTINGS_FILE });`;

function mode(file) {
  return (fs.lstatSync(file).mode & 0o777).toString(8);
}

function oldDatabase(env, umask = 0) {
  const made = run(
    env,
    `
    process.umask(${umask});
    const { DatabaseSync } = require("node:sqlite");
    const { migrate } = require(${JSON.stringify(path.resolve(__dirname, "..", "dist", "migrate.js"))});
    const { migrations } = require(${JSON.stringify(path.resolve(__dirname, "..", "dist", "migrations.gen.js"))});
    fs.mkdirSync(shared.DATA_DIR, { recursive: true });
    const sqlite = new DatabaseSync(shared.DB_FILE);
    sqlite.exec("PRAGMA journal_mode = WAL");
    const old = migrations.findIndex((m) => m.id === ${JSON.stringify(PRE_EXTENSIONS)});
    migrate(sqlite, migrations.slice(0, old + 1));
    sqlite.close();
  `,
  );
  assert.equal(made.status, 0, made.stderr);
}

const DATA_MODES = `
  const modes = (dir) => Object.fromEntries(fs.readdirSync(dir).map((name) => [name, (fs.lstatSync(path.join(dir, name)).mode & 0o777).toString(8)]));
`;

test("a fresh profile under umask 000 gets 0700 folders and a 0600 database, WAL, SHM and settings", (t) => {
  const { env } = profile(t);
  const started = run(
    env,
    `
    ${DATA_MODES}
    const { sqlite } = shared.openStore();
    sqlite.exec("INSERT INTO history_urls (url, title, visit_count, typed_count, last_visit_time) VALUES ('https://example.com/?token=1', 'x', 1, 0, 1)");
    new shared.ConfigStore({ settings: shared.SETTINGS_FILE, shortcuts: shared.SHORTCUTS_FILE }).setSetting("telemetry.crashReports", "off");
    out({ data: modes(shared.DATA_DIR), paths: { data: shared.DATA_DIR, config: shared.CONFIG_DIR, settings: shared.SETTINGS_FILE } });
  `,
  );
  assert.equal(started.status, 0, started.stderr);
  const { data, paths } = started.json();
  assert.equal(mode(paths.data), "700");
  assert.equal(mode(paths.config), "700");
  assert.equal(mode(paths.settings), "600");
  assert.deepEqual(data, {
    install: "600",
    "terminal-browser.db": "600",
    "terminal-browser.db-shm": "600",
    "terminal-browser.db-wal": "600",
  });
});

test("the backup taken before a migration under umask 000 is 0600", (t) => {
  const { env } = profile(t);
  oldDatabase(env, 0o077);
  const started = run(env, `${DATA_MODES} shared.openStore(); out(modes(shared.DATA_DIR));`);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(started.json(), {
    install: "600",
    "terminal-browser.db": "600",
    "terminal-browser.db-shm": "600",
    "terminal-browser.db-wal": "600",
    [`terminal-browser.db.bak-${PRE_EXTENSIONS}`]: "600",
  });
});

test("an install made with a loose umask is tightened on the next start", (t) => {
  const { env } = profile(t);
  for (const home of [env.XDG_DATA_HOME, env.XDG_STATE_HOME]) fs.mkdirSync(home, { mode: 0o755 });
  const paths = run(env, PATHS).json();
  oldDatabase(env);
  const opened = run(env, `shared.openStore(); ${PATHS}`);
  assert.equal(opened.status, 0, opened.stderr);
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.writeFileSync(path.join(paths.logs, "chromium.log"), "log");
  fs.mkdirSync(paths.config, { recursive: true });
  fs.writeFileSync(paths.settings, "{}\n");
  const loose = [
    [paths.data, 0o775],
    [paths.logs, 0o755],
    [path.dirname(paths.logs), 0o755],
    [paths.config, 0o755],
    [path.join(paths.logs, "chromium.log"), 0o644],
    [paths.settings, 0o644],
    ...fs.readdirSync(paths.data).map((name) => [path.join(paths.data, name), 0o644]),
  ];
  for (const [file, bits] of loose) fs.chmodSync(file, bits);
  assert.ok(fs.readdirSync(paths.data).some((name) => name.includes(".bak-")));
  const started = run(env, `shared.ensurePrivateState();`);
  assert.equal(started.status, 0, started.stderr);
  for (const [file] of loose) assert.equal(mode(file), fs.statSync(file).isDirectory() ? "700" : "600", file);
});

test("data and state folders below a folder other users can write to, or reached through a link in one, are refused", (t) => {
  const { root, env } = profile(t);
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o777);
  for (const [variable, start] of [
    ["XDG_DATA_HOME", "shared.openStore();"],
    ["XDG_STATE_HOME", "shared.ensurePrivateState();"],
  ]) {
    const below = run({ ...env, [variable]: path.join(shared, "home") }, start);
    assert.notEqual(below.status, 0, variable);
    assert.match(below.stderr, /Refusing to use .*shared: other users can write to it/);
    assert.deepEqual(fs.readdirSync(shared), []);
    const safe = path.join(root, `safe-${variable}`);
    fs.mkdirSync(safe, { mode: 0o700 });
    fs.symlinkSync(safe, path.join(shared, "link"));
    const linked = run({ ...env, [variable]: path.join(shared, "link") }, start);
    assert.notEqual(linked.status, 0, variable);
    assert.match(linked.stderr, /Refusing to use .*shared: other users can write to it/);
    assert.deepEqual(fs.readdirSync(safe), []);
    fs.unlinkSync(path.join(shared, "link"));
  }
  fs.chmodSync(shared, 0o1777);
  assert.equal(run({ ...env, XDG_DATA_HOME: path.join(shared, "home") }, "shared.openStore();").status, 0);
});

test("a data folder that is a symbolic link is refused and left alone", (t) => {
  const { root, env } = profile(t);
  const paths = run(env, PATHS).json();
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere, { mode: 0o755 });
  fs.chmodSync(elsewhere, 0o755);
  fs.mkdirSync(path.dirname(paths.data), { recursive: true });
  fs.symlinkSync(elsewhere, paths.data);
  const store = run(env, `shared.openStore();`);
  assert.notEqual(store.status, 0);
  assert.match(store.stderr, /Refusing to use .*: it is a symbolic link/);
  const started = run(env, `shared.ensurePrivateState();`);
  assert.notEqual(started.status, 0);
  assert.match(started.stderr, /Refusing to use .*: it is a symbolic link/);
  assert.equal(mode(elsewhere), "755");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("a database that is a symbolic link is refused", (t) => {
  const { root, env } = profile(t);
  const paths = run(env, PATHS).json();
  const target = path.join(root, "target.db");
  fs.writeFileSync(target, "");
  fs.chmodSync(target, 0o644);
  fs.mkdirSync(paths.data, { recursive: true });
  fs.symlinkSync(target, paths.db);
  const started = run(env, `shared.openStore();`);
  assert.notEqual(started.status, 0);
  assert.match(started.stderr, /Refusing to use .*terminal-browser\.db: it is a symbolic link/);
  assert.equal(mode(target), "644");
});

test("a file owned by another user is refused instead of tightened", (t) => {
  const { UnsafeFileError, tightenPrivateFile, writePrivateFile } = require("../dist/private-files.js");
  const { root } = profile(t);
  const file = path.join(root, "theirs.json");
  fs.writeFileSync(file, "{}");
  fs.chmodSync(file, 0o644);
  const someoneElse = process.getuid() + 1;
  assert.throws(() => tightenPrivateFile(file, someoneElse), UnsafeFileError);
  assert.throws(() => writePrivateFile(file, "{}", someoneElse), /owned by another user/);
  assert.equal(mode(file), "644");
});

const ACL_TOOL = process.platform === "darwin" || spawnSync("setfacl", ["--version"]).status === 0;

// "everyone" on macOS and the user nobody on Linux stand in for another user.
function allowOthers(target, darwin, linux) {
  if (process.platform === "darwin") execFileSync("chmod", ["+a", `everyone allow ${darwin}`, target]);
  else execFileSync("setfacl", ["-m", `u:nobody:${linux}`, target]);
}

function hasAcl(target) {
  if (process.platform === "darwin") return /^ *\d+: /m.test(execFileSync("ls", ["-led", target], { encoding: "utf8" }));
  return /^(default:|(user|group):[^:])/m.test(execFileSync("getfacl", ["-cp", target], { encoding: "utf8" }));
}

test("ACLs that open the data folder, the database or a private file to other users are removed", { skip: !ACL_TOOL }, (t) => {
  const { writePrivateFile } = require("../dist/private-files.js");
  const { env } = profile(t);
  const paths = run(env, PATHS).json();
  assert.equal(run(env, `shared.openStore();`).status, 0);
  allowOthers(paths.data, "read,list,search", "rx");
  allowOthers(paths.db, "read,write", "rw");
  const file = path.join(paths.data, "file.json");
  fs.writeFileSync(file, "{}");
  allowOthers(file, "read", "r");
  writePrivateFile(file, "{}");
  assert.equal(hasAcl(file), false);
  const started = run(env, `shared.openStore();`);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(hasAcl(paths.data), false);
  assert.equal(hasAcl(paths.db), false);
});

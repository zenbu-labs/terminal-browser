const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-migrate-data-"));

const { migrate } = require("../dist/migrate.js");
const { migrations } = require("../dist/migrations.gen.js");
const { openStore } = require("../dist/index.js");

const PRE_EXTENSIONS = "0003_secret_stark_industries";

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-migrate-")), "terminal-browser.db");
}

function open(file) {
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL");
  return sqlite;
}

function tables(sqlite) {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

function backups(file) {
  return fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bak-"));
}

function preExtensionsDatabase(file) {
  const sqlite = open(file);
  const upTo = migrations.findIndex((migration) => migration.id === PRE_EXTENSIONS);
  migrate(sqlite, migrations.slice(0, upTo + 1));
  sqlite.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run("last_url", "https://example.com");
  sqlite.prepare("INSERT INTO settings (id) VALUES (1)").run();
  return sqlite;
}

test("a fresh database gets every migration and no backup", () => {
  const file = tempFile();
  const sqlite = open(file);
  migrate(sqlite, migrations, file);
  const applied = sqlite.prepare("SELECT id FROM migration").all().map((row) => row.id);
  assert.deepEqual(applied, migrations.map((migration) => migration.id));
  assert.ok(tables(sqlite).includes("extensions"));
  assert.ok(tables(sqlite).includes("history_urls"));
  assert.deepEqual(backups(file), []);
});

test("upgrading a pre-extensions database keeps its data and backs it up first", () => {
  const file = tempFile();
  const sqlite = preExtensionsDatabase(file);
  migrate(sqlite, migrations, file);

  assert.equal(sqlite.prepare("SELECT value FROM app_state WHERE key = 'last_url'").get().value, "https://example.com");
  const settings = sqlite.prepare("SELECT * FROM settings WHERE id = 1").get();
  assert.ok("side_panel_width" in settings);
  assert.ok(tables(sqlite).includes("history_visits"));

  assert.deepEqual(backups(file), [`terminal-browser.db.bak-${PRE_EXTENSIONS}`]);
  const backup = new DatabaseSync(`${file}.bak-${PRE_EXTENSIONS}`, { readOnly: true });
  assert.equal(backup.prepare("SELECT value FROM app_state WHERE key = 'last_url'").get().value, "https://example.com");
  assert.ok(!tables(backup).includes("history_urls"));
  const last = backup.prepare("SELECT id FROM migration ORDER BY id DESC LIMIT 1").get().id;
  assert.equal(last, PRE_EXTENSIONS);
});

test("the backup includes writes that are still in the WAL", () => {
  const file = tempFile();
  const sqlite = preExtensionsDatabase(file);
  sqlite.exec("PRAGMA wal_autocheckpoint = 0");
  sqlite.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run("only_in_wal", "yes");
  assert.ok(fs.statSync(`${file}-wal`).size > 0);
  migrate(sqlite, migrations, file);
  const backup = new DatabaseSync(`${file}.bak-${PRE_EXTENSIONS}`, { readOnly: true });
  assert.equal(backup.prepare("SELECT value FROM app_state WHERE key = 'only_in_wal'").get().value, "yes");
});

test("an up to date database is not backed up again", () => {
  const file = tempFile();
  const sqlite = preExtensionsDatabase(file);
  migrate(sqlite, migrations, file);
  fs.rmSync(`${file}.bak-${PRE_EXTENSIONS}`);
  migrate(sqlite, migrations, file);
  assert.deepEqual(backups(file), []);
});

test("a database from a newer version is refused and left untouched", () => {
  const file = tempFile();
  const sqlite = open(file);
  migrate(sqlite, migrations, file);
  sqlite.prepare("INSERT INTO migration (id, time_completed) VALUES (?, ?)").run("9999_future", Date.now());
  assert.throws(() => migrate(sqlite, migrations, file), /newer version of the app/);
  assert.deepEqual(backups(file), []);
});

test("openStore backs up the database it upgrades", () => {
  const file = tempFile();
  preExtensionsDatabase(file).close();
  const { sqlite } = openStore(file);
  assert.ok(tables(sqlite).includes("extensions"));
  assert.deepEqual(backups(file), [`terminal-browser.db.bak-${PRE_EXTENSIONS}`]);
});

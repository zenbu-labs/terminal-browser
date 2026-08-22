const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const main = path.resolve(__dirname, "..", "dist", "main.js");

test("lists, sets, disables, and resets global keybindings", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "terminal-browser-keys-command-test-"),
  );
  const env = {
    HOME: os.homedir(),
    PATH: process.env.PATH,
    TERM: "dumb",
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_STATE_HOME: path.join(directory, "state"),
  };
  const run = (...args) =>
    spawnSync(process.execPath, [main, "keybindings", ...args], {
      encoding: "utf8",
      env,
    });
  try {
    let result = run("ls", "--json");
    assert.equal(result.status, 0);
    assert.ok(
      JSON.parse(result.stdout).some((setting) => setting.id === "close-tab"),
    );
    result = run("set", "close-tab", "alt+w");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /close-tab: alt\+w/);
    assert.equal(run("set", "record", "none").status, 0);
    result = run("ls", "--json");
    const settings = JSON.parse(result.stdout);
    assert.equal(
      settings.find((setting) => setting.id === "close-tab").binding,
      "alt+w",
    );
    assert.equal(
      settings.find((setting) => setting.id === "record").binding,
      "none",
    );
    result = run("reset", "close-tab", "--all");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /accepts an action or --all/);
    assert.equal(run("reset", "--all").status, 0);
    result = run("ls", "--json");
    assert.ok(
      JSON.parse(result.stdout).every((setting) => !setting.overridden),
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

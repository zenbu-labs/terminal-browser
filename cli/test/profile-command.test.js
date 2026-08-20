const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const main = path.resolve(__dirname, "..", "dist", "main.js");

test("manages the built-in and named default profiles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-profile-command-test-"));
  const env = {
    HOME: os.homedir(),
    PATH: process.env.PATH,
    TERM: "dumb",
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_STATE_HOME: path.join(directory, "state"),
  };
  const run = (...args) =>
    spawnSync(process.execPath, [main, "profile", ...args], { encoding: "utf8", env });
  try {
    let result = run("ls", "--json");
    assert.equal(result.status, 0);
    const initial = JSON.parse(result.stdout);
    assert.deepEqual(initial.map((profile) => profile.name), ["default"]);
    assert.equal(initial[0].isDefault, true);
    assert.equal(initial[0].searchEngine.effective.id, "google");
    assert.equal(initial[0].searchEngine.origin, "fallback");

    assert.equal(run("create", "work", "--empty").status, 0);
    result = run("settings", "work", "--search-engine", "brave");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /search engine: Brave Search \(brave\)/);
    result = run("settings", "work", "--json");
    assert.equal(JSON.parse(result.stdout).searchEngine.origin, "override");
    assert.equal(run("settings", "work", "--search-engine", "inherit").status, 0);
    result = run("search-engines", "--json");
    assert.equal(result.status, 0);
    assert.ok(JSON.parse(result.stdout).some((engine) => engine.id === "duckduckgo"));
    assert.equal(run("default", "work").status, 0);
    result = run("ls", "--json");
    const profiles = JSON.parse(result.stdout);
    assert.equal(profiles.find((profile) => profile.name === "default").isDefault, false);
    assert.equal(profiles.find((profile) => profile.name === "work").isDefault, true);

    result = run("remove", "work");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /select another default/);
    assert.equal(run("default", "--reset").status, 0);
    assert.equal(run("remove", "work").status, 0);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("does not register a lazy profile when opening fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-profile-command-test-"));
  const env = {
    HOME: os.homedir(),
    PATH: process.env.PATH,
    TERM: "dumb",
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_STATE_HOME: path.join(directory, "state"),
  };
  try {
    const opened = spawnSync(
      process.execPath,
      [main, "open", "example.com", "--profile", "ghost"],
      { encoding: "utf8", env },
    );
    assert.equal(opened.status, 1);
    const listed = spawnSync(process.execPath, [main, "profile", "ls", "--json"], {
      encoding: "utf8",
      env,
    });
    assert.equal(listed.status, 0);
    assert.deepEqual(JSON.parse(listed.stdout).map((profile) => profile.name), ["default"]);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

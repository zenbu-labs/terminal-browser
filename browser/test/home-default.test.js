const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { ConfigStore, SETTINGS, defaultSettings } = require("shared");
const { resolveDefaultUrl, resolveRestoreUrl } = require("../dist/url.js");

const START = "terminal-browser://start";
const DEV = "terminal-browser://dev";
const BLANK = "about:blank";

test("only home.default ships; section toggles wait for M5 wiring", () => {
  for (const key of ["home.search", "home.pins", "home.bookmarks", "home.devSections"]) {
    assert.equal(key in SETTINGS, false, `${key} must stay hidden until its section is wired`);
  }
  assert.equal(SETTINGS["home.default"].group, "general");
  assert.equal(SETTINGS["home.default"].default, "start");
  assert.deepEqual(defaultSettings()["home.default"], "start");
});

test("home.restore ships as a general boolean defaulting to true", () => {
  assert.equal(SETTINGS["home.restore"].group, "general");
  assert.equal(SETTINGS["home.restore"].default, true);
  assert.deepEqual(defaultSettings()["home.restore"], true);
});

test("home.restore rejects non-boolean values", () => {
  assert.equal(SETTINGS["home.restore"].schema.safeParse(true).success, true);
  assert.equal(SETTINGS["home.restore"].schema.safeParse(false).success, true);
  assert.equal(SETTINGS["home.restore"].schema.safeParse("off").success, false);
  assert.equal(SETTINGS["home.restore"].schema.safeParse(0).success, false);
});

test("home.restore round-trips through the config store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-home-restore-"));
  const store = new ConfigStore({
    settings: path.join(dir, "settings.json"),
    shortcuts: path.join(dir, "shortcuts.json"),
  });
  assert.equal(store.load().settings["home.restore"], true);
  store.setSetting("home.restore", false);
  assert.equal(store.load().settings["home.restore"], false);
  store.setSetting("home.restore", undefined);
  assert.equal(store.load().settings["home.restore"], true);

  fs.writeFileSync(store.files.settings, JSON.stringify({ "home.restore": "nope" }));
  const loaded = store.load();
  assert.equal(loaded.settings["home.restore"], true);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0], /home\.restore/);
});
test("home.default rejects values outside its enum", () => {
  assert.equal(SETTINGS["home.default"].schema.safeParse("start").success, true);
  assert.equal(SETTINGS["home.default"].schema.safeParse("blank").success, true);
  assert.equal(SETTINGS["home.default"].schema.safeParse("nope").success, false);
});

test("home.default round-trips through the config store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-home-default-"));
  const store = new ConfigStore({
    settings: path.join(dir, "settings.json"),
    shortcuts: path.join(dir, "shortcuts.json"),
  });
  assert.equal(store.load().settings["home.default"], "start");
  store.setSetting("home.default", "blank");
  assert.equal(store.load().settings["home.default"], "blank");
  store.setSetting("home.default", undefined);
  assert.equal(store.load().settings["home.default"], "start");

  fs.writeFileSync(store.files.settings, JSON.stringify({ "home.default": "nope" }));
  const loaded = store.load();
  assert.equal(loaded.settings["home.default"], "start");
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0], /home\.default/);
});

test("tooling sessions land empty tabs on the dev dashboard", () => {
  assert.equal(resolveDefaultUrl({ TERMINAL_BROWSER_START_PAGE: "1" }, "start", START, DEV), DEV);
  assert.equal(resolveDefaultUrl({ TERMINAL_BROWSER_START_PAGE: "1" }, "blank", START, DEV), DEV);
  assert.equal(resolveDefaultUrl({ TERMINAL_BROWSER_START_PAGE: "1" }, "nope", START, DEV), DEV);
});

test("the tooling flag beats restore: env=1 always lands dev", () => {
  const LAST = "https://example.com/page";
  const launch = (env, restore, homeDefault, last) => {
    if (env.TERMINAL_BROWSER_START_PAGE === "1") return resolveDefaultUrl(env, homeDefault, START, DEV);
    return resolveRestoreUrl(restore, last) ?? resolveDefaultUrl(env, homeDefault, START, DEV);
  };
  for (const restore of [true, false]) {
    for (const homeDefault of ["start", "blank"]) {
      assert.equal(launch({ TERMINAL_BROWSER_START_PAGE: "1" }, restore, homeDefault, LAST), DEV);
    }
  }
  const session = fs.readFileSync(path.join(__dirname, "..", "dist", "session", "session.js"), "utf8");
  assert.match(session, /TERMINAL_BROWSER_START_PAGE !== "1"/);
});

test("without the tooling flag the home.default setting decides", () => {
  assert.equal(resolveDefaultUrl({ TERMINAL_BROWSER_START_PAGE: "0" }, "start", START, DEV), START);
  assert.equal(resolveDefaultUrl({ TERMINAL_BROWSER_START_PAGE: "0" }, "blank", START, DEV), BLANK);
  assert.equal(resolveDefaultUrl({}, "start", START, DEV), START);
  assert.equal(resolveDefaultUrl({}, "blank", START, DEV), BLANK);
  assert.equal(resolveDefaultUrl({}, "nope", START, DEV), START);
});

test("restore only reopens http(s) last-urls, trimmed", () => {
  const LAST = "https://example.com/page";
  assert.equal(resolveRestoreUrl(true, LAST), LAST);
  assert.equal(resolveRestoreUrl(true, "http://example.com/"), "http://example.com/");
  assert.equal(resolveRestoreUrl(true, `  ${LAST}  `), LAST);
  assert.equal(resolveRestoreUrl(true, "about:blank"), null);
  assert.equal(resolveRestoreUrl(true, "terminal-browser://start"), null);
  assert.equal(resolveRestoreUrl(true, "file:///tmp/x.html"), null);
  assert.equal(resolveRestoreUrl(true, ""), null);
  assert.equal(resolveRestoreUrl(true, "   "), null);
  assert.equal(resolveRestoreUrl(true, null), null);
  assert.equal(resolveRestoreUrl(true, undefined), null);
  assert.equal(resolveRestoreUrl(false, LAST), null);
  assert.equal(resolveRestoreUrl(false, null), null);
});

test("bare launch resolves restore × default × last-url (8 cases)", () => {
  const LAST = "https://example.com/page";
  const launch = (restore, homeDefault, last) =>
    resolveRestoreUrl(restore, last) ?? resolveDefaultUrl({}, homeDefault, START, DEV);
  assert.equal(launch(true, "start", LAST), LAST);
  assert.equal(launch(true, "start", null), START);
  assert.equal(launch(true, "blank", LAST), LAST);
  assert.equal(launch(true, "blank", null), BLANK);
  assert.equal(launch(false, "start", LAST), START);
  assert.equal(launch(false, "start", null), START);
  assert.equal(launch(false, "blank", LAST), BLANK);
  assert.equal(launch(false, "blank", null), BLANK);
});

test("the session cold-launch path reads the tooling flag and home.default", () => {
  const session = fs.readFileSync(path.join(__dirname, "..", "dist", "session", "session.js"), "utf8");
  for (const marker of ["resolveDefaultUrl", "resolveRestoreUrl", "home.default", "home.restore", "DEV_URL"]) {
    assert.match(session, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  }
  const url = fs.readFileSync(path.join(__dirname, "..", "dist", "url.js"), "utf8");
  assert.match(url, /TERMINAL_BROWSER_START_PAGE/);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

const {
  browserName,
  detectProfileSearchEngine,
  namedProfileName,
  profileName,
} = require("../dist/profile");

test("accepts supported browser and profile names", () => {
  assert.equal(browserName("brave"), "brave");
  assert.equal(browserName("chrome"), "chrome");
  assert.equal(browserName("chromium"), "chromium");
  assert.equal(profileName("Work_2.0"), "Work_2.0");
  assert.equal(profileName("default"), "default");
  assert.equal(namedProfileName("Work_2.0"), "Work_2.0");
});

test("rejects unknown browsers and path-like profile names", () => {
  assert.throws(() => browserName("firefox"), /unknown browser/);
  assert.throws(() => profileName("../work"), /profile names/);
  assert.throws(() => profileName("personal/work"), /profile names/);
  assert.throws(() => namedProfileName("default"), /built-in profile/);
});

test("detects a selected search engine and falls back to the browser default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-search-source-test-"));
  const profile = path.join(root, "Default");
  fs.mkdirSync(profile);
  try {
    assert.equal(detectProfileSearchEngine("brave", root, "Default").id, "brave");
    fs.writeFileSync(
      path.join(profile, "Preferences"),
      JSON.stringify({
        default_search_provider_data: {
          template_url_data: {
            short_name: "DuckDuckGo",
            url: "https://duckduckgo.com/?q={searchTerms}",
          },
        },
      }),
    );
    assert.equal(detectProfileSearchEngine("chrome", root, "Default").id, "duckduckgo");
    fs.writeFileSync(
      path.join(profile, "Preferences"),
      JSON.stringify({ default_search_provider: { guid: "example-guid" } }),
    );
    const database = new DatabaseSync(path.join(profile, "Web Data"));
    database.exec(
      "create table keywords (short_name text, url text, suggest_url text, sync_guid text)",
    );
    database
      .prepare("insert into keywords values (?, ?, ?, ?)")
      .run(
        "Example Search",
        "https://search.example.test/?q={searchTerms}",
        "https://search.example.test/suggest?q={searchTerms}",
        "example-guid",
      );
    database.close();
    const detected = detectProfileSearchEngine("chrome", root, "Default");
    assert.equal(detected.id, "custom");
    assert.equal(detected.name, "Example Search");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

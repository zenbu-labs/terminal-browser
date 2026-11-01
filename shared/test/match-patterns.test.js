const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-patterns-data-"));

const { parseMatchPattern, patternMatches } = require("../dist/index.js");

const matches = (source, url) => {
  const pattern = parseMatchPattern(source);
  assert.ok(pattern, `${source} should parse`);
  return patternMatches(pattern, url);
};

test("a port in a pattern only matches that port, like Chromium's URLPattern", () => {
  assert.equal(matches("https://host.test:8443/*", "https://host.test:8443/a"), true);
  assert.equal(matches("https://host.test:8443/*", "https://host.test/a"), false);
  assert.equal(matches("https://host.test:8443/*", "https://host.test:9000/a"), false);
  assert.equal(matches("https://host.test:443/*", "https://host.test/a"), true);
  assert.equal(matches("http://host.test/*", "http://host.test:8080/a"), true);
  assert.equal(matches("http://host.test:*/*", "http://host.test:8080/a"), true);
});

test("patterns Chromium refuses to parse are refused", () => {
  for (const source of ["*://host.test:8080/*", "https://host.test:99999/*", "https://host.test:abc/*", "https://host.test", "https://*.", "https://a*b.test/*", "https://[::1/*"]) {
    assert.equal(parseMatchPattern(source), null, source);
  }
});

test("a scheme wildcard covers only http and https", () => {
  assert.equal(matches("*://*/*", "https://a.test/"), true);
  assert.equal(matches("*://*/*", "ws://a.test/"), false);
  assert.equal(matches("*://*/*", "wss://a.test/"), false);
});

test("subdomain wildcards never match IP addresses, and hosts compare canonicalized", () => {
  assert.equal(matches("http://*.0.0.1/*", "http://127.0.0.1/"), false);
  assert.equal(matches("http://*.example.test/*", "http://a.example.test./x"), true);
  assert.equal(matches("http://EXAMPLE.test/*", "http://example.test/"), true);
  assert.equal(matches("http://[::1]/*", "http://[::1]:80/"), true);
  assert.equal(matches("http://0x7f.1/*", "http://127.0.0.1/"), true);
});

test("a path ending in /* also matches the path without the slash", () => {
  assert.equal(matches("https://a.test/foo/*", "https://a.test/foo"), true);
  assert.equal(matches("https://a.test/foo/*", "https://a.test/foobar"), false);
});

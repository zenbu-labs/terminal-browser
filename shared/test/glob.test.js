const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-glob-data-"));

const { matchesGlob, matchesUrlPatternPath, parseMatchPattern, patternMatches, PatternSet } = require("../dist/index.js");

const matches = (source, url) => {
  const pattern = parseMatchPattern(source);
  assert.ok(pattern, `${source} should parse`);
  return patternMatches(pattern, url);
};

test("globs follow Chromium's base::MatchPattern (pattern_unittest.cc)", () => {
  const cases = [
    ["www.google.com", "*.com", true],
    ["www.google.com", "*", true],
    ["www.google.com", "www*.g*.org", false],
    ["Hello", "H?l?o", true],
    ["www.google.com", "http://*)", false],
    ["www.msn.com", "*.COM", false],
    ["Hello*1234", "He??o\\*1*", true],
    ["", "*.*", false],
    ["", "*", true],
    ["", "?", true],
    ["", "", true],
    ["Hello", "", false],
    ["Hello*", "Hello*", true],
    ["abcd", "*???", true],
    ["abcd", "???", false],
    ["abcb", "a*b", true],
    ["abcb", "a?b", false],
    ["heart: ♠", "*♠", true],
    ["heart: ♠.", "heart: ?.", true],
    ["hearts: ♠♠", "*", true],
    ["face: \u{1F600}.", "face: ?.", true],
    ["Hello", "He********************************o", true],
    ["123456789012345678", "?????????????????*", true],
    ["aaaaaaaaaaab", "a*a*a*a*a*a*a*a*a*a*a*b", true],
    ["God test page", "God test*", true],
    ["God test page", "god test*", false],
    ["ab", "a??b", true],
    ["ab", "a\\?b", false],
    ["a?b", "a\\?b", true],
  ];
  for (const [text, pattern, expected] of cases) assert.equal(matchesGlob(text, pattern), expected, `${JSON.stringify(text)} ~ ${JSON.stringify(pattern)}`);
});

test("match pattern paths follow Chromium's URLPattern (url_pattern_unittest.cc)", () => {
  assert.equal(matches("http://*/*", "http://google.com"), true);
  assert.equal(matches("http://*/*", "http://google.com/foo"), true);
  assert.equal(matches("https://*/foo*", "https://www.google.com/foo"), true);
  assert.equal(matches("https://*/foo*", "https://www.google.com/foobar"), true);
  assert.equal(matches("https://*/foo*", "https://www.google.com/"), false);
  assert.equal(matches("http://*.google.com/foo*bar", "http://google.com/foobar"), true);
  assert.equal(matches("http://*.google.com/foo*bar", "http://www.google.com/foo?bar"), true);
  assert.equal(matches("http://*.google.com/foo*bar", "http://monkey.images.google.com/foooobar"), true);
  assert.equal(matches("http://*.google.com/foo*bar", "http://yahoo.com/foobar"), false);
  assert.equal(matches("file:///foo?bar\\*baz", "file:///foo?bar\\hellobaz"), true);
  assert.equal(matches("file:///foo?bar\\*baz", "file:///fooXbar\\hellobaz"), false);
  assert.equal(matches("https://a.test/a?c", "https://a.test/abc"), false);
  assert.equal(matches("https://a.test/foo/*", "https://a.test/foo"), true);
  assert.equal(matches("https://a.test/*/x/*", "https://a.test/*/x"), true);
  assert.equal(matches("https://a.test/*/x/*", "https://a.test/y/x"), false);
  assert.equal(matches("https://a.test/Foo", "https://a.test/foo"), false);
  assert.equal(matchesUrlPatternPath("/", "/*"), true);
  assert.equal(matchesUrlPatternPath("/a\\b", "/a\\b"), true);
});

test("extension-supplied globs and match patterns can't freeze the browser", () => {
  const glob = "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b";
  const longText = "a".repeat(100_000);
  const longUrl = `https://x.example/${longText}`;
  const pathPattern = "https://*/*a*a*a*a*a*a*a*a*a*a*a*a*a*b";
  let started = performance.now();
  assert.equal(matchesGlob(longText, glob), false);
  assert.equal(matchesGlob(`${longText}b`, glob), true);
  assert.ok(performance.now() - started < 50, `title glob took ${performance.now() - started}ms`);
  started = performance.now();
  assert.equal(matches(pathPattern, longUrl), false);
  assert.equal(new PatternSet([pathPattern, "chrome-extension://*/*a*a*a*a*a*a*a*a*a*a*a*a*a*b"]).matches(longUrl), false);
  assert.equal(matches(pathPattern, `${longUrl}b`), true);
  assert.ok(performance.now() - started < 50, `match pattern took ${performance.now() - started}ms`);
  started = performance.now();
  assert.equal(matchesGlob(`${"?".repeat(5_000)}b`, "?".repeat(5_000) + "a".repeat(5_000)), false);
  assert.equal(matchesGlob("a".repeat(100_000), `${"?".repeat(5_000)}${"a".repeat(5_000)}b`), false);
  assert.ok(performance.now() - started < 50, `question marks took ${performance.now() - started}ms`);
});

test("the round-2 ReDoS proofs of concept finish quickly", () => {
  const script = `
    const { matchesGlob, parseMatchPattern, patternMatches } = require(${JSON.stringify(path.join(__dirname, "../dist/index.js"))});
    const started = Date.now();
    patternMatches(parseMatchPattern("https://*/*a*a*a*a*a*a*a*a*a*a*a*a*a*b"), "https://x.example/" + "a".repeat(64));
    matchesGlob("a".repeat(64), "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b");
    process.stdout.write(String(Date.now() - started));
  `;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000, env: process.env });
  assert.equal(run.signal, null, "the proof of concept hung");
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Number(run.stdout) < 50, `took ${run.stdout}ms`);
});

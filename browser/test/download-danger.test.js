const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { getName: () => "terminal-browser" } };
  return load.call(this, request, ...rest);
};

const {
  canonicalExtension,
  downloadDangerLevel,
  fileTypeSettings,
  opensOnlyAfterPrompt,
  visitedBeforeToday,
} = require("../dist/browsing/download-danger.js");
const { downloadReferrer, quarantineUrl } = require("../dist/browsing/quarantine.js");

// file_type_policies_unittest.cc UnpackResourceBundle, for the platforms we ship.
test("file types match Chromium's policy table on macOS and Linux", () => {
  const cases = [
    ["a/foo.exe", "mac", ["safe", true]],
    ["a/foo.exe", "linux", ["safe", true]],
    ["foo.class", "mac", ["gesture", false]],
    ["foo.class", "linux", ["gesture", false]],
    ["foo.dmg", "mac", ["gesture", false]],
    ["foo.dmg", "linux", ["safe", true]],
    ["foo.dex", "mac", ["safe", true]],
    ["foo.rpm", "linux", ["gesture", false]],
    ["foo.rpm", "mac", ["safe", true]],
    ["b/bar.txt.zip", "mac", ["safe", true]],
    ["a/foo.fooobar", "mac", ["safe", true]],
    ["Report.command", "mac", ["gesture", false]],
    ["Report.command", "linux", ["safe", true]],
    ["link.fileloc", "mac", ["gesture", false]],
    ["setup.pkg", "linux", ["gesture", false]],
    ["run.sh", "mac", ["gesture", false]],
    ["run.sh", "linux", ["gesture", false]],
    ["app.desktop", "linux", ["gesture", false]],
    ["Report.terminal", "mac", ["safe", true]],
  ];
  for (const [file, platform, expected] of cases) {
    assert.deepEqual([...fileTypeSettings(file, platform)], expected, `${file} on ${platform}`);
  }
});

test("the extension is the last one, lower-cased, ignoring trailing dots and spaces, like FilePath", () => {
  assert.equal(canonicalExtension("/x/Report.COMMAND"), "command");
  assert.equal(canonicalExtension("Report.command."), "command");
  assert.equal(canonicalExtension("Report.command . ."), "command");
  assert.equal(canonicalExtension("bar.txt.zip"), "zip");
  assert.equal(canonicalExtension(".bashrc"), "bashrc");
  assert.equal(canonicalExtension("noextension"), "");
  assert.equal(canonicalExtension("..."), "");
  assert.equal(canonicalExtension("evil.сommand"), "");
  assert.deepEqual([...fileTypeSettings("constructor.constructor", "mac")], ["safe", true]);
});

const context = (filename, extra = {}) => ({
  filename,
  hasUserGesture: false,
  fromAddressBar: false,
  visitedReferrer: () => false,
  platform: "mac",
  ...extra,
});

// download_target_determiner_unittest.cc VisitedReferrer and TransitionType,
// with .command (ALLOW_ON_USER_GESTURE on macOS) for Chromium's .kindabad.
test("a type risky without a gesture is dangerous unless typed, or clicked from a site visited before today", () => {
  assert.equal(downloadDangerLevel(context("foo.txt")), "safe");
  assert.equal(downloadDangerLevel(context("foo.command")), "gesture");
  assert.equal(downloadDangerLevel(context("foo.command", { hasUserGesture: true })), "gesture");
  assert.equal(downloadDangerLevel(context("foo.command", { visitedReferrer: () => true })), "gesture");
  assert.equal(downloadDangerLevel(context("foo.command", { hasUserGesture: true, visitedReferrer: () => true })), "safe");
  assert.equal(downloadDangerLevel(context("foo.command", { fromAddressBar: true })), "safe");
  assert.equal(downloadDangerLevel(context("foo.command", { platform: "linux" })), "safe");
});

test("a referrer counts as visited only if its first visit was before today", () => {
  const now = new Date(2026, 10, 2, 15, 0).getTime();
  const lastNight = new Date(2026, 10, 1, 23, 59, 50).getTime();
  const thisMorning = new Date(2026, 10, 2, 0, 0, 10).getTime();
  assert.equal(visitedBeforeToday(lastNight, now), true);
  assert.equal(visitedBeforeToday(thisMorning, now), false);
  assert.equal(visitedBeforeToday(null, now), false);
});

test("opening asks first for types Chrome won't open automatically and for files whose danger was overridden", () => {
  assert.equal(opensOnlyAfterPrompt("Report.command", "safe", "mac"), true);
  assert.equal(opensOnlyAfterPrompt("payload.sh", "safe", "linux"), true);
  assert.equal(opensOnlyAfterPrompt("notes.txt", "accepted", "mac"), true);
  assert.equal(opensOnlyAfterPrompt("notes.txt", "safe", "mac"), false);
  assert.equal(opensOnlyAfterPrompt("Report.terminal", "safe", "mac"), false);
});

// quarantine/common_unittest.cc SanitizeUrlForQuarantine.
test("quarantine URLs are sanitized like Chromium's", () => {
  const cases = [
    ["http://foo:bar@s.example/x/y/z", "http://s.example/x/y/z"],
    ["http://a.example/x/y?q=f&r=g#blah", "http://a.example/x/y?q=f&r=g#blah"],
    ["https://a.example/x/y?q=f#h", "https://a.example/x/y?q=f#h"],
    ["ws://a.example/x/y?q=f", "ws://a.example/x/y?q=f"],
    ["wss://a.example/x/y?q=f", "wss://a.example/x/y?q=f"],
    ["wss://foo:bar@a.example/x/y?q=f", "wss://a.example/x/y?q=f"],
    ["blob:https://b.example/x/y/z", "https://b.example/"],
    ["blob:https://foo:bar@b.example/x/y/z?q", "https://b.example/"],
    ["filesystem:https://example.com/temporary/m", "https://example.com/"],
    ["filesystem:https://foo:bar@example.com/temporary/m", "https://example.com/"],
    ["some-random-scheme:randomdata", "some-random-scheme:randomdata"],
    ["data:text/plain,hello%20world!", ""],
    ["http://www.source.example.com", "http://www.source.example.com/"],
    ["1|\\|\\/4L||>", ""],
  ];
  for (const [input, expected] of cases) assert.equal(quarantineUrl(input), expected, input);
});

test("a download's referrer follows the default referrer policy", () => {
  assert.equal(downloadReferrer("https://a.test/page?q=1#frag", "https://a.test/f.zip"), "https://a.test/page?q=1");
  assert.equal(downloadReferrer("https://a.test/page", "https://b.test/f.zip"), "https://a.test/");
  assert.equal(downloadReferrer("https://a.test/page", "http://a.test/f.zip"), "");
  assert.equal(downloadReferrer("terminal-browser://downloads", "https://a.test/f.zip"), "");
});

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { joinTargetWords } = require("../dist/target");

test("joins unquoted search terms into one browser target", () => {
  assert.deepEqual(joinTargetWords(["cute", "cats"]), ["cute cats"]);
  assert.deepEqual(joinTargetWords(["--no-toolbar", "best", "terminal", "browser"]), [
    "--no-toolbar",
    "best terminal browser",
  ]);
});

test("leaves a URL or quoted search target unchanged", () => {
  assert.deepEqual(joinTargetWords(["https://example.com"]), ["https://example.com"]);
  assert.deepEqual(joinTargetWords(["cute cats", "--no-toolbar"]), [
    "cute cats",
    "--no-toolbar",
  ]);
});

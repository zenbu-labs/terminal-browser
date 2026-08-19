const assert = require("node:assert/strict");
const test = require("node:test");

const { isBrowserFlag } = require("../dist/open-flags.js");

test("allow-quit-url is accepted explicitly", () => {
  assert.equal(isBrowserFlag("--allow-quit-url"), true);
});

test("upstream SSH browser flags remain accepted after flag registry extraction", () => {
  assert.equal(isBrowserFlag("--ssh=dev@build-box"), true);
  assert.equal(isBrowserFlag("--ssh-bundle=/tmp/app"), true);
  assert.equal(isBrowserFlag("--ssh-bundle-dir=/srv/app"), true);
});

test("unknown option protection remains fail closed", () => {
  assert.equal(isBrowserFlag("--allow-quit-url=true"), false);
  assert.equal(isBrowserFlag("--allow-quit-urls"), false);
  assert.equal(isBrowserFlag("--unknown"), false);
});

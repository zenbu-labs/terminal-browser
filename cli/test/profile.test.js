const assert = require("node:assert/strict");
const { test } = require("node:test");

const { browserName, namedProfileName, profileName } = require("../dist/profile");

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

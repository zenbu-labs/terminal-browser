const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parsePageZoom } = require("../dist/index.js");

test("page zoom accepts factors and percents", () => {
  assert.equal(parsePageZoom("1.5"), 1.5);
  assert.equal(parsePageZoom("150%"), 1.5);
  assert.equal(parsePageZoom(" 150 % "), 1.5);
  assert.equal(parsePageZoom("25%"), 0.25);
  assert.equal(parsePageZoom("500%"), 5);
});

test("page zoom refuses malformed and out of range values", () => {
  for (const raw of ["", "abc", "0", "24.999%", "5.0001", "1.5x", "-1", null]) {
    assert.equal(parsePageZoom(raw), null, String(raw));
  }
});

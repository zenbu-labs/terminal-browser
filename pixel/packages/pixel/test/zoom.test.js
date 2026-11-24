const assert = require("node:assert/strict");
const { test } = require("node:test");

const { zoomSite } = require("../dist/web/zoom.js");

test("ports on one hostname share a remembered zoom", () => {
  assert.equal(zoomSite("http://localhost:3000/a"), zoomSite("http://localhost:3001/b"));
  assert.equal(zoomSite("https://example.com./"), zoomSite("https://example.com/path"));
});

test("urls without a hostname are remembered one by one", () => {
  assert.notEqual(zoomSite("file:///tmp/a.html"), zoomSite("file:///tmp/b.html"));
  assert.notEqual(zoomSite("http://localhost/"), zoomSite("http://example.com/"));
});

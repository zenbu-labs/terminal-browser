const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OPEN_URL_ENV, takeHandedUrl } = require("../dist/handed-url.js");

test("an address handed over in the environment becomes the url and leaves the environment", () => {
  const args = ["--split", "right"];
  const env = { [OPEN_URL_ENV]: "https://a.test/?q=1&x=(2)", PATH: "p" };
  takeHandedUrl(args, env);
  assert.deepEqual(args, ["--split", "right", "https://a.test/?q=1&x=(2)"]);
  assert.equal(env[OPEN_URL_ENV], undefined, "children of the cli must not inherit it");
  assert.equal(env.PATH, "p");
});

test("without a handed address the arguments stay as they were", () => {
  const args = ["https://b.test"];
  takeHandedUrl(args, {});
  assert.deepEqual(args, ["https://b.test"]);
});

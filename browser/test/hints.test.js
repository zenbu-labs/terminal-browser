const assert = require("node:assert/strict");
const { test } = require("node:test");

const { hintLabels, HINT_ALPHABET } = require("../dist/hints/labels.js");

const prefixFree = (labels) => labels.every((a) => labels.every((b) => a === b || !b.startsWith(a)));

test("no candidates get no labels", () => {
  assert.deepEqual(hintLabels(0, HINT_ALPHABET), []);
});

test("a few candidates get single letters in alphabet order", () => {
  assert.deepEqual(hintLabels(3, HINT_ALPHABET), ["s", "a", "d"]);
});

test("a full alphabet still fits in single letters", () => {
  assert.deepEqual(hintLabels(14, HINT_ALPHABET), HINT_ALPHABET.split(""));
});

test("one more than the alphabet moves every label to two letters", () => {
  const labels = hintLabels(15, HINT_ALPHABET);
  assert.equal(labels.length, 15);
  assert.ok(labels.every((label) => label.length === 2));
});

test("many candidates get unique, equal-length, prefix-free labels", () => {
  const labels = hintLabels(200, HINT_ALPHABET);
  assert.equal(labels.length, 200);
  assert.equal(new Set(labels).size, 200);
  assert.equal(new Set(labels.map((label) => label.length)).size, 1);
  assert.ok(prefixFree(labels));
});

test("a custom alphabet is honoured", () => {
  const labels = hintLabels(5, "ab");
  assert.equal(new Set(labels).size, 5);
  assert.ok(labels.every((label) => label.length === 3 && /^[ab]+$/.test(label)));
});

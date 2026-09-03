const assert = require("node:assert/strict");
const { test } = require("node:test");

const { bracketedPaste } = require("../dist/shared.js");

test("single-line text is passed through untouched", () => {
  assert.equal(bracketedPaste("> hello; rm -rf /"), "> hello; rm -rf /");
});

test("multi-line text is wrapped in one bracketed paste", () => {
  assert.equal(bracketedPaste("a\nb\n\n"), "\x1b[200~a\nb\n\n\x1b[201~");
});

test("an embedded paste terminator cannot break out of the paste", () => {
  const wrapped = bracketedPaste("a\x1b[201~\nrm -rf /\n");
  assert.equal(wrapped.indexOf("\x1b[201~"), wrapped.length - "\x1b[201~".length);
});

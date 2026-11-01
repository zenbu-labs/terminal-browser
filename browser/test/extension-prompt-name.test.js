const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return {};
  if (request === "@zenbu-labs/pixel") return { Box() {}, Image() {}, Text() {}, WebView() {}, Path() {}, useRect: () => null };
  return load.call(this, request, ...rest);
};

const { promptName, clampName } = require("../dist/ui/extension-prompt.js");

test("a prompt shows the extension name the way Chrome's LoadName cleans it", () => {
  assert.equal(promptName(`Calculator${"\n".repeat(200)}Press Enter to finish setup`), "CalculatorPress Enter to finish setup");
  assert.equal(promptName("  Dark \t  Reader \r\n "), "Dark Reader");
  assert.equal(promptName("abc‮dcba⁦x⁩"), "abcdcbax");
});

test("a long name is cut to one short line so the warnings below it stay in view", () => {
  assert.equal(clampName("uBlock Origin Lite"), "uBlock Origin Lite");
  const clamped = clampName("A".repeat(300));
  assert.equal(Array.from(clamped).length, 45);
  assert.ok(clamped.endsWith("…"));
  assert.equal(Array.from(clampName("😀".repeat(60))).length, 45);
});

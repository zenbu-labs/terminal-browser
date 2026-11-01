const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { kernelSetting } = require("../dist/sandbox.js");

test("a readable kernel setting returns its trimmed value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-sandbox-"));
  const file = path.join(dir, "apparmor_restrict_unprivileged_userns");
  fs.writeFileSync(file, "1\n");
  assert.equal(kernelSetting(file), "1");
});

test("a missing or unreadable kernel setting returns null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-sandbox-"));
  assert.equal(kernelSetting(path.join(dir, "absent")), null);
  assert.equal(kernelSetting(dir), null);
});

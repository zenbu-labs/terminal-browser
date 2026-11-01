const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseSshTarget, resolveSshTarget, validateBundleDir } = require("../dist/ssh");

test("ssh targets split into destination and port", () => {
  assert.deepEqual(parseSshTarget("dev@build-box"), { destination: "dev@build-box", sshPort: null });
  assert.deepEqual(parseSshTarget("build-box:2222"), { destination: "build-box", sshPort: "2222" });
  assert.throws(() => parseSshTarget("not a host"));
});

test("a full ssh command is refused; the port goes in the target and keys in ~/.ssh/config", () => {
  assert.throws(() => resolveSshTarget("ssh -i ~/.ssh/id -p 2200 dev@box"), /invalid ssh target/);
  assert.throws(() => resolveSshTarget("ssh one two"), /invalid ssh target/);
  assert.deepEqual(resolveSshTarget("dev@box:2200"), { destination: "dev@box", hostArgs: ["-p", "2200"] });
});

test("a bundle needs an executable start script", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  assert.throws(() => validateBundleDir(dir));
  fs.writeFileSync(path.join(dir, "start"), "#!/bin/sh\n", { mode: 0o644 });
  assert.throws(() => validateBundleDir(dir));
  fs.chmodSync(path.join(dir, "start"), 0o755);
  validateBundleDir(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});


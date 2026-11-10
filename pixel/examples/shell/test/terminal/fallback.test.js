const assert = require("node:assert/strict");
const { test } = require("node:test");

const { fallback } = require("../../dist/terminal/launch.js");

test("pxsh falls back to zsh as a login shell, or as a command runner when given arguments", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { PXSH_CWD: "/tmp", PXSH_ZSH: "/bin/zsh", SHLVL: "2", KEEP: "1" });
    const login = fallback([]);
    assert.equal(login.file, "/bin/zsh");
    assert.equal(login.argv0, "-/bin/zsh");
    assert.deepEqual(login.args, []);
    assert.equal(login.env.KEEP, "1");
    assert.equal(login.env.SHLVL, "2");
    assert.ok(!Object.keys(login.env).some((name) => name.startsWith("PXSH_")));
    const command = fallback(["-c", "true"]);
    assert.equal(command.argv0, "/bin/zsh");
    assert.deepEqual(command.args, ["-c", "true"]);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

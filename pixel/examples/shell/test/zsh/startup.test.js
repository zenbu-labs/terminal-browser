const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { writeStartupFiles } = require("../../dist/zsh/startup.js");

test("zsh keeps the user's history file instead of one in the startup dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-test-"));
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-test-user-"));
  try {
    writeStartupFiles(dir, "nonce");
    const out = execFileSync("zsh", ["-l", "-i", "-c", "print -r -- HISTFILE=$HISTFILE"], {
      env: { ...process.env, ZDOTDIR: dir, PXSH_USER_ZDOTDIR: user, PXSH_KEEP_ZDOTDIR: "" },
      encoding: "utf8",
    });
    const histfile = out.match(/^HISTFILE=(.*)$/m)[1];
    assert.ok(!histfile.startsWith(dir), histfile);
    if (process.platform === "darwin") assert.equal(histfile, path.join(user, ".zsh_history"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(user, { recursive: true, force: true });
  }
});

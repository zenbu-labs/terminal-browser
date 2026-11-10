const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { bracketedPaste, shellLiteral } = require("../dist/terminal/shared.js");

function typeIntoShell(argv, inputs) {
  const spec = JSON.stringify({ argv, inputs });
  const run = spawnSync("python3", [path.join(__dirname, "pty-shell.py"), spec], {
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(run.status, 0, run.stderr || `pty-shell exited ${run.status}`);
  return run.stdout;
}

const marker = () =>
  path.join(os.tmpdir(), `grab-shell-safety-${process.pid}-${Math.random().toString(36).slice(2)}`);

const SHELLS = [
  ["zsh", ["/bin/zsh", "-f", "-i"]],
  ["bash", ["/bin/bash", "--noprofile", "--norc", "-i"]],
];

for (const [name, argv] of SHELLS) {
  test(`${name}: pressing Enter on the single-quoted payload executes nothing, while a raw newline still runs a command`, () => {
    const file = marker();
    const control = marker();
    const hostile = `> [<h2>x</h2>; touch ${file}; echo EXECUTED || touch ${file} | touch ${file} && touch ${file} $(touch ${file}) \`touch ${file}\` it's \\ !! ${"$"}HOME > ${file}]`;
    const output = typeIntoShell(argv, [shellLiteral(hostile), "\n", "\n", `touch ${control}\n`]);
    const ran = fs.existsSync(control);
    fs.rmSync(control, { force: true });
    assert.equal(ran, true, "control payload should have executed");
    assert.equal(fs.existsSync(file), false, "quoted word must not run or create anything");
    assert.equal(output.includes("EXECUTED\r"), false, "echo inside the quotes must not run");
    // a word containing a slash is looked up as a path: "no such file or directory" in both shells
    assert.ok(/not found|no such file/i.test(output), `shell should reject the word as a command, got ${JSON.stringify(output.slice(-300))}`);
  });

  if (name === "zsh") {
    test(`${name}: multi-line text wrapped in bracketed paste is inserted, not executed`, () => {
      const file = marker();
      typeIntoShell(argv, [bracketedPaste(`> touch ${file}\n\n`), ""]);
      const ran = fs.existsSync(file);
      fs.rmSync(file, { force: true });
      assert.equal(ran, false, "zsh honours bracketed paste, the pasted newline must not submit");
    });
  }
}

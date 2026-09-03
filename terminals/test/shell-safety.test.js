const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { bracketedPaste, shellLiteral } = require("../dist/shared.js");

function typeIntoShell(argv, inputs) {
  const spec = JSON.stringify({ argv, inputs, settle_ms: 700 });
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
  test(`${name}: the harness does detect execution (a raw newline runs the command)`, () => {
    const file = marker();
    typeIntoShell(argv, [`touch ${file}\n`]);
    assert.equal(fs.existsSync(file), true, "control payload should have executed");
    fs.rmSync(file, { force: true });
  });

  test(`${name}: a single line full of shell metacharacters and no newline never executes`, () => {
    const file = marker();
    const line = `> [<h2>x</h2>; touch ${file}; echo EXECUTED || touch ${file} | touch ${file} && touch ${file} $(touch ${file}) \`touch ${file}\`]`;
    const output = typeIntoShell(argv, [line, ""]);
    assert.equal(fs.existsSync(file), false, "no newline was sent, nothing may run");
    assert.ok(output.includes("touch"), "the line was typed into the prompt");
  });

  test(`${name}: pressing Enter on the single-quoted payload executes nothing`, () => {
    const file = marker();
    const hostile = `> [<h2>x</h2>; touch ${file}; echo EXECUTED || touch ${file} | touch ${file} && touch ${file} $(touch ${file}) \`touch ${file}\` it's \\ !! ${"$"}HOME > ${file}]`;
    const output = typeIntoShell(argv, [shellLiteral(hostile), "\n", "\n"]);
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

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { encodeCommand, writeStartupFiles } = require("../../dist/zsh/startup.js");
const { parseCompletions } = require("../../dist/completion/complete.js");
const { UndoCheckpoints } = require("../../dist/zsh/undo.js");

const RELAY = `
import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
while True:
    r, _, _ = select.select([fd, 0], [], [])
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data: break
        os.write(fd, data)
`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withZsh(zshrc, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-test-"));
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-test-user-"));
  writeStartupFiles(dir, "nonce");
  fs.writeFileSync(path.join(user, ".zshrc"), zshrc);
  const zsh = spawn("python3", ["-c", RELAY, "/bin/zsh", "-l", "-i"], {
    env: { ...process.env, ZDOTDIR: dir, PXSH_USER_ZDOTDIR: user, PXSH_KEEP_ZDOTDIR: "", TERM: "xterm-256color" },
  });
  let out = "";
  zsh.stdout.on("data", (data) => (out += data));
  const markers = (kind) => [...out.matchAll(new RegExp(`\\x1b\\]6973;nonce;${kind};([^\\x07]*)\\x07`, "g"))].map((m) => m[1].split(";"));
  const lastState = () => {
    const [keymap, cursor, mark, region, buffer, post, pre, highlight] = markers("E").at(-1) ?? [];
    const decode = (text) => text?.replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return { keymap, cursor: Number(cursor), mark: Number(mark), region, buffer: decode(buffer), post: decode(post), pre: decode(pre), highlight: decode(highlight) };
  };
  try {
    for (let i = 0; i < 50 && !markers("E").length; i++) await wait(100);
    await run({ type: (text) => zsh.stdin.write(text), lastState, markers });
  } finally {
    zsh.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    fs.rmSync(user, { recursive: true, force: true, maxRetries: 10 });
  }
}

test("a command and the keys around it reach zle in the order they were sent", async () => {
  await withZsh("", async ({ type, lastState }) => {
    type("abc" + encodeCommand("cursor 1") + "X" + encodeCommand("cursor 0") + "Y");
    await wait(500);
    assert.deepEqual([lastState().buffer, lastState().cursor], ["YaXbc", 1]);
  });
});

test("inserting over a selection replaces it, keeping spaces, semicolons and non-ASCII text", async () => {
  await withZsh("", async ({ type, lastState }) => {
    type("echo hello world" + encodeCommand("select 5 10") + encodeCommand("insert h%c3%a9%3b%20x"));
    await wait(500);
    assert.equal(lastState().buffer, "echo hé; x world");
  });
});

test("the command key is bound in every keymap so its payload is never typed", async () => {
  await withZsh("bindkey -v", async ({ type, lastState }) => {
    type("abc\x1bd" + encodeCommand("cursor 0"));
    await wait(500);
    type("i!");
    await wait(500);
    assert.doesNotMatch(lastState().buffer, /cursor|6973/);
  });
});

test("zle reports ghost text and highlighting, and the prompt reports which selection keys zsh already uses", async () => {
  const zshrc = `_ghost() { zle .self-insert; POSTDISPLAY=" ghost"; region_highlight=("0 1 fg=red") }
zle -N self-insert _ghost
bindkey '^[[1;2D' backward-char`;
  await withZsh(zshrc, async ({ type, lastState, markers }) => {
    type("a");
    await wait(400);
    assert.equal(lastState().post, " ghost");
    assert.equal(lastState().highlight, "0 1 fg=red");
    assert.equal(markers("D").at(-1)[2], "100000");
  });
});

function guiUndo({ type, markers }) {
  const undo = new UndoCheckpoints();
  let seen = 0;
  const catchUp = () => {
    for (const [keymap, cursor, mark, region, buffer, , , , change, history] of markers("E").slice(seen)) {
      const decode = (text) => text.replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      undo.observe({ keymap, cursor: Number(cursor), mark: Number(mark), regionActive: region !== "0", buffer: decode(buffer), postdisplay: "", predisplay: "", highlight: [], change: Number(change), history: Number(history) });
    }
    seen = markers("E").length;
  };
  const press = async (action) => {
    catchUp();
    const step = action === "undo" ? undo.undo() : undo.redo();
    if (step) type(encodeCommand(step.change == null ? step.action : `${step.action} ${step.change}`));
    await wait(400);
  };
  return { catchUp, undo: () => press("undo"), redo: () => press("redo") };
}

test("gui undo and redo move a word at a time through zle's own undo history", async () => {
  await withZsh("", async (zsh) => {
    const gui = guiUndo(zsh);
    zsh.type("git commit -m one");
    await wait(400);
    await gui.undo();
    assert.equal(zsh.lastState().buffer, "git commit -m");
    await gui.undo();
    assert.equal(zsh.lastState().buffer, "git commit");
    await gui.redo();
    assert.equal(zsh.lastState().buffer, "git commit -m");
    await gui.redo();
    assert.equal(zsh.lastState().buffer, "git commit -m one");
    zsh.type("\x1f");
    await wait(400);
    assert.equal(zsh.lastState().buffer, "git commit -m on");
  });
});

test("gui undo reaches into an insert vi mode merged, and vi's u then takes back the rest of it", async () => {
  await withZsh("bindkey -v", async (zsh) => {
    const gui = guiUndo(zsh);
    zsh.type("echo one two");
    await wait(300);
    zsh.type("\x1b");
    await wait(300);
    await gui.undo();
    assert.equal(zsh.lastState().buffer, "echo one");
    zsh.type("u");
    await wait(400);
    assert.equal(zsh.lastState().buffer, "");
    await gui.redo();
    assert.equal(zsh.lastState().buffer, "echo one two");
  });
});

test("ctrl+space's list is zsh's own completion, and accepting a match inserts it the way tab would", async () => {
  const files = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-test-files-"));
  fs.mkdirSync(path.join(files, "my dir"));
  fs.writeFileSync(path.join(files, "my file.txt"), "");
  const zshrc = `autoload -Uz compinit && compinit -D\ncd ${files}`;
  try {
    await withZsh(zshrc, async ({ type, lastState, markers }) => {
      type("ls my" + encodeCommand("complete"));
      await wait(800);
      const list = parseCompletions(markers("M").at(-1).join(";"));
      assert.deepEqual(list.items.map((item) => [item.word, item.directory]), [["my\\ dir", true], ["my\\ file.txt", false]]);
      assert.equal(lastState().buffer, "ls my");
      const file = list.items.find((item) => !item.directory);
      type(encodeCommand(`accept ${list.generation} ${file.index}`));
      await wait(500);
      assert.deepEqual([lastState().buffer, lastState().cursor], ["ls my\\ file.txt ", 16]);
      type(encodeCommand("set cd%20my") + encodeCommand("complete"));
      await wait(800);
      const dirs = parseCompletions(markers("M").at(-1).join(";"));
      type(encodeCommand(`accept ${dirs.generation} ${dirs.items[0].index}`));
      await wait(500);
      assert.equal(lastState().buffer, "cd my\\ dir/");
    });
  } finally {
    fs.rmSync(files, { recursive: true, force: true });
  }
});

test("accepting a match does nothing once the line has changed since the list was made", async () => {
  await withZsh("autoload -Uz compinit && compinit -D", async ({ type, lastState, markers }) => {
    type("ech" + encodeCommand("complete"));
    await wait(800);
    const list = parseCompletions(markers("M").at(-1).join(";"));
    type("o" + encodeCommand(`accept ${list.generation} ${list.items[0].index}`));
    await wait(500);
    assert.equal(lastState().buffer, "echo");
  });
});

test("the history rows are the lines up-arrow visits, and taking one replaces the line with the cursor at its end", async () => {
  const zshrc = `autoload -Uz compinit && compinit -D
print -s 'gcow -b old'
print -s 'git status'
print -s 'gcow -b px-shell'
print -s 'gcow -b old'
print -s 'gco'`;
  await withZsh(zshrc, async ({ type, lastState, markers }) => {
    type("gco" + encodeCommand("complete"));
    await wait(800);
    const list = parseCompletions(markers("M").at(-1).join(";"));
    assert.deepEqual(list.history.map((item) => item.word), ["gcow -b old", "gcow -b px-shell"]);
    type(encodeCommand(`history ${list.generation} 2`));
    await wait(500);
    assert.deepEqual([lastState().buffer, lastState().cursor], ["gcow -b px-shell", 16]);
  });
});

test("with many matching history lines the rows are still the newest ones, in up-arrow order", async () => {
  const zshrc = `autoload -Uz compinit && compinit -D
HISTSIZE=2000
for i in {1..600}; do print -s "gco branch-$i"; done
print -s 'gco branch-599'`;
  await withZsh(zshrc, async ({ type, markers }) => {
    type("gco" + encodeCommand("complete"));
    await wait(1000);
    const list = parseCompletions(markers("M").at(-1).join(";"));
    assert.deepEqual(list.history.map((item) => item.word), ["gco branch-599", "gco branch-600", "gco branch-598", "gco branch-597", "gco branch-596"]);
  });
});

test("zsh hands pxsh its history newest first in chunks, and the newest line at every prompt", async () => {
  const zshrc = `zmodload zsh/parameter
print -s 'one'
print -s 'two; with a semicolon'
print -s 'three'`;
  await withZsh(zshrc, async ({ type, markers }) => {
    type(encodeCommand("history-lines 0 2"));
    await wait(500);
    const [newest, , first] = markers("H").at(-1);
    assert.equal(first.split("\x1e").map((line) => line.replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))).join("|"), "three|two; with a semicolon");
    type(encodeCommand(`history-lines ${Number(newest) - 1} 5`));
    await wait(500);
    assert.equal(markers("H").at(-1)[2], "one");
    type("echo four\r");
    await wait(800);
    const prompt = markers("D").at(-1);
    assert.equal(prompt.slice(3).join(";"), `${Number(newest) + 1};echo four`);
  });
});

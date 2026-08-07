const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { checkTerminal, detect } = require("../dist/index.js");

const FIXTURES = path.join(__dirname, "fixtures");

/** Answers from recorded output, and remembers what was asked. */
function recorder(exec) {
  const commands = [];
  const run = async (bin, args) => {
    const command = [bin, ...args].join(" ");
    commands.push(command);
    const output = exec[command];
    if (output === undefined) throw new Error(`nothing recorded for: ${command}`);
    return output;
  };
  return { run, commands };
}

for (const file of fs.readdirSync(FIXTURES)) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
  const { env, exec, expect } = fixture;

  test(`${expect.name}: knows which pane it is in`, async () => {
    const { run } = recorder(exec);
    const terminal = detect(env, run);
    assert.equal(terminal?.name, expect.name);
    assert.deepEqual(await terminal.getCurrentPane({ tty: null, cwd: "/" }), expect.currentPane);
  });

  test(`${expect.name}: opens a split`, async () => {
    const { run, commands } = recorder(exec);
    const terminal = detect(env, run);
    await terminal.split(expect.split.request);
    assert.deepEqual(commands, expect.split.commands);
  });
}

test("an unknown terminal is nobody", () => {
  assert.equal(detect({ TERM: "xterm-256color" }, async () => ""), null);
});

test("vscode draws but cannot open panes", () => {
  const terminal = detect({ TERM_PROGRAM: "vscode" }, async () => "");
  assert.equal(terminal?.name, "vscode");
  assert.equal(terminal?.split, undefined);
});

// there is no tty here, so nothing answers and recognising the terminal is all we have
test("a terminal we know draws when the tty will not say, a stranger does not", async () => {
  const known = await checkTerminal(detect({ TERM_PROGRAM: "vscode" }, async () => ""), {});
  assert.equal(known.graphics, "supported");
  const stranger = await checkTerminal(detect({ TERM: "xterm-256color" }, async () => ""), {});
  assert.equal(stranger.graphics, "unsupported");
});

test("a multiplexer wins over the terminal it runs in", () => {
  const terminal = detect({ TMUX: "/tmp/x,1,0", TERM_PROGRAM: "ghostty" }, async () => "");
  assert.equal(terminal?.name, "tmux");
});

// a terminal opened from ghostty inherits every ghostty variable, and answering "ghostty"
// there sends apple events from the wrong app — which macOS asks the person to allow
test("a pane variable beats the variables the terminal was launched with", () => {
  const terminal = detect(
    {
      TTY7_PANE: "%3",
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty",
    },
    async () => "",
  );
  assert.equal(terminal?.name, "tty7");
});

// both draw with ghostty's engine and report ghostty everywhere they can
const GHOSTTY_LOOKALIKE = {
  TERM: "xterm-ghostty",
  TERM_PROGRAM: "ghostty",
  GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty",
};

test("cmux is told apart from ghostty by its own variable", () => {
  const env = { ...GHOSTTY_LOOKALIKE, CMUX_SURFACE_ID: "1E1B…", CMUX_SOCKET_PATH: "/tmp/c.sock" };
  assert.equal(detect(env, async () => "")?.name, "cmux");
});

test("supacode is told apart from ghostty by its own variable", () => {
  const env = { ...GHOSTTY_LOOKALIKE, SUPACODE_SURFACE_ID: "9A2F…" };
  assert.equal(detect(env, async () => "")?.name, "supacode");
});

test("plain ghostty is still ghostty", () => {
  assert.equal(detect(GHOSTTY_LOOKALIKE, async () => "")?.name, "ghostty");
});

// ssh carries LC_* across, so a shell on another machine says iTerm2 while osascript there
// would have nothing to talk to. ITERM_SESSION_ID stays behind, so it is the honest signal
test("a session reached over ssh from iTerm2 is not iTerm2", () => {
  const env = { LC_TERMINAL: "iTerm2", LC_TERMINAL_VERSION: "3.7b", TERM: "xterm-256color" };
  assert.equal(detect(env, async () => ""), null);
});

test("a terminal launched from iTerm2 keeps its own name", () => {
  const env = { ...GHOSTTY_LOOKALIKE, ITERM_SESSION_ID: "w0t0p0:0EDDBF06…" };
  assert.equal(detect(env, async () => "")?.name, "ghostty");
});

// the id a shell carries belongs to the session that started it, which may be long gone,
// while the tty it is sitting on is always the session in front of you
test("iTerm2 trusts the tty over the id the shell inherited", async () => {
  const listed = "23551\t1\tLIVE\t/dev/ttys003\n23551\t2\tOTHER\t/dev/ttys004\n";
  const env = { TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t0p0:CLOSED" };
  const terminal = detect(env, async () => listed);
  assert.deepEqual(await terminal.getCurrentPane({ tty: "/dev/ttys003", cwd: "/" }), {
    id: "LIVE",
    tab: "23551:1",
  });
});


const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

function tempHerdrConfig(initialContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-cfg-"));
  const configPath = path.join(dir, "config.toml");
  if (initialContent !== null) fs.writeFileSync(configPath, initialContent);
  return configPath;
}

test("herdr prepare enables kitty graphics from a blank config", async () => {
  const configPath = tempHerdrConfig(null);
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const { run, commands } = recorder({
    "herdr server reload-config": JSON.stringify({ result: { status: "applied" } }),
  });
  await detect(env, run).prepare();
  assert.equal(fs.readFileSync(configPath, "utf8"), "[experimental]\nkitty_graphics = true\n");
  assert.deepEqual(commands, ["herdr server reload-config"]);
});

test("herdr prepare inserts into an existing experimental table instead of duplicating it", async () => {
  const configPath = tempHerdrConfig(
    "onboarding = false\n\n[experimental]\nreveal_hidden_cursor_for_cjk_ime = true\n",
  );
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const { run } = recorder({
    "herdr server reload-config": JSON.stringify({ result: { status: "applied" } }),
  });
  await detect(env, run).prepare();
  const content = fs.readFileSync(configPath, "utf8");
  assert.match(content, /\[experimental\]\nkitty_graphics = true\nreveal_hidden_cursor_for_cjk_ime = true/);
  assert.equal((content.match(/\[experimental\]/g) ?? []).length, 1);
});

test("herdr prepare flips an explicit kitty_graphics = false instead of duplicating the key", async () => {
  const configPath = tempHerdrConfig("[experimental]\nkitty_graphics = false\n");
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const { run } = recorder({
    "herdr server reload-config": JSON.stringify({ result: { status: "applied" } }),
  });
  await detect(env, run).prepare();
  assert.equal(fs.readFileSync(configPath, "utf8"), "[experimental]\nkitty_graphics = true\n");
});

test("herdr prepare leaves an already-enabled config alone and never reloads", async () => {
  const configPath = tempHerdrConfig("[experimental]\nkitty_graphics = true\n");
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const { run, commands } = recorder({});
  await detect(env, run).prepare();
  assert.deepEqual(commands, []);
});

test("herdr prepare stays silent when reload-config rejects the edit", async () => {
  const configPath = tempHerdrConfig(null);
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const { run } = recorder({
    "herdr server reload-config": JSON.stringify({
      result: { status: "failed", diagnostics: ["config parse error"] },
    }),
  });
  const originalError = console.error;
  const warnings = [];
  console.error = (message) => warnings.push(message);
  try {
    await assert.doesNotReject(detect(env, run).prepare());
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(warnings, []);
});

test("herdr prepare stays silent when herdr itself cannot be run", async () => {
  const configPath = tempHerdrConfig(null);
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: configPath };
  const run = async () => {
    throw new Error("spawn herdr ENOENT");
  };
  const originalError = console.error;
  const warnings = [];
  console.error = (message) => warnings.push(message);
  try {
    await assert.doesNotReject(detect(env, run).prepare());
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(warnings, []);
});

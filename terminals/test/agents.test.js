const assert = require("node:assert/strict");
const { test } = require("node:test");

const { codingAgent } = require("../dist/index.js");

const cases = [
  // plain binaries and paths
  ["claude", "claude"],
  ["/opt/homebrew/bin/claude --dangerously-skip-permissions", "claude"],
  ["/nix/store/example/bin/ghcs", "copilot"],
  ["/nix/store/abc/bin/pi", "pi"],
  ["opencode2 --standalone", "opencode"],
  ["agent --resume", "cursor"],
  ["cursor-agent", "cursor"],
  ["grok-macos-aarch64", "grok"],
  ["muse-bin-0.1.0-R708.1", "muse"],
  ["FOO=1 BAR=two codex", "codex"],
  ["/tmp/my-codex-helper", null],
  ["museum", null],
  // nix wrappers report the wrapped name as the process name
  [".codex-wrapped", "codex"],
  [".claude-code-wrapped", "claude"],
  ["/etc/profiles/per-user/user/bin/codex --model gpt-5", "codex"],
  // javascript runtimes
  ["node /path/to/bin/codex", "codex"],
  ["node /x/node_modules/.bin/claude", "claude"],
  ["node /opt/homebrew/bin/with-images claude --dangerously-skip-permissions", "claude"],
  ["node /home/user/.fnm/bin/qwen", "qwen"],
  ["node /usr/local/lib/node_modules/@openai/codex/bin/codex.js --model gpt-5", "codex"],
  ["node -r /x/hook.js /path/to/bin/codex", "codex"],
  ["node --env-file .env /path/to/bin/codex", "codex"],
  ["bun /home/can/.bun/bin/omp", "omp"],
  ["bun /Users/me/.bun/bin/opencode.js", "opencode"],
  ["node.exe C:\\x\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js", "pi"],
  ["node.exe C:\\x\\node_modules\\@qwen-code\\qwen-code\\dist\\index.js", "qwen"],
  ["node.exe C:\\x\\node_modules\\mastracode\\dist\\cli.js", "mastracode"],
  ["C:\\u\\cursor-agent\\versions\\2026.08.11-e8db854\\node.exe C:\\u\\cursor-agent\\versions\\2026.08.11-e8db854\\index.js", "cursor"],
  ["/Users/me/.local/share/claude/versions/2.1.246", "claude"],
  ["node -e console.log(1) /tmp/codex", null],
  ["node ../cli/dist/main.js", null],
  ["node /x/build.js", null],
  // package runners and managers
  ["npx codex", "codex"],
  ["npx @openai/codex --full-auto", "codex"],
  ["bunx pi", "pi"],
  ["pnpm dlx opencode", "opencode"],
  ["uv run hermes", "hermes"],
  ["uvx hermes-agent", "hermes"],
  ["pnpm install", null],
  // python and shells
  ["python3 /tmp/codex --model gpt-5", "codex"],
  ["/nix/store/x/python3.12 /nix/store/y/hermes --resume id", "hermes"],
  ["python3 -c print(1) /tmp/codex", null],
  ["python3 -m antigravity", null],
  ["/bin/sh /tmp/test-bin/pi", "pi"],
  ["bash -c sleep 60 /tmp/codex", null],
  ["-zsh", null],
  ["zsh", null],
  // windows shells
  ["cmd.exe /D /S /C C:\\npm\\codex.cmd --model gpt-5", "codex"],
  ["powershell.exe -NoProfile -File C:\\bin\\claude.ps1", "claude"],
  ["pwsh -EncodedCommand ZQBjAGgAbwA=", null],
  // env and tmux
  ["env FOO=1 claude", "claude"],
  ["tmux new -s claude", null],
  // non-agents that mention agents
  ["vim claude.md", null],
  ["cat", null],
  ["", null],
  // several processes on one tty, newline separated
  ["zsh\nnode /x/bin/claude", "claude"],
];

for (const [command, expected] of cases) {
  test(`codingAgent(${JSON.stringify(command)}) → ${expected}`, () => {
    assert.equal(codingAgent(command), expected);
  });
}

test("accepts argv arrays", () => {
  assert.equal(codingAgent(["node", "/x/bin/claude"]), "claude");
});

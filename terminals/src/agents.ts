import fs from "node:fs";

const AGENTS: Record<string, readonly string[]> = {
  claude: ["claude", "claude-code"],
  codex: ["codex", "codex-cli"],
  gemini: ["gemini", "gemini-cli"],
  cursor: ["cursor", "cursor-agent", "agent"],
  opencode: ["opencode", "opencode2", "open-code", "opencode-ai"],
  pi: ["pi", "pi-coding-agent"],
  copilot: ["copilot", "github-copilot", "ghcs"],
  grok: ["grok", "grok-build"],
  amp: ["amp", "amp-local"],
  aider: ["aider", "aider-chat"],
  goose: ["goose"],
  devin: ["devin", "devin-cli"],
  antigravity: ["agy", "antigravity-cli"],
  cline: ["cline"],
  omp: ["omp"],
  mastracode: ["mastracode", "mastra-code"],
  kimi: ["kimi", "kimi-code", "kimi-cli"],
  kiro: ["kiro", "kiro-cli"],
  droid: ["droid", "factory-droid"],
  hermes: ["hermes", "hermes-agent"],
  kilo: ["kilo", "kilo-code"],
  qodercli: ["qodercli", "qoder", "qodercn", "qoderclicn"],
  qwen: ["qwen", "qwen-code"],
  maki: ["maki"],
  muse: ["muse", "muse-code", "muse-cli"],
  auggie: ["auggie"],
  vibe: ["vibe", "vibe-acp"],
};

const PACKAGE_PATHS: readonly [string, string][] = [
  ["node_modules/@anthropic-ai/claude-code", "claude"],
  [".local/share/claude/versions", "claude"],
  ["node_modules/@openai/codex", "codex"],
  ["node_modules/@google/gemini-cli", "gemini"],
  ["node_modules/@earendil-works/pi-coding-agent", "pi"],
  ["node_modules/@mariozechner/pi-coding-agent", "pi"],
  ["node_modules/@qwen-code/qwen-code", "qwen"],
  ["node_modules/mastracode", "mastracode"],
  ["node_modules/opencode-ai", "opencode"],
  ["cursor-agent/versions", "cursor"],
];

const NODE_LIKE = new Set(["node", "nodejs", "bun", "deno", "tsx", "ts-node"]);
const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);
const NODE_VALUE_FLAGS = new Set([
  "-r", "--require", "--loader", "--import", "--experimental-loader", "--inspect-port",
  "--env-file", "-C", "--conditions", "--title", "-W", "-X", "-S", "-L", "-o",
]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "uvx", "pipx"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "uv"]);
const RUNNER_SUBCOMMANDS = new Set(["run", "dlx", "exec", "x", "tool"]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);
const SUFFIX = /\.(exe|cmd|bat|ps1|js|mjs|cjs|ts|py|rb|sh)$/;

const isPython = (stem: string) => /^python(\d+(\.\d+)*)?$/.test(stem);
const isEnvAssignment = (token: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
const unquote = (token: string) => token.replace(/^["']+|["']+$/g, "");

function basename(token: string): string {
  return token.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

function stem(token: string): string {
  let name = basename(unquote(token)).toLowerCase().replace(SUFFIX, "");
  if (name.startsWith("-")) name = name.slice(1);
  const nix = /^\.(.+)-wrapped$/.exec(name);
  return nix ? nix[1] : name;
}

function agentFromStem(name: string): string | null {
  for (const [agent, aliases] of Object.entries(AGENTS)) {
    if (aliases.includes(name)) return agent;
  }
  if (name.startsWith("grok-")) return "grok";
  if (/^muse-bin-\d/.test(name)) return "muse";
  return null;
}

function agentFromPackagePath(token: string): string | null {
  const normalized = unquote(token).replace(/\\/g, "/").toLowerCase();
  for (const [needle, agent] of PACKAGE_PATHS) {
    if (normalized.includes(`/${needle}/`) || normalized.endsWith(`/${needle}`)) return agent;
  }
  return null;
}

function agentFromPathToken(token: string): string | null {
  const clean = unquote(token);
  if (!clean || clean.startsWith("-")) return null;
  const direct = agentFromStem(stem(clean)) ?? agentFromPackagePath(clean);
  if (direct) return direct;
  if (!/[\\/]/.test(clean)) return null;
  try {
    const real = fs.realpathSync(clean);
    return agentFromStem(stem(real)) ?? agentFromPackagePath(real);
  } catch {
    return null;
  }
}

function positionals(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-"));
}

function agentFromNodeArgs(args: readonly string[]): string | null {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (NODE_EVAL_FLAGS.has(arg)) return null;
    if (NODE_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    rest.push(arg);
  }
  for (const token of rest) {
    const found = agentFromPathToken(token) ?? agentFromSegments(token);
    if (found) return found;
  }
  return null;
}

function agentFromSegments(token: string): string | null {
  for (const segment of unquote(token).split(/[\\/]/)) {
    const found = agentFromStem(segment.toLowerCase().replace(SUFFIX, ""));
    if (found) return found;
  }
  return null;
}

function agentFromArgv(argv: readonly string[]): string | null {
  let start = 0;
  while (start < argv.length && isEnvAssignment(argv[start])) start++;
  const launcher = argv[start];
  if (!launcher) return null;
  const args = argv.slice(start + 1);
  const name = stem(launcher);
  const direct = agentFromStem(name) ?? agentFromPackagePath(launcher);
  if (direct) return direct;

  if (name === "env") {
    return agentFromArgv(args.filter((arg) => !arg.startsWith("-")));
  }
  if (name === "tmux") return null;
  if (NODE_LIKE.has(name)) return agentFromNodeArgs(args);
  if (PACKAGE_RUNNERS.has(name)) {
    const [target] = positionals(args);
    return target ? agentFromPathToken(target) ?? agentFromSegments(target) : null;
  }
  if (PACKAGE_MANAGERS.has(name)) {
    const [subcommand, ...rest] = positionals(args);
    if (!subcommand || !RUNNER_SUBCOMMANDS.has(subcommand)) return null;
    const target = rest[0];
    return target ? agentFromPathToken(target) ?? agentFromSegments(target) : null;
  }
  if (isPython(name)) {
    if (args.some((arg) => arg === "-c" || arg === "-m")) return null;
    const [script] = positionals(args);
    return script ? agentFromPathToken(script) : null;
  }
  if (SHELLS.has(name)) {
    if (args.includes("-c")) return null;
    const [script] = positionals(args);
    return script ? agentFromPathToken(script) : null;
  }
  if (name === "cmd") {
    const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
    if (at < 0) return null;
    const payload = args.slice(at + 1).filter((token) => !["&", ".", "call"].includes(unquote(token).toLowerCase()));
    return payload[0] ? agentFromPathToken(payload[0]) : null;
  }
  if (name === "powershell" || name === "pwsh") {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i].toLowerCase();
      if (flag === "-encodedcommand" || flag === "-ec") return null;
      if ((flag === "-file" || flag === "-f" || flag === "-command" || flag === "-c") && args[i + 1]) {
        return agentFromPathToken(args[i + 1]);
      }
    }
    return null;
  }
  return null;
}
export function codingAgent(command: string | readonly string[] | null | undefined): string | null {
  if (!command) return null;
  const lines = typeof command === "string" ? command.split("\n") : [command.join(" ")];
  for (const line of lines) {
    const argv = line.trim().split(/\s+/).filter(Boolean);
    const found = agentFromArgv(argv);
    if (found) return found;
  }
  return null;
}

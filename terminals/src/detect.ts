import { SKIP_ENV, probeGraphics } from "./graphics";
import type { GraphicsSupport } from "./graphics";
import { shellIn } from "./run";
import type { Run } from "./run";
import type { Terminal } from "./terminal";
import { TERMINALS } from "./terminals";

export function detect(env: NodeJS.ProcessEnv = process.env, run?: Run): Terminal | null {
  const runIn = run ?? shellIn(env);
  for (const recognise of TERMINALS) {
    const terminal = recognise(env, runIn);
    if (terminal) return terminal;
  }
  return null;
}

export interface TerminalCheck {
  terminal: Terminal | null;
  graphics: GraphicsSupport;
}

export async function checkTerminal(
  terminal: Terminal | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TerminalCheck> {
  terminal?.prepare?.();
  if (env[SKIP_ENV]) return { terminal, graphics: "supported" };
  const probed = await probeGraphics(terminal);
  const graphics = probed === "unknown" ? (terminal ? "supported" : "unsupported") : probed;
  return { terminal, graphics };
}

export function cannotOpenPanes(terminal: Terminal | null): string {
  const who = terminal
    ? `${terminal.name} cannot open panes from a command`
    : "terminal-browser does not recognise this terminal";
  const recommendation =
    process.platform === "darwin"
      ? "We recommend Ghostty (https://ghostty.org/download)."
      : "We recommend tmux, kitty (with config changes), or WezTerm (partial support).";
  return `${who}. ${recommendation}`;
}

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
  await terminal?.prepare?.();
  if (env[SKIP_ENV]) return { terminal, graphics: "supported" };
  const probed = await probeGraphics(terminal);
  const graphics = probed === "unknown" ? (terminal ? "supported" : "unsupported") : probed;
  return { terminal, graphics };
}

export function cannotOpenPanes(terminal: Terminal | null): string {
  return terminal ? `could not open pane (unsupported terminal)` : "unrecognized terminal";
}

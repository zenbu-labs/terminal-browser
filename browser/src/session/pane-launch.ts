import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Pane, Terminal } from "@zenbu-labs/pixel/terminal";
import { paneLaunchCommand } from "shared";

const LAUNCH_TTL_MS = 30_000;

interface Launch {
  argv: string[];
  timer: ReturnType<typeof setTimeout>;
}

const launches = new Map<string, Launch>();

export function stashLaunch(argv: string[], token: string = randomUUID()): string {
  dropLaunch(token);
  const timer = setTimeout(() => launches.delete(token), LAUNCH_TTL_MS);
  timer.unref?.();
  launches.set(token, { argv: [...argv], timer });
  return token;
}

export function claimLaunch(token: string): string[] | null {
  const launch = launches.get(token);
  if (!launch) return null;
  dropLaunch(token);
  return launch.argv;
}

export function dropLaunch(token: string) {
  const launch = launches.get(token);
  if (!launch) return;
  clearTimeout(launch.timer);
  launches.delete(token);
}

export function hasPendingLaunches(): boolean {
  return launches.size > 0;
}

export function daemonPaneCommand(env: NodeJS.ProcessEnv, token: string): string[] | null {
  const root = env.TERMINAL_BROWSER_DIST_ROOT ?? process.env.TERMINAL_BROWSER_DIST_ROOT;
  if (root) return paneLaunchCommand(env, [path.join(root, "bin", "terminal-browser")], token);
  const cli = path.resolve(__dirname, "../../../cli/dist/main.js");
  if (!fs.existsSync(cli)) return null;
  return paneLaunchCommand(env, [process.execPath, cli], token, { ELECTRON_RUN_AS_NODE: "1" });
}

export async function launchPane(request: {
  terminal: Terminal;
  from: Pane;
  env: NodeJS.ProcessEnv;
  argv: string[];
  token: string;
  tty: string | null;
}): Promise<boolean> {
  const command = daemonPaneCommand(request.env, request.token);
  if (!command || !request.terminal.split) return false;
  stashLaunch(request.argv, request.token);
  try {
    await request.terminal.split({ from: request.from, direction: "right", command, size: null, tty: request.tty });
  } catch (error) {
    dropLaunch(request.token);
    throw error;
  }
  return true;
}

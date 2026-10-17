import fs from "node:fs";
import path from "node:path";

const RELEASE_ORIGIN = process.env.TERMINAL_BROWSER_RELEASE_ORIGIN ?? "https://github.com/RchrdAriza/terminal-browser-termux/releases/latest/download";

export interface LatestRelease {
  version: string;
  install: string;
}

function distFile(name: string): string | null {
  const root = process.env.TERMINAL_BROWSER_DIST_ROOT;
  if (!root) return null;
  try {
    return fs.readFileSync(path.join(root, name), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function installedVersion(): string | null {
  return distFile("VERSION");
}

export function installedChannel(): string {
  return distFile("CHANNEL") ?? "stable";
}

export function installedByHomebrew(): boolean {
  return process.env.TERMINAL_BROWSER_DIST_ROOT?.split(path.sep).includes("Caskroom") ?? false;
}

export function upgradeCommand(): string {
  return installedByHomebrew() ? "brew upgrade --cask terminal-browser" : "terminal-browser upgrade";
}

export async function fetchLatestRelease(channel: string, signal?: AbortSignal): Promise<LatestRelease> {
  const url = channel === "stable" ? `${RELEASE_ORIGIN}/latest.json` : `${RELEASE_ORIGIN}/${channel}/latest.json`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`release check failed (${response.status} from ${url})`);
  const latest = (await response.json()) as LatestRelease;
  if (!latest.version || !latest.install) throw new Error(`release check failed (bad manifest from ${url})`);
  return latest;
}

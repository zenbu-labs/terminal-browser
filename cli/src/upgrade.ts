import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { instances } from "./registry";
import type { InstanceRecord } from "./registry";

const RELEASE_ORIGIN = process.env.TERMINAL_BROWSER_RELEASE_ORIGIN ?? "https://terminal-browser.sh/install";

interface Latest {
  version: string;
  install: string;
}

export function installedVersion(): string | null {
  const root = process.env.TERMINAL_BROWSER_DIST_ROOT;
  if (!root) return null;
  try {
    return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function installedChannel(): string {
  const root = process.env.TERMINAL_BROWSER_DIST_ROOT;
  if (!root) return "stable";
  try {
    return fs.readFileSync(path.join(root, "CHANNEL"), "utf8").trim() || "stable";
  } catch {
    return "stable";
  }
}

async function fetchLatest(channel: string): Promise<Latest> {
  const url = channel === "stable" ? `${RELEASE_ORIGIN}/latest.json` : `${RELEASE_ORIGIN}/${channel}/latest.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`release check failed (${response.status} from ${url})`);
  const latest = (await response.json()) as Latest;
  if (!latest.version || !latest.install) throw new Error(`release check failed (bad manifest from ${url})`);
  return latest;
}

function describeInstance(record: InstanceRecord): string {
  const page = record.title && record.title !== record.url ? `${record.title}  ${record.url}` : record.url;
  return `  ${record.key}  ${page}`;
}

async function confirmClose(version: string, open: InstanceRecord[]): Promise<boolean> {
  process.stdout.write(`upgrading to ${version} closes these open browsers:\n`);
  process.stdout.write(`${open.map(describeInstance).join("\n")}\n`);
  const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    ask.question("continue? [Y/n] ", resolve);
    ask.on("close", () => resolve("n"));
  });
  ask.close();
  return /^(y|yes|)$/i.test(answer.trim());
}

function runInstaller(url: string): Promise<number> {
  const child = spawn("bash", ["-c", `curl -fsSL '${url}' | bash`], { stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function upgradeCommand(): Promise<number> {
  const current = installedVersion();
  if (!current) {
    throw new Error("Could not perform upgrade: please file an issue https://github.com/zenbu-labs/terminal-browser/issues");
  }
  const latest = await fetchLatest(installedChannel());
  if (latest.version === current) {
    process.stdout.write(`already up to date (${current})\n`);
    return 0;
  }
  if (process.env.TERMINAL_BROWSER_DIST_ROOT?.split(path.sep).includes("Caskroom")) {
    process.stdout.write(`${latest.version} is available. This install is managed by Homebrew, run:\n`);
    process.stdout.write("  brew upgrade --cask terminal-browser\n");
    return 0;
  }
  const open = await instances();
  if (open.length > 0 && process.stdin.isTTY && process.stdout.isTTY) {
    if (!(await confirmClose(latest.version, open))) {
      process.stdout.write("cancelled\n");
      return 0;
    }
  }
  return runInstaller(latest.install);
}

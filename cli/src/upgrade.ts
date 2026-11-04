import { spawn } from "node:child_process";
import readline from "node:readline";

import { fetchLatestRelease, installedByHomebrew, installedChannel, installedVersion } from "shared";

import { oneLine, out } from "./output";
import { instances } from "./registry";
import type { InstanceRecord } from "./registry";

export { installedVersion };

function describeInstance(record: InstanceRecord): string {
  const page = record.title && record.title !== record.url ? `${record.title}  ${record.url}` : record.url;
  return oneLine(`  ${record.key}  ${page}`);
}

async function confirmClose(version: string, open: InstanceRecord[]): Promise<boolean> {
  out(`upgrading to ${version} closes these open browsers:\n`);
  out(`${open.map(describeInstance).join("\n")}\n`);
  const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    ask.question("continue? [Y/n] ", resolve);
    ask.on("close", () => resolve("n"));
  });
  ask.close();
  return /^(y|yes|)$/i.test(answer.trim());
}

function runInstaller(url: string): Promise<number> {
  const download = spawn("curl", ["-fsSL", "--", url], { stdio: ["ignore", "pipe", "inherit"] });
  const child = spawn("bash", [], { stdio: [download.stdout, "inherit", "inherit"] });
  return new Promise((resolve, reject) => {
    download.on("error", reject);
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function upgradeCommand(): Promise<number> {
  const current = installedVersion();
  if (!current) {
    throw new Error("Could not perform upgrade: please file an issue https://github.com/zenbu-labs/terminal-browser/issues");
  }
  const latest = await fetchLatestRelease(installedChannel());
  if (latest.version === current) {
    out(`already up to date (${current})\n`);
    return 0;
  }
  if (installedByHomebrew()) {
    out(`${latest.version} is available. This install is managed by Homebrew, run:\n`);
    out("  brew upgrade --cask terminal-browser\n");
    return 0;
  }
  const open = await instances();
  if (open.length > 0 && process.stdin.isTTY && process.stdout.isTTY) {
    if (!(await confirmClose(latest.version, open))) {
      out("cancelled\n");
      return 0;
    }
  }
  return runInstaller(latest.install);
}

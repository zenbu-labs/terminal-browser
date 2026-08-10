import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import type { Pane } from "./terminal";

export interface CallerTty {
  path: string | null;
  denied: boolean;
}

export function callerTty(): CallerTty {
  let pid = process.pid;
  for (let hops = 0; hops < 30 && pid > 1; hops++) {
    let out: string;
    try {
      out = execFileSync("ps", ["-o", "ppid=,tty=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
    } catch {
      return { path: null, denied: hops === 0 };
    }
    if (!out) return { path: null, denied: hops === 0 };
    const [ppid, tty] = out.split(/\s+/);
    // ps prints "??" on macOS and "?" on linux when a process has no tty
    if (tty && tty !== "??" && tty !== "?") return { path: `/dev/${tty}`, denied: false };
    pid = Number(ppid);
    if (!Number.isFinite(pid)) return { path: null, denied: false };
  }
  return { path: null, denied: false };
}


export function setPaneWorkingDirectory(tty: string, directory: string): void {
  const encoded = directory.split("/").map(encodeURIComponent).join("/");
  fs.writeFileSync(tty, `\x1b]7;file://${os.hostname()}${encoded}\x07`);
}

export async function paneById(
  panes: () => Promise<Pane[]>,
  id: string | null | undefined,
): Promise<Pane | null> {
  if (!id) return null;
  return (await panes()).find((pane) => pane.id === id) ?? null;
}

export function shellQuote(argv: string[]): string {
  return argv
    .map((arg) =>
      arg !== "" && /^[\w\-./:=+@%,]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

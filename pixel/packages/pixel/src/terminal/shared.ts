import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import type { Pane } from "./terminal";

export interface CallerTty {
  path: string | null;
  denied: boolean;
}

export interface PaneRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function adjacentPane(
  from: PaneRect,
  candidates: PaneRect[],
  direction: "right" | "left" | "down" | "up",
  gap = 2,
): PaneRect | null {
  const touches = (candidate: PaneRect) => {
    switch (direction) {
      case "right":
        return candidate.left > from.right && candidate.left <= from.right + gap;
      case "left":
        return candidate.right < from.left && candidate.right >= from.left - gap;
      case "down":
        return candidate.top > from.bottom && candidate.top <= from.bottom + gap;
      case "up":
        return candidate.bottom < from.top && candidate.bottom >= from.top - gap;
    }
  };
  const overlap = (candidate: PaneRect) =>
    direction === "right" || direction === "left"
      ? Math.min(candidate.bottom, from.bottom) - Math.max(candidate.top, from.top)
      : Math.min(candidate.right, from.right) - Math.max(candidate.left, from.left);
  let best: PaneRect | null = null;
  for (const candidate of candidates) {
    if (candidate.id === from.id || !touches(candidate) || overlap(candidate) < 0) continue;
    if (!best || overlap(candidate) > overlap(best)) best = candidate;
  }
  return best;
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

export function shellLiteral(text: string): string {
  return `'${text.replace(/['\\]/g, (char) => (char === "'" ? "'\\''" : "'\\\\'"))}'`;
}

export const PASTE_KEY = "\x16";

export function bracketedPaste(text: string): string {
  if (!text.includes("\n")) return text;
  return `\x1b[200~${text.replaceAll("\x1b[201~", "")}\x1b[201~`;
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export type Direction = "right" | "left" | "down" | "up";

export interface Pane {
  window: string;
  tab: string;
  pane: string;
  title: string;
  self: boolean;
}

export interface Backend {
  app: "ghostty" | "kitty" | "wezterm" | "tmux" | "cmux"
  panes(): Promise<Pane[]>;
  listAll(): Promise<Omit<Pane, "self">[]>;
  split(direction: Direction, command: string[], size?: number | null): Promise<void>;
  focusPane(titleNeedle: string): Promise<boolean>;
  focusSelf(): Promise<boolean>;
  sendText(paneId: string, text: string): Promise<boolean>;
  resizePane?(titleNeedle: string, grow: Direction, points: number): Promise<boolean>;
  closePane?(titleNeedle: string): Promise<boolean>;
  zoomPane?(titleNeedle: string): Promise<boolean>;
}

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
    if (tty && tty !== "??") return { path: `/dev/${tty}`, denied: false };
    pid = Number(ppid);
    if (!Number.isFinite(pid)) return { path: null, denied: false };
  }
  return { path: null, denied: false };
}

export function setPaneTitle(tty: string, title: string): void {
  fs.writeFileSync(tty, `\x1b]2;${title}\x07`);
}

export function setPaneWorkingDirectory(tty: string, directory: string): void {
  const encoded = directory.split("/").map(encodeURIComponent).join("/");
  fs.writeFileSync(tty, `\x1b]7;file://${os.hostname()}${encoded}\x07`);
}

export function shellQuote(argv: string[]): string {
  return argv
    .map((arg) =>
      arg !== "" && /^[\w\-./:=+@%,]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

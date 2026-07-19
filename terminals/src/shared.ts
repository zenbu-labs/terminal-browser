import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type Direction = "right" | "left" | "down" | "up";

export interface Pane {
  window: string;
  tab: string;
  pane: string;
  title: string;
  self: boolean;
}

export interface Backend {
  app: "ghostty" | "kitty" | "wezterm";
  panes(): Promise<Pane[]>;
  listAll(): Promise<Omit<Pane, "self">[]>;
  split(direction: Direction, command: string[], cwd: string): Promise<void>;
  focusPane(titleNeedle: string): Promise<boolean>;
  focusSelf(): Promise<boolean>;
  sendText(paneId: string, text: string): Promise<boolean>;
  /** grow (positive) or shrink (negative) the pane by points along the given
   * split axis; only backends that support it define this */
  resizePane?(titleNeedle: string, grow: Direction, points: number): Promise<boolean>;
  /** close the pane whose title contains the needle; only backends that can
   * close without a confirmation prompt define this */
  closePane?(titleNeedle: string): Promise<boolean>;
  /** toggle split zoom on the pane whose title contains the needle */
  zoomPane?(titleNeedle: string): Promise<boolean>;
}

export function callerTty(): string | null {
  let pid = process.pid;
  for (let hops = 0; hops < 30 && pid > 1; hops++) {
    let out: string;
    try {
      out = execFileSync("ps", ["-o", "ppid=,tty=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
    } catch {
      return null;
    }
    if (!out) return null;
    const [ppid, tty] = out.split(/\s+/);
    if (tty && tty !== "??") return `/dev/${tty}`;
    pid = Number(ppid);
    if (!Number.isFinite(pid)) return null;
  }
  return null;
}

/** Sets the terminal window/pane title via OSC 2. Pane self-identification
 * rides on this: a unique title marker written to a tty shows up in the
 * terminal's pane listing. */
export function setPaneTitle(tty: string, title: string): void {
  fs.writeFileSync(tty, `\x1b]2;${title}\x07`);
}

export function shellQuote(argv: string[]): string {
  return argv.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LogLine {
  at: number;
  level: string;
  target: string;
  message: string;
}

const KEEP_LINES = 500;

function logFile(pid: number): string {
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(state, "pixel", "logs", `${pid}.jsonl`);
}

// Follows each engine's log file from where the last poll stopped.
export class EngineLog {
  private offsets = new Map<number, number>();
  private lines = new Map<number, LogLine[]>();

  hasLog(pid: number): boolean {
    return fs.existsSync(logFile(pid));
  }

  poll(pids: number[]): Map<number, LogLine[]> {
    for (const pid of pids) this.read(pid);
    for (const pid of [...this.lines.keys()]) {
      if (!pids.includes(pid)) {
        this.lines.delete(pid);
        this.offsets.delete(pid);
      }
    }
    return this.lines;
  }

  private read(pid: number): void {
    const file = logFile(pid);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    const offset = this.offsets.get(pid) ?? 0;
    const start = size < offset ? 0 : offset;
    if (size === start) return;
    const buffer = Buffer.alloc(size - start);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return;
    this.offsets.set(pid, start + Buffer.byteLength(text.slice(0, lastNewline + 1)));
    const list = this.lines.get(pid) ?? [];
    for (const line of text.slice(0, lastNewline).split("\n")) {
      let parsed: { t?: number; level?: string; target?: string; message?: string };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed.message !== "string" || typeof parsed.t !== "number") continue;
      list.push({ at: parsed.t, level: parsed.level ?? "info", target: parsed.target ?? "", message: parsed.message });
    }
    this.lines.set(pid, list.slice(-KEEP_LINES));
  }
}

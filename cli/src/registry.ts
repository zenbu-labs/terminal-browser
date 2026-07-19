import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REGISTRY_DIR = path.join(os.homedir(), ".pixel-browser", "instances");

export interface InstanceRecord {
  tabs?: unknown;
  viewport?: { width: number; height: number } | null;
  pid: number;
  /** unique per pane; daemon sessions share a pid, so target panes by key */
  key?: string;
  tty: string | null;
  socket: string;
  cdpPort: number | null;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  startedAt: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function instances(): InstanceRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(REGISTRY_DIR);
  } catch {
    return [];
  }
  const records: InstanceRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(REGISTRY_DIR, entry);
    let record: InstanceRecord;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8")) as InstanceRecord;
    } catch {
      continue;
    }
    if (!alive(record.pid)) {
      fs.rmSync(file, { force: true });
      fs.rmSync(record.socket, { force: true });
      continue;
    }
    records.push(record);
  }
  return records.sort((a, b) => a.startedAt - b.startedAt);
}

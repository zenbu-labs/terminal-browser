import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERIES = ["terminal", "total", "engine", "gpu"] as const;
export type SeriesKey = (typeof SERIES)[number];

export interface Point {
  t: number;
  values: Record<SeriesKey, number>;
}

export interface Recording {
  id: string;
  name: string;
  browser: string;
  startedAt: number;
  points: Point[];
}

function dir(): string {
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(state, "terminal-browser", "monitor");
}

export function loadRecordings(): Recording[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const recordings: Recording[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir(), name), "utf8")) as Recording;
      if (Array.isArray(parsed.points) && typeof parsed.startedAt === "number") recordings.push(parsed);
    } catch {}
  }
  return recordings.sort((a, b) => a.startedAt - b.startedAt);
}

export function saveRecording(recording: Recording): string {
  fs.mkdirSync(dir(), { recursive: true });
  const file = path.join(dir(), `${recording.id}.json`);
  fs.writeFileSync(file, JSON.stringify(recording));
  return file;
}

export function deleteRecording(id: string): void {
  try {
    fs.unlinkSync(path.join(dir(), `${id}.json`));
  } catch {}
}

export function newRecording(browser: string): Recording {
  const startedAt = Date.now();
  const stamp = new Date(startedAt);
  const name = `${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}:${String(stamp.getSeconds()).padStart(2, "0")} ${browser}`;
  return { id: String(startedAt), name, browser, startedAt, points: [] };
}

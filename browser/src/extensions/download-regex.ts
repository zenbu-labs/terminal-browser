import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export const INVALID_FILTER = "Invalid query filter";
const MATCH_TIMEOUT_MS = 2_000;
const IDLE_MS = 30_000;

export interface RegexFilter {
  pattern: string;
  subjects: string[];
}

export interface RegexRequest {
  id: number;
  filters: RegexFilter[];
}

export type RegexReply = { id: number; results: boolean[][] } | { id: number; invalid: true };

interface Waiting {
  resolve(results: boolean[][]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface RegexWorker {
  worker: Worker;
  waiting: Map<number, Waiting>;
  idle: ReturnType<typeof setTimeout> | null;
}

const workers = new Map<string, RegexWorker>();
let nextId = 0;

function workerPath(): string {
  const candidates = [path.join(__dirname, "regex-worker.js"), path.join(__dirname, "..", "regex-worker.js")];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`regex-worker.js missing (looked in ${candidates.join(", ")})`);
  return found;
}

function stop(extensionId: string, entry: RegexWorker) {
  if (workers.get(extensionId) === entry) workers.delete(extensionId);
  if (entry.idle) clearTimeout(entry.idle);
  for (const waiting of entry.waiting.values()) {
    clearTimeout(waiting.timer);
    waiting.reject(new Error(INVALID_FILTER));
  }
  entry.waiting.clear();
  void entry.worker.terminate();
}

function regexWorker(extensionId: string): RegexWorker {
  const existing = workers.get(extensionId);
  if (existing) return existing;
  const entry: RegexWorker = { worker: new Worker(workerPath()), waiting: new Map(), idle: null };
  entry.worker.unref();
  entry.worker.on("message", (reply: RegexReply) => {
    const waiting = entry.waiting.get(reply.id);
    if (!waiting) return;
    entry.waiting.delete(reply.id);
    clearTimeout(waiting.timer);
    if ("invalid" in reply) waiting.reject(new Error(INVALID_FILTER));
    else waiting.resolve(reply.results);
    if (entry.waiting.size === 0) entry.idle = setTimeout(() => stop(extensionId, entry), IDLE_MS).unref();
  });
  entry.worker.on("error", () => stop(extensionId, entry));
  entry.worker.on("exit", () => stop(extensionId, entry));
  workers.set(extensionId, entry);
  return entry;
}

// Extension patterns use Chrome's RE2 syntax and run off the main thread in a
// worker per extension, so one extension's slow pattern only fails its own searches.
export function matchRegexFilters(extensionId: string, filters: RegexFilter[]): Promise<boolean[][]> {
  if (filters.length === 0) return Promise.resolve([]);
  const entry = regexWorker(extensionId);
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = null;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stop(extensionId, entry), MATCH_TIMEOUT_MS);
    entry.waiting.set(id, { resolve, reject, timer });
    entry.worker.postMessage({ id, filters } satisfies RegexRequest);
  });
}

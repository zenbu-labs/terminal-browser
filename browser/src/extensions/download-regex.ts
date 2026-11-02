import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export const INVALID_FILTER = "Invalid query filter";
const MATCH_TIMEOUT_MS = 2_000;

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
  worker: Worker;
  resolve(results: boolean[][]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, Waiting>();

function workerPath(): string {
  const candidates = [path.join(__dirname, "regex-worker.js"), path.join(__dirname, "..", "regex-worker.js")];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`regex-worker.js missing (looked in ${candidates.join(", ")})`);
  return found;
}

function failAll(stopped: Worker, error: Error) {
  for (const [id, entry] of waiting) {
    if (entry.worker !== stopped) continue;
    clearTimeout(entry.timer);
    entry.reject(error);
    waiting.delete(id);
  }
}

function regexWorker(): Worker {
  if (worker) return worker;
  const started = new Worker(workerPath());
  started.unref();
  started.on("message", (reply: RegexReply) => {
    const entry = waiting.get(reply.id);
    if (!entry) return;
    waiting.delete(reply.id);
    clearTimeout(entry.timer);
    if ("invalid" in reply) entry.reject(new Error(INVALID_FILTER));
    else entry.resolve(reply.results);
  });
  const stopped = () => {
    if (worker === started) worker = null;
    failAll(started, new Error(INVALID_FILTER));
  };
  started.on("error", stopped);
  started.on("exit", stopped);
  worker = started;
  return started;
}

// Extension patterns use Chrome's RE2 syntax and run off the main thread, so a
// pattern that takes too long gives up instead of freezing the browser.
export function matchRegexFilters(filters: RegexFilter[]): Promise<boolean[][]> {
  if (filters.length === 0) return Promise.resolve([]);
  const target = regexWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(INVALID_FILTER));
      if (worker === target) worker = null;
      void target.terminate();
    }, MATCH_TIMEOUT_MS);
    waiting.set(id, { worker: target, resolve, reject, timer });
    target.postMessage({ id, filters } satisfies RegexRequest);
  });
}

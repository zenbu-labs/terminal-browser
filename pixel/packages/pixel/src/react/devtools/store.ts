import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    update(fn) {
      this.set(fn(value));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRow {
  id: number;
  level: LogLevel;
  target: string;
  text: string;
  epochMs: number;
  count: number;
}

export interface LogBuffer {
  rows: LogRow[];
  version: number;
}

const LOG_CAP = 2000;

export function createLogStore() {
  const store = createStore<LogBuffer>({ rows: [], version: 0 });
  let nextId = 1;
  return {
    store,
    push(level: LogLevel, target: string, text: string, epochMs?: number) {
      store.update((buffer) => {
        const rows = buffer.rows.slice(-LOG_CAP);
        const last = rows[rows.length - 1];
        if (last && last.text === text && last.level === level && last.target === target) {
          rows[rows.length - 1] = { ...last, count: last.count + 1 };
        } else {
          rows.push({
            id: nextId++,
            level,
            target,
            text,
            epochMs: epochMs ?? Date.now(),
            count: 1,
          });
        }
        return { rows, version: buffer.version + 1 };
      });
    },
    clear() {
      store.update((buffer) => ({ rows: [], version: buffer.version + 1 }));
    },
  };
}

export type LogStore = ReturnType<typeof createLogStore>;

import { useSyncExternalStore } from "react";

import type { TerminalColors } from "./native";

const UNKNOWN: TerminalColors = { foreground: null, background: null, palette: [] };

let snapshot: TerminalColors = UNKNOWN;
const listeners = new Set<() => void>();

export function publishColors(colors: TerminalColors): void {
  snapshot = colors;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read() {
  return snapshot;
}


export function useTerminalColors(): TerminalColors {
  return useSyncExternalStore(subscribe, read);
}

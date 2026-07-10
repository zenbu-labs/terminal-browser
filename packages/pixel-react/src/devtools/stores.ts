import { createLogStore, createStore } from "./store";

/** Logs printed by the user's program (console.*, stdout, stderr). */
export const consoleLogs = createLogStore();

/** Logs emitted by the engine and bridge. */
export const engineLogs = createLogStore();

export interface LayoutRect {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  vw: number;
  vh: number;
  scroll?: number;
  scrollMax?: number;
  text?: string;
}

export interface LayoutSnapshot {
  rects: Map<number, LayoutRect>;
  stats: { frameMs: number; fps: number };
  width: number;
  height: number;
  at: number;
}

export const layoutStore = createStore<LayoutSnapshot>({
  rects: new Map(),
  stats: { frameMs: 0, fps: 0 },
  width: 0,
  height: 0,
  at: 0,
});

export interface InspectorState {
  selectedId: number | null;
  expanded: ReadonlySet<number>;
  picking: boolean;
  /** Bumped by the host config whenever the app tree mutates. */
  treeVersion: number;
}

export const inspectorStore = createStore<InspectorState>({
  selectedId: null,
  expanded: new Set(),
  picking: false,
  treeVersion: 0,
});

export interface TimeSpan {
  name: string;
  /** Wall-clock epoch ms, so engine and JS spans share one axis. */
  start: number;
  dur: number;
  depth: number;
  lane: "react" | "bridge" | "engine" | "devtools-engine" | "interaction";
  self?: number;
  arg?: number;
}

export interface CounterSample {
  name: string;
  /** Wall-clock epoch ms, like TimeSpan.start. */
  at: number;
  value: number;
}

export interface ProfileSession {
  spans: TimeSpan[];
  start: number;
  end: number;
  frames: TimeSpan[];
  counters: CounterSample[];
  /** User input during the recording, as lane 'interaction' pseudo-spans. */
  marks: TimeSpan[];
}

export interface ProfilerState {
  recording: boolean;
  /** Set while waiting for the engine to send its half of the recording. */
  pendingStop: boolean;
  session: ProfileSession | null;
  startedAt: number;
}

export const profilerStore = createStore<ProfilerState>({
  recording: false,
  pendingStop: false,
  session: null,
  startedAt: 0,
});

/** JS-side spans accumulated during an active recording. */
export const pendingSpans: TimeSpan[] = [];

export function recordSpan(span: TimeSpan) {
  if (!profilerStore.get().recording) return;
  pendingSpans.push(span);
}

export interface DevtoolsState {
  open: boolean;
  tab: "elements" | "console" | "engine" | "profiler";
  width: number;
  height: number;
  basePx: number;
}

export const devtoolsStore = createStore<DevtoolsState>({
  open: false,
  tab: "elements",
  width: 0,
  height: 0,
  basePx: 16,
});

import type { Rgba } from "../native";
import { createLogStore, createStore } from "./store";

export const consoleLogs = createLogStore();

export const engineLogs = createLogStore();

export interface BoxEdges {
  l: number;
  t: number;
  r: number;
  b: number;
}

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
  padding?: BoxEdges;
  border?: BoxEdges;
  margin?: BoxEdges;
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
  start: number;
  dur: number;
  depth: number;
  lane: "react" | "bridge" | "engine" | "devtools-engine" | "images" | "interaction";
  self?: number;
  arg?: number;
  label?: string;
}

export interface CounterSample {
  name: string;
  at: number;
  value: number;
}

export interface ProfileSession {
  spans: TimeSpan[];
  start: number;
  end: number;
  frames: TimeSpan[];
  counters: CounterSample[];
  marks: TimeSpan[];
}

export interface ProfilerState {
  recording: boolean;
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

export const pendingSpans: TimeSpan[] = [];

export function recordSpan(span: TimeSpan) {
  if (!profilerStore.get().recording) return;
  pendingSpans.push(span);
}

export interface DevtoolsState {
  open: boolean;
  tab: "elements" | "console" | "profiler";
  width: number;
  height: number;
  basePx: number;
  cpuRate: number;
  background: Rgba | null;
}

export const devtoolsStore = createStore<DevtoolsState>({
  open: false,
  tab: "elements",
  width: 0,
  height: 0,
  basePx: 16,
  cpuRate: 1,
  background: null,
});

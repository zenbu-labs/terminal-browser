import { createElement } from "react";
import { ConcurrentRoot } from "react-reconciler/constants";

import {
  APP_VIEW,
  Container,
  DEVTOOLS_VIEW,
  getBridge,
  Instance,
  reconciler,
} from "../reconciler-config";
import { DevtoolsApp } from "./app";
import {
  devtoolsStore,
  inspectorStore,
  pendingSpans,
  ProfileSession,
  profilerStore,
  TimeSpan,
} from "./stores";

export const DEFAULT_SPLIT = 0.58;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let devtoolsRoot: any = null;

export function engineOp(op: Record<string, unknown>) {
  const b = getBridge();
  b.push(DEVTOOLS_VIEW, op);
  b.flush();
}

function mountDevtools() {
  if (devtoolsRoot) return;
  const b = getBridge();
  const container: Container = { bridge: b, view: DEVTOOLS_VIEW, children: [] };
  b.containers[DEVTOOLS_VIEW] = container;
  devtoolsRoot = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    "pixel-devtools",
    () => { },
    null
  );
  reconciler.updateContainer(createElement(DevtoolsApp), devtoolsRoot, null, null);
}

export function openDevtools(selectId?: number) {
  mountDevtools();
  devtoolsStore.update((s) => ({ ...s, open: true }));
  if (selectId != null) selectNode(selectId, true);
  engineOp({ op: "setSplit", fraction: DEFAULT_SPLIT });
}

export function closeDevtools() {
  devtoolsStore.update((s) => ({ ...s, open: false }));
  setHighlight(null);
  engineOp({ op: "setSplit", fraction: null });
}

export function toggleDevtools() {
  if (devtoolsStore.get().open) closeDevtools();
  else openDevtools();
}

export function unmountDevtools() {
  if (!devtoolsRoot) return;
  reconciler.flushSync(() => {
    reconciler.updateContainer(null, devtoolsRoot, null, null);
  });
  devtoolsRoot = null;
  getBridge().containers[DEVTOOLS_VIEW] = null;
}

export function findInstance(id: number): Instance | null {
  const container = getBridge().containers[APP_VIEW];
  if (!container) return null;
  const stack: Instance[] = [...container.children];
  while (stack.length) {
    const instance = stack.pop()!;
    if (instance.id === id) return instance;
    stack.push(...instance.children);
  }
  return null;
}

function isInstance(node: Instance | Container): node is Instance {
  return (node as Instance).type !== undefined;
}

export function selectNode(id: number, reveal = false) {
  inspectorStore.update((state) => {
    const expanded = new Set(state.expanded);
    if (reveal) {
      let node = findInstance(id)?.parent ?? null;
      while (node && isInstance(node)) {
        expanded.add(node.id);
        node = node.parent;
      }
    }
    return { ...state, selectedId: id, expanded, picking: false };
  });
}

export type HighlightArea = "content" | "padding" | "border" | "margin";

let highlightTimer: ReturnType<typeof setTimeout> | null = null;

export function setHighlight(id: number | null, area?: HighlightArea) {
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  engineOp({ op: "highlight", view: APP_VIEW, id, area });
}


export function setPicking(on: boolean) {
  inspectorStore.update((s) => ({ ...s, picking: on }));
  engineOp({ op: "setInspectMode", on });
}

export function toggleExpanded(id: number) {
  inspectorStore.update((state) => {
    const expanded = new Set(state.expanded);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    return { ...state, expanded };
  });
}

export function setCpuThrottle(rate: number) {
  devtoolsStore.update((s) => ({ ...s, cpuRate: rate }));
  engineOp({ op: "setCpuThrottle", rate });
}

export function requestLayout() {
  const b = getBridge();
  b.push(APP_VIEW, { op: "queryLayout" });
  b.flush();
}

// A heartbeat that misses its slot means the node event loop was blocked by
// synchronous work; the missed window becomes a span so profile gaps where
// "nothing ran" get an explanation.
const STALL_TICK_MS = 25;
const STALL_REPORT_MS = 60;
let stallTimer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;

function startStallWatch() {
  lastTick = performance.timeOrigin + performance.now();
  stallTimer = setInterval(() => {
    const now = performance.timeOrigin + performance.now();
    const gap = now - lastTick;
    if (gap > STALL_REPORT_MS) {
      pendingSpans.push({
        name: `js event-loop stall (${Math.round(gap)}ms)`,
        start: lastTick,
        dur: gap,
        depth: 1,
        lane: "bridge",
      });
    }
    lastTick = now;
  }, STALL_TICK_MS);
}

function stopStallWatch() {
  if (stallTimer) {
    clearInterval(stallTimer);
    stallTimer = null;
  }
}

export function startRecording() {
  pendingSpans.length = 0;
  profilerStore.set({
    recording: true,
    pendingStop: false,
    session: null,
    startedAt: Date.now(),
  });
  startStallWatch();
  engineOp({ op: "profileStart" });
}

export function stopRecording() {
  stopStallWatch();
  profilerStore.update((s) => ({ ...s, recording: false, pendingStop: true }));
  engineOp({ op: "profileStop" });
}

export function clearRecording() {
  stopStallWatch();
  pendingSpans.length = 0;
  profilerStore.set({ recording: false, pendingStop: false, session: null, startedAt: 0 });
}

interface EngineProfileEvent {
  epochMs: number;
  spans: Array<{
    name: string;
    start: number;
    dur: number;
    depth: number;
    view: number;
    arg?: number | null;
    label?: string | null;
  }>;
  counters?: Array<{ name: string; at: number; value: number }>;
  marks?: Array<{ name: string; label: string; start: number; dur: number; view: number }>;
}

const IMAGE_LANE_NAMES = new Set(["image.wait", "image.decode", "image.encode"]);

// Waits can overlap (several images in flight), so unlike call-stack lanes
// their rows are packed here: each wait takes a free row pair, its decode
// sits on the row below, matched by the shared per-image arg.
function packImageRows(spans: TimeSpan[]) {
  const waits = spans.filter((s) => s.lane === "images" && s.name === "image.wait");
  const rowEnds: number[] = [];
  const rowByArg = new Map<number, number>();
  for (const wait of waits) {
    let row = rowEnds.findIndex((end) => wait.start >= end + 0.1);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(0);
    }
    rowEnds[row] = wait.start + wait.dur;
    wait.depth = row * 2;
    if (wait.arg != null) rowByArg.set(wait.arg, row * 2);
  }
  for (const span of spans) {
    if (span.lane === "images" && span.name !== "image.wait") {
      span.depth = (span.arg != null ? rowByArg.get(span.arg) ?? 0 : 0) + 1;
    }
  }
}

export function onEngineProfile(data: EngineProfileEvent) {
  const engineSpans: TimeSpan[] = data.spans.map((s) => ({
    name: s.name,
    start: data.epochMs + s.start,
    dur: s.dur,
    depth: s.depth,
    lane: IMAGE_LANE_NAMES.has(s.name)
      ? "images"
      : s.view === DEVTOOLS_VIEW
        ? "devtools-engine"
        : "engine",
    arg: s.arg ?? undefined,
    label: s.label ?? undefined,
  }));
  const spans = [...pendingSpans, ...engineSpans].sort((a, b) => a.start - b.start);
  packImageRows(spans);
  pendingSpans.length = 0;
  if (spans.length === 0) {
    profilerStore.update((s) => ({ ...s, pendingStop: false, session: null }));
    return;
  }
  let start = Infinity;
  let end = -Infinity;
  for (const span of spans) {
    start = Math.min(start, span.start);
    end = Math.max(end, span.start + span.dur);
  }
  const frames = engineSpans.filter((s) => s.name === "frame" && s.depth === 0);
  const counters = (data.counters ?? []).map((c) => ({
    name: c.name,
    at: data.epochMs + c.at,
    value: c.value,
  }));
  const marks: TimeSpan[] = (data.marks ?? []).map((m) => ({
    name: m.view === DEVTOOLS_VIEW ? `[devtools] ${m.label}` : m.label,
    start: data.epochMs + m.start,
    dur: m.dur,
    depth: 0,
    lane: "interaction",
  }));
  const session: ProfileSession = { spans, frames, start, end, counters, marks };
  profilerStore.update((s) => ({ ...s, pendingStop: false, session }));
}

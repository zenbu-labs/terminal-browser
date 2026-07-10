import React, { useEffect, useState } from "react";

import { Box, Text } from "../components";
import { clearRecording, startRecording, stopRecording } from "./controller";
import { exportProfile } from "./exportProfile";
import { createStore, useStore } from "./store";
import { devtoolsStore, ProfileSession, profilerStore, TimeSpan } from "./stores";
import { MONO, theme } from "./theme";
import { Button, Divider, Empty, Toolbar } from "./ui";

interface Viewport {
  t0: number;
  t1: number;
}

export const viewportStore = createStore<Viewport | null>(null);
const selectedSpanStore = createStore<TimeSpan | null>(null);

/** W/S zoom, A/D pan, F fits the whole recording — Chrome's flame chart keys. */
export function profilerHandleKey(key: string): boolean {
  const session = profilerStore.get().session;
  const viewport = viewportStore.get();
  if (!session || !viewport) return false;
  const span = viewport.t1 - viewport.t0;
  const center = (viewport.t0 + viewport.t1) / 2;
  switch (key) {
    case "w": {
      const next = Math.max(span / 1.4, 0.05);
      viewportStore.set({ t0: center - next / 2, t1: center + next / 2 });
      return true;
    }
    case "s": {
      const next = Math.min(span * 1.4, session.end - session.start || 1);
      viewportStore.set(clampViewport({ t0: center - next / 2, t1: center + next / 2 }, session));
      return true;
    }
    case "a":
      viewportStore.set(clampViewport({ t0: viewport.t0 - span * 0.2, t1: viewport.t1 - span * 0.2 }, session));
      return true;
    case "d":
      viewportStore.set(clampViewport({ t0: viewport.t0 + span * 0.2, t1: viewport.t1 + span * 0.2 }, session));
      return true;
    case "f":
      viewportStore.set({ t0: session.start, t1: session.end });
      return true;
    default:
      return false;
  }
}

function clampViewport(viewport: Viewport, session: ProfileSession): Viewport {
  const span = viewport.t1 - viewport.t0;
  let t0 = Math.max(viewport.t0, session.start - span * 0.1);
  const t1 = Math.min(t0 + span, session.end + span * 0.1);
  t0 = t1 - span;
  return { t0, t1 };
}

function laneColor(span: TimeSpan): string {
  const palettes = {
    react: theme.flame.react,
    bridge: theme.flame.bridge,
    engine: theme.flame.engine,
    "devtools-engine": theme.flame.devtools,
  } as const;
  const palette = palettes[span.lane];
  let hash = 0;
  for (let i = 0; i < span.name.length; i++) hash = (hash * 31 + span.name.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function frameColor(dur: number): string {
  if (dur < 8) return theme.ok;
  if (dur < 17) return theme.warn;
  return theme.danger;
}

function Overview(props: {
  session: ProfileSession;
  width: number;
  viewport: Viewport;
  rem: number;
}) {
  const { session, width, viewport, rem } = props;
  const height = rem * 2.4;
  const range = Math.max(session.end - session.start, 0.001);
  const scale = width / range;
  const frames = session.frames.slice(0, 2000);
  return (
    <Box
      style={{ height, background: theme.bg, flexShrink: 0, overflow: "hidden" }}
    >
      {frames.map((frame, i) => {
        const x = (frame.start - session.start) * scale;
        const w = Math.max(frame.dur * scale, 1.5);
        const h = Math.max(3, Math.min(frame.dur / 33, 1) * (height - 4));
        return (
          <Box
            key={i}
            style={{
              position: "absolute",
              inset: { left: x, bottom: 2 },
              width: w,
              height: h,
              background: frameColor(frame.dur),
              cornerRadius: 1,
            }}
            onClick={() => {
              const pad = Math.max(frame.dur, 4);
              viewportStore.set({ t0: frame.start - pad, t1: frame.start + frame.dur + pad });
            }}
          />
        );
      })}
      <Box
        style={{
          position: "absolute",
          inset: { left: (viewport.t0 - session.start) * scale, top: 0 },
          width: Math.max((viewport.t1 - viewport.t0) * scale, 2),
          height,
          background: "#4d9fff22",
          border: { width: 1, color: theme.accent },
        }}
      />
    </Box>
  );
}

const LANES: Array<{ label: string; match: (span: TimeSpan) => boolean }> = [
  { label: "React", match: (s) => s.lane === "react" || s.lane === "bridge" },
  { label: "Engine", match: (s) => s.lane === "engine" },
  { label: "Engine (devtools)", match: (s) => s.lane === "devtools-engine" },
];

function Lane(props: {
  label: string;
  spans: TimeSpan[];
  viewport: Viewport;
  width: number;
  rem: number;
  selected: TimeSpan | null;
}) {
  const { label, spans, viewport, width, rem, selected } = props;
  const rowH = rem * 1.05;
  const scale = width / (viewport.t1 - viewport.t0);
  const visible: TimeSpan[] = [];
  let maxDepth = 0;
  let lastEnd = -Infinity;
  for (const span of spans) {
    if (span.start + span.dur < viewport.t0 || span.start > viewport.t1) continue;
    // Sub-pixel spans collapse into one marker per pixel column instead of
    // disappearing, so a zoomed-out chart still shows where work happened.
    if (span.dur * scale < 0.4 && span.depth === 0) {
      if ((span.start - lastEnd) * scale < 1.2) continue;
      lastEnd = span.start + span.dur;
    } else if (span.dur * scale < 0.4) {
      continue;
    }
    visible.push(span);
    if (span.depth > maxDepth) maxDepth = span.depth;
    if (visible.length >= 600) break;
  }
  return (
    <Box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Box style={{ padding: { left: rem * 0.5, top: rem * 0.25, bottom: rem * 0.1 } }}>
        <Text style={{ color: theme.faint, fontSize: rem * 0.62, wrap: false }}>{label}</Text>
      </Box>
      <Box style={{ height: (maxDepth + 1) * rowH + 2, overflow: "hidden" }}>
        {visible.map((span, i) => {
          // Clamp to the viewport so labels stay readable when a span
          // extends past the left edge.
          const rawX = (span.start - viewport.t0) * scale;
          const right = rawX + Math.max(span.dur * scale - 0.5, 1.5);
          const x = Math.max(rawX, 0);
          const w = Math.max(right - x, 1.5);
          const isSelected = selected === span;
          return (
            <Box
              key={i}
              style={{
                position: "absolute",
                inset: { left: x, top: span.depth * rowH },
                width: w,
                height: rowH - 1,
                background: laneColor(span),
                border: isSelected ? { width: 1, color: "#ffffff" } : undefined,
                cornerRadius: 1,
                overflow: "hidden",
              }}
              onClick={() => {
                if (selectedSpanStore.get() === span) {
                  viewportStore.set({ t0: span.start, t1: span.start + Math.max(span.dur, 0.05) });
                } else {
                  selectedSpanStore.set(span);
                }
              }}
            >
              {w > rem * 2.2 && (
                <Text
                  style={{
                    color: "#101318",
                    fontSize: rem * 0.62,
                    font: MONO,
                    wrap: false,
                  }}
                >
                  {span.name}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function Ruler(props: { session: ProfileSession; viewport: Viewport; width: number; rem: number }) {
  const { session, viewport, width, rem } = props;
  const ticks = 5;
  const step = (viewport.t1 - viewport.t0) / ticks;
  return (
    <Box style={{ height: rem, flexShrink: 0, background: theme.panel, overflow: "hidden" }}>
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const t = viewport.t0 + step * i;
        const x = ((t - viewport.t0) / (viewport.t1 - viewport.t0)) * width;
        return (
          <Box key={i} style={{ position: "absolute", inset: { left: x, top: 0 } }}>
            <Text style={{ color: theme.faint, fontSize: rem * 0.58, font: MONO, wrap: false }}>
              {`${(t - session.start).toFixed(1)}ms`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function SpanDetail(props: { span: TimeSpan | null; session: ProfileSession; rem: number }) {
  const { span, session, rem } = props;
  return (
    <Box
      style={{
        flexDirection: "row",
        gap: rem * 0.8,
        padding: rem * 0.35,
        background: theme.panel,
        flexShrink: 0,
        alignItems: "center",
      }}
    >
      {span ? (
        <>
          <Text style={{ color: theme.text, fontSize: rem * 0.72, font: MONO, wrap: false }}>
            {span.name}
          </Text>
          <Text style={{ color: theme.dim, fontSize: rem * 0.66, font: MONO, wrap: false }}>
            {`at ${(span.start - session.start).toFixed(2)}ms`}
          </Text>
          <Text style={{ color: theme.accent, fontSize: rem * 0.66, font: MONO, wrap: false }}>
            {`total ${span.dur.toFixed(2)}ms`}
          </Text>
          {span.self != null && (
            <Text style={{ color: theme.warn, fontSize: rem * 0.66, font: MONO, wrap: false }}>
              {`self ${span.self.toFixed(2)}ms`}
            </Text>
          )}
          {span.arg != null && (
            <Text style={{ color: theme.faint, fontSize: rem * 0.66, font: MONO, wrap: false }}>
              {span.name.startsWith("paint.") ? `n = ${span.arg}` : `batch #${span.arg}`}
            </Text>
          )}
        </>
      ) : (
        <Text style={{ color: theme.faint, fontSize: rem * 0.66, wrap: false }}>
          Click a span to see details, click again to zoom into it.
        </Text>
      )}
    </Box>
  );
}

function Summary(props: { session: ProfileSession; rem: number }) {
  const { session, rem } = props;
  const frames = session.frames;
  const total = session.end - session.start;
  const avg = frames.length
    ? frames.reduce((sum, f) => sum + f.dur, 0) / frames.length
    : 0;
  const worst = frames.reduce((max, f) => Math.max(max, f.dur), 0);
  return (
    <Text style={{ color: theme.dim, fontSize: rem * 0.66, wrap: false }}>
      {`${(total / 1000).toFixed(1)}s · ${frames.length} frames · avg ${avg.toFixed(1)}ms · worst ${worst.toFixed(1)}ms`}
    </Text>
  );
}

export function ProfilerPanel(props: { rem: number }) {
  const { rem } = props;
  const state = useStore(profilerStore);
  const devtools = useStore(devtoolsStore);
  const viewport = useStore(viewportStore);
  const selected = useStore(selectedSpanStore);
  const [, setTick] = useState(0);
  const [exportedTo, setExportedTo] = useState<string | null>(null);

  const session = state.session;
  useEffect(() => {
    if (session && !viewportStore.get()) {
      viewportStore.set({ t0: session.start, t1: session.end });
    }
  }, [session]);
  const chartWidth = Math.max(devtools.width - rem, 40);

  const onChartWheel = (e: { x: number; deltaX: number; deltaY: number; precise: boolean }) => {
    const current = viewportStore.get();
    if (!session || !current) return;
    const span = current.t1 - current.t0;
    const scale = chartWidth / span;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const shift = e.deltaX / scale;
      viewportStore.set(
        clampViewport({ t0: current.t0 + shift, t1: current.t1 + shift }, session)
      );
      return;
    }
    // Scroll up zooms in around the cursor, like a map.
    const dy = e.precise ? e.deltaY : e.deltaY * 3;
    const factor = Math.exp(dy * 0.0035);
    const total = session.end - session.start || 1;
    const next = Math.min(Math.max(span * factor, 0.02), total * 1.2);
    const fraction = Math.min(Math.max((e.x - rem * 0.5) / chartWidth, 0), 1);
    const at = current.t0 + fraction * span;
    viewportStore.set(
      clampViewport({ t0: at - fraction * next, t1: at + (1 - fraction) * next }, session)
    );
  };

  return (
    <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
      <Toolbar rem={rem}>
        <Button
          rem={rem}
          label={state.recording ? "Stop" : "Record"}
          danger={state.recording}
          active={state.recording}
          onClick={() => {
            if (state.recording) stopRecording();
            else {
              viewportStore.set(null);
              selectedSpanStore.set(null);
              startRecording();
            }
            setTick((t) => t + 1);
          }}
        />
        {session && (
          <Button
            rem={rem}
            label="Clear"
            onClick={() => {
              clearRecording();
              viewportStore.set(null);
              selectedSpanStore.set(null);
              setExportedTo(null);
            }}
          />
        )}
        {session && (
          <Button rem={rem} label="Export" onClick={() => setExportedTo(exportProfile())} />
        )}
        {session && !exportedTo && <Summary session={session} rem={rem} />}
        {exportedTo && (
          <Text style={{ color: theme.ok, fontSize: rem * 0.66, font: MONO, wrap: false }}>
            {exportedTo}
          </Text>
        )}
        <Box style={{ flexGrow: 1 }} />
        <Text style={{ color: theme.faint, fontSize: rem * 0.62, wrap: false }}>
          scroll zooms · sideways swipe pans · f fit
        </Text>
      </Toolbar>
      <Divider />
      {state.recording ? (
        <Empty rem={rem} text="Recording… interact with the app, then press Stop." />
      ) : state.pendingStop ? (
        <Empty rem={rem} text="Waiting for the engine profile…" />
      ) : !session || !viewport ? (
        <Empty
          rem={rem}
          text="Press Record, use the app, press Stop — you get a flame chart of React, the bridge and the engine."
        />
      ) : (
        <Box
          style={{
            flexDirection: "column",
            flexGrow: 1,
            flexBasis: 0,
            overflow: "hidden",
            padding: { left: rem * 0.5, right: rem * 0.5 },
          }}
          onWheel={onChartWheel}
        >
          <Overview session={session} width={chartWidth} viewport={viewport} rem={rem} />
          <Divider />
          <Ruler session={session} viewport={viewport} width={chartWidth} rem={rem} />
          <Box
            style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}
          >
            {LANES.map((lane) => {
              const spans = session.spans.filter(lane.match);
              if (spans.length === 0) return null;
              return (
                <Lane
                  key={lane.label}
                  label={lane.label}
                  spans={spans}
                  viewport={viewport}
                  width={chartWidth}
                  rem={rem}
                  selected={selected}
                />
              );
            })}
          </Box>
          <SpanDetail span={selected} session={session} rem={rem} />
        </Box>
      )}
    </Box>
  );
}

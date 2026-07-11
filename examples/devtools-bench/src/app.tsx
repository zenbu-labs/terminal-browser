import React, {
  Profiler,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Box, Text } from "pixel-react";
import type { NodeHandle, WheelEvent } from "pixel-react";

import {
  countNodes,
  FakeLog,
  FakeNode,
  FakeSpan,
  makeLogs,
  makeSpans,
  makeTree,
  mulberry32,
} from "./data";

const t = {
  bg: "#1e1f22",
  panel: "#232529",
  chrome: "#2b2d31",
  chromeActive: "#35373d",
  border: "#3a3d43",
  text: "#dfe1e5",
  dim: "#9aa0a8",
  faint: "#6b7078",
  accent: "#4d9fff",
  accentDim: "#2a4a75",
  warn: "#e5c07b",
  danger: "#e06c75",
  ok: "#7dcf85",
};

const MONO = 1;
const REM = 15;

const LOG_COLORS: Record<string, string> = {
  debug: t.faint,
  info: t.text,
  warn: t.warn,
  error: t.danger,
};

const SPAN_COLORS = ["#4d9fff", "#7dcf85", "#c586c0", "#e5c07b", "#56b6c2", "#6fb1ff", "#5db06a"];

function Button(props: { label: string; onClick: () => void; active?: boolean }) {
  return (
    <Box
      style={{
        padding: { left: 8, right: 8, top: 2, bottom: 2 },
        cornerRadius: 4,
        background: props.active ? t.accentDim : undefined,
        hoverBackground: props.active ? t.accentDim : t.chromeActive,
        border: { width: 1, color: props.active ? t.accent : t.border },
        flexShrink: 0,
      }}
      onClick={props.onClick}
    >
      <Text style={{ color: props.active ? t.accent : t.text, fontSize: 11, wrap: false }}>
        {props.label}
      </Text>
    </Box>
  );
}

function Label(props: { text: string }) {
  return (
    <Text style={{ color: t.faint, fontSize: 10, wrap: false }}>{props.text}</Text>
  );
}

function LogPanel(props: { logs: FakeLog[]; version: number }) {
  const follow = useRef(true);
  const list = useRef<NodeHandle>(null);
  useEffect(() => {
    if (follow.current) list.current?.scrollTo(1e9, false);
  }, [props.version]);
  return (
    <Box
      ref={list}
      style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "scroll" }}
      onScroll={(e) => {
        follow.current = e.offset >= e.max - 2;
      }}
    >
      {props.logs.map((log) => (
        <Box
          key={log.id}
          style={{
            flexDirection: "row",
            alignItems: "start",
            gap: 8,
            padding: { left: 10, right: 10, top: 2, bottom: 2 },
            background:
              log.level === "warn" ? "#e5c07b12" : log.level === "error" ? "#e06c7512" : undefined,
            hoverBackground: t.chromeActive,
          }}
        >
          <Box style={{ width: 52, flexShrink: 0 }}>
            <Text style={{ color: t.faint, fontSize: 10, font: MONO, wrap: false }}>
              {`#${log.id}`}
            </Text>
          </Box>
          <Box style={{ flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
            <Text style={{ color: LOG_COLORS[log.level], fontSize: 11, font: MONO }}>
              {log.text}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

interface TreeRowData {
  node: FakeNode;
  depth: number;
}

function flatten(root: FakeNode, expanded: ReadonlySet<number>): TreeRowData[] {
  const rows: TreeRowData[] = [];
  const walk = (node: FakeNode, depth: number) => {
    rows.push({ node, depth });
    if (node.children.length > 0 && expanded.has(node.id)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

function collectIds(node: FakeNode, into: Set<number>) {
  into.add(node.id);
  for (const child of node.children) collectIds(child, into);
}

function TreePanel(props: {
  root: FakeNode;
  expanded: Set<number>;
  setExpanded: (next: Set<number>) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const rows = flatten(props.root, props.expanded);
  return (
    <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "scroll" }}>
      {rows.map((row) => {
        const expandable = row.node.children.length > 0;
        const open = props.expanded.has(row.node.id);
        return (
          <Box
            key={row.node.id}
            style={{
              flexDirection: "row",
              gap: 6,
              padding: { left: 10 + row.depth * 14, right: 10, top: 1, bottom: 1 },
              background: selected === row.node.id ? "#2d4a70" : undefined,
              hoverBackground: selected === row.node.id ? "#2d4a70" : t.chromeActive,
            }}
            onClick={() => {
              setSelected(row.node.id);
              if (!expandable) return;
              const next = new Set(props.expanded);
              if (open) next.delete(row.node.id);
              else next.add(row.node.id);
              props.setExpanded(next);
            }}
          >
            <Text style={{ color: t.faint, fontSize: 11, font: MONO, wrap: false, flexShrink: 0 }}>
              {expandable ? (open ? "-" : "+") : " "}
            </Text>
            <Text style={{ color: "#5db0d7", fontSize: 11, font: MONO, wrap: false }}>
              {`<${row.node.name}>`}
            </Text>
            <Text style={{ color: t.faint, fontSize: 10, font: MONO, wrap: false }}>
              {`#${row.node.id}`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function FlamePanel(props: { spans: FakeSpan[]; end: number; width: number }) {
  const [viewport, setViewport] = useState({ t0: 0, t1: props.end });
  const [selected, setSelected] = useState<FakeSpan | null>(null);
  useEffect(() => {
    setViewport({ t0: 0, t1: props.end });
    setSelected(null);
  }, [props.spans, props.end]);

  const clamp = (t0: number, t1: number) => {
    const span = t1 - t0;
    let start = Math.max(t0, -span * 0.1);
    const end = Math.min(start + span, props.end + span * 0.1);
    start = end - span;
    return { t0: start, t1: end };
  };

  const onWheel = (e: WheelEvent) => {
    const span = viewport.t1 - viewport.t0;
    const scale = props.width / span;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const shift = e.deltaX / scale;
      setViewport(clamp(viewport.t0 + shift, viewport.t1 + shift));
      return;
    }
    const dy = e.precise ? e.deltaY : e.deltaY * 3;
    const factor = Math.exp(dy * 0.0035);
    const next = Math.min(Math.max(span * factor, 0.05), props.end * 1.2);
    const fraction = Math.min(Math.max(e.x / props.width, 0), 1);
    const at = viewport.t0 + fraction * span;
    setViewport(clamp(at - fraction * next, at + (1 - fraction) * next));
  };

  const scale = props.width / (viewport.t1 - viewport.t0);
  const rowH = 16;
  const lanes: FakeSpan[][] = [[], []];
  let culled = 0;
  for (const span of props.spans) {
    if (span.start + span.dur < viewport.t0 || span.start > viewport.t1) continue;
    if (span.dur * scale < 0.4) {
      culled++;
      continue;
    }
    lanes[span.lane].push(span);
  }
  return (
    <Box
      style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}
      onWheel={onWheel}
    >
      <Box style={{ flexDirection: "row", gap: 12, padding: 6, flexShrink: 0 }}>
        <Label
          text={`${(viewport.t1 - viewport.t0).toFixed(1)}ms window · ${lanes[0].length + lanes[1].length} drawn · ${culled} culled · scroll zooms`}
        />
        {selected && (
          <Text style={{ color: t.accent, fontSize: 10, font: MONO, wrap: false }}>
            {`${selected.name} ${selected.dur.toFixed(2)}ms @${selected.start.toFixed(1)}ms`}
          </Text>
        )}
      </Box>
      {lanes.map((spans, lane) => (
        <Box key={lane} style={{ flexDirection: "column", flexShrink: 0 }}>
          <Box style={{ padding: { left: 8, top: 4, bottom: 2 } }}>
            <Label text={lane === 0 ? "main" : "worker"} />
          </Box>
          <Box style={{ height: 9 * rowH, overflow: "hidden" }}>
            {spans.map((span, i) => {
              const rawX = (span.start - viewport.t0) * scale;
              const right = rawX + Math.max(span.dur * scale - 0.5, 1.5);
              const x = Math.max(rawX, 0);
              const w = Math.max(right - x, 1.5);
              return (
                <Box
                  key={i}
                  style={{
                    position: "absolute",
                    inset: { left: x, top: span.depth * rowH },
                    width: w,
                    height: rowH - 1,
                    background: SPAN_COLORS[(span.name.length + span.depth) % SPAN_COLORS.length],
                    cornerRadius: 1,
                    overflow: "hidden",
                    border: selected === span ? { width: 1, color: "#ffffff" } : undefined,
                  }}
                  onClick={() => setSelected(span)}
                >
                  {w > 34 && (
                    <Text style={{ color: "#101318", fontSize: 9, font: MONO, wrap: false }}>
                      {span.name}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function Pulse(props: { phase: number }) {
  const blocks = 24;
  return (
    <Box style={{ flexDirection: "row", gap: 3, padding: { left: 10, right: 10 }, flexShrink: 0, height: 10, alignItems: "center" }}>
      {Array.from({ length: blocks }, (_, i) => {
        const wave = Math.sin((props.phase + i / blocks) * Math.PI * 2) * 0.5 + 0.5;
        return (
          <Box
            key={i}
            style={{
              flexGrow: 1,
              height: 3 + wave * 7,
              cornerRadius: 2,
              background: i % 3 === 0 ? t.accent : i % 3 === 1 ? t.ok : "#c586c0",
            }}
          />
        );
      })}
    </Box>
  );
}

const TABS = ["console", "elements", "flame"] as const;
type Tab = (typeof TABS)[number];

const LOG_RATES = [0, 10, 60] as const;
const TREE_SIZES = [250, 1000, 5000] as const;
const SPAN_COUNTS = [1000, 5000, 20000] as const;

export function App(props: { width: number }) {
  const [tab, setTab] = useState<Tab>("console");
  const [logVersion, setLogVersion] = useState(0);
  const logsRef = useRef<FakeLog[]>();
  if (!logsRef.current) logsRef.current = makeLogs(300, mulberry32(1));
  const logs = logsRef.current;
  const streamRand = useRef<() => number>();
  if (!streamRand.current) streamRand.current = mulberry32(2);
  const [logRate, setLogRate] = useState<(typeof LOG_RATES)[number]>(0);
  const [treeSize, setTreeSize] = useState<(typeof TREE_SIZES)[number]>(250);
  const [spanCount, setSpanCount] = useState<(typeof SPAN_COUNTS)[number]>(1000);
  const [animate, setAnimate] = useState(false);
  const [phase, setPhase] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const commitMs = useRef(0);
  const [shownCommitMs, setShownCommitMs] = useState(0);

  const tree = useMemo(() => makeTree(treeSize, mulberry32(treeSize)), [treeSize]);
  const nodeCount = useMemo(() => countNodes(tree), [tree]);
  const flame = useMemo(() => makeSpans(spanCount, mulberry32(spanCount)), [spanCount]);

  const addLogs = (count: number) => {
    logsRef.current = [...logsRef.current!, ...makeLogs(count, streamRand.current!)];
    setLogVersion((v) => v + 1);
  };

  useEffect(() => {
    if (logRate === 0) return;
    const timer = setInterval(() => addLogs(1), 1000 / logRate);
    return () => clearInterval(timer);
  }, [logRate]);

  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setPhase((p) => (p + 0.02) % 1), 16);
    return () => clearInterval(timer);
  }, [animate]);

  useEffect(() => {
    const timer = setInterval(() => setShownCommitMs(commitMs.current), 300);
    return () => clearInterval(timer);
  }, []);

  const expandAll = () => {
    const all = new Set<number>();
    collectIds(tree, all);
    setExpanded(all);
  };

  return (
    <Profiler
      id="bench"
      onRender={(_id, _phase, actualDuration) => {
        commitMs.current = actualDuration;
      }}
    >
      <Box
        style={{
          flexDirection: "column",
          width: "100%",
          flexGrow: 1,
          background: t.bg,
          color: t.text,
        }}
      >
        <Box
          style={{
            flexDirection: "row",
            alignItems: "center",
            background: t.chrome,
            flexShrink: 0,
          }}
        >
          {TABS.map((entry) => (
            <Box
              key={entry}
              style={{
                padding: { left: 12, right: 12, top: 5, bottom: 5 },
                background: tab === entry ? t.bg : undefined,
                hoverBackground: tab === entry ? t.bg : t.chromeActive,
              }}
              onClick={() => setTab(entry)}
            >
              <Text style={{ color: tab === entry ? t.text : t.dim, fontSize: 12, wrap: false }}>
                {entry}
              </Text>
            </Box>
          ))}
        </Box>
        <Box
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            padding: 6,
            background: t.panel,
            flexShrink: 0,
          }}
        >
          <Label text="logs" />
          <Button label="+1k" onClick={() => addLogs(1000)} />
          <Button label="+10k" onClick={() => addLogs(10000)} />
          <Button
            label="clear"
            onClick={() => {
              logsRef.current = [];
              setLogVersion((v) => v + 1);
            }}
          />
          <Button
            label={`rate ${logRate}/s`}
            active={logRate > 0}
            onClick={() =>
              setLogRate(LOG_RATES[(LOG_RATES.indexOf(logRate) + 1) % LOG_RATES.length])
            }
          />
          <Label text="tree" />
          <Button
            label={`${treeSize}`}
            onClick={() => {
              setTreeSize(TREE_SIZES[(TREE_SIZES.indexOf(treeSize) + 1) % TREE_SIZES.length]);
              setExpanded(new Set());
            }}
          />
          <Button label="expand" onClick={expandAll} />
          <Button label="collapse" onClick={() => setExpanded(new Set())} />
          <Label text="flame" />
          <Button
            label={`${spanCount}`}
            onClick={() =>
              setSpanCount(SPAN_COUNTS[(SPAN_COUNTS.indexOf(spanCount) + 1) % SPAN_COUNTS.length])
            }
          />
          <Button label={animate ? "animating" : "animate"} active={animate} onClick={() => setAnimate(!animate)} />
        </Box>
        {animate && <Pulse phase={phase} />}
        <Box style={{ height: 1, background: t.border, flexShrink: 0 }} />
        {tab === "console" && <LogPanel logs={logs} version={logVersion} />}
        {tab === "elements" && (
          <TreePanel root={tree} expanded={expanded} setExpanded={setExpanded} />
        )}
        {tab === "flame" && (
          <FlamePanel spans={flame.spans} end={flame.end} width={props.width - 20} />
        )}
        <Box
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            background: t.chrome,
            padding: { left: 10, right: 10, top: 2, bottom: 2 },
            flexShrink: 0,
          }}
        >
          <Text style={{ color: t.faint, fontSize: 10, wrap: false }}>
            {`${logs.length} logs · ${nodeCount} tree nodes · ${flame.spans.length} spans`}
          </Text>
          <Text style={{ color: t.faint, fontSize: 10, font: MONO, wrap: false }}>
            {`react commit ${shownCommitMs.toFixed(2)}ms`}
          </Text>
        </Box>
      </Box>
    </Profiler>
  );
}

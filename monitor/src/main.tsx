import { useEffect, useRef, useState } from "react";

import { Box, Text, createRoot, makeTheme, useTerminalColors } from "@zenbu-labs/pixel";
import type { Theme } from "@zenbu-labs/pixel";

import { Chart, type Line } from "./chart";
import {
  SERIES,
  type Point,
  type Recording,
  type SeriesKey,
  deleteRecording,
  loadRecordings,
  newRecording,
  saveRecording,
} from "./recordings";
import { Sampler, findTerminal, type BrowserSample, type Sample } from "./sampler";
import { EngineLog, type LogLine } from "./enginelog";

const COLORS: Record<SeriesKey, string> = {
  terminal: "#3987e5",
  total: "#d95926",
  engine: "#199e70",
  gpu: "#c98500",
};
const WINDOWS = [60, 120, 300];
const KEEP_SAMPLES = 900;
const engineLog = new EngineLog();

const terminal = findTerminal();
const keys = { current: (_key: string, _ctrl: boolean): boolean => false };
const resize = { current: () => {} };

const root = createRoot({
  name: "cpu monitor",
  onKey(event) {
    if (event.kind !== "press") return;
    if (event.mods.ctrl && event.key === "c") {
      root.stop();
      return true;
    }
    return keys.current(event.key, event.mods.ctrl);
  },
  onResize: () => resize.current(),
});

function pointOf(sample: Sample, pid: number, t: number): Point {
  const browser = sample.browsers.find((b) => b.pid === pid);
  return {
    t,
    values: {
      terminal: sample.terminal,
      total: browser?.total ?? 0,
      engine: browser?.engine ?? 0,
      gpu: browser?.gpu ?? 0,
    },
  };
}

function livePointsFor(samples: Sample[], pid: number, origin: number): Point[] {
  return samples.filter((s) => s.at >= origin).map((s) => pointOf(s, pid, (s.at - origin) / 1000));
}

function formatSeconds(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface Panel {
  pid: number;
  tty: string | null;
}

/// A browser that restarted keeps its pane, so a panel follows the tty when its pid is gone.
function resolvePanels(panels: Panel[], browsers: BrowserSample[]): Panel[] {
  let changed = false;
  const next = panels.map((panel) => {
    if (browsers.some((b) => b.pid === panel.pid)) return panel;
    const successor = panel.tty ? browsers.find((b) => b.tty === panel.tty) : undefined;
    if (!successor || panels.some((p) => p.pid === successor.pid)) return panel;
    changed = true;
    return { pid: successor.pid, tty: successor.tty };
  });
  return changed ? next : panels;
}

function browserName(browser: BrowserSample | undefined, pid: number): string {
  if (!browser) return `pid ${pid} (gone)`;
  return `${browser.label}${browser.tty ? ` ${browser.tty}` : ""}`;
}

function App() {
  const [, setTick] = useState(0);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [logs, setLogs] = useState<Map<number, LogLine[]>>(new Map());
  const [showLogs, setShowLogs] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>(() => loadRecordings());
  const [overlays, setOverlays] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState<Set<SeriesKey>>(new Set(SERIES));
  const [windowIndex, setWindowIndex] = useState(0);
  const [showLive, setShowLive] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const panelsRef = useRef(panels);
  panelsRef.current = panels;

  const theme = makeTheme(useTerminalColors());
  const rem = root.info.basePx;
  const width = root.info.width;
  const height = root.info.height;
  const windowSeconds = WINDOWS[windowIndex];

  useEffect(() => {
    resize.current = () => setTick((t) => t + 1);
    const sampler = new Sampler(terminal);
    sampler.on("sample", (sample: Sample) => {
      setSamples((prev) => [...prev.slice(-KEEP_SAMPLES), sample]);
      if (panelsRef.current.length === 0 && sample.browsers.length > 0) {
        const busiest = [...sample.browsers].sort((a, b) => b.total - a.total)[0];
        setPanels([{ pid: busiest.pid, tty: busiest.tty }]);
      } else {
        const resolved = resolvePanels(panelsRef.current, sample.browsers);
        if (resolved !== panelsRef.current) setPanels(resolved);
      }
      setLogs(new Map(engineLog.poll(panelsRef.current.map((panel) => panel.pid))));
      const current = recordingRef.current;
      const primary = panelsRef.current[0]?.pid;
      if (current && primary != null) {
        current.points.push(pointOf(sample, primary, (sample.at - current.startedAt) / 1000));
        setRecording({ ...current });
      }
    });
    sampler.start();
    return () => sampler.stop();
  }, []);

  const latest = samples[samples.length - 1];
  const browsers = latest?.browsers ?? [];
  const primary = browsers.find((b) => b.pid === panels[0]?.pid);

  const toggleRecording = () => {
    if (recording) {
      const finished = recording;
      setRecording(null);
      if (finished.points.length > 1) {
        saveRecording(finished);
        setRecordings((list) => [...list, finished]);
        setOverlays((set) => new Set([...set, finished.id]));
      }
    } else {
      setRecording(newRecording(primary?.label ?? "browser"));
    }
  };

  const selectPanel = (browser: BrowserSample) => {
    setPanels([{ pid: browser.pid, tty: browser.tty }]);
  };

  keys.current = (key, ctrl) => {
    if (ctrl) return false;
    if (key === "r") toggleRecording();
    else if (key === "c") setOverlays(new Set());
    else if (key === "w") setWindowIndex((i) => (i + 1) % WINDOWS.length);
    else if (key === "l") setShowLive((on) => !on);
    else if (key === "g") setShowLogs((on) => !on);
    else if (key === "q") root.stop();
    else return false;
    return true;
  };

  const origin = recording ? recording.startedAt : (latest?.at ?? Date.now()) - windowSeconds * 1000;
  const barH = rem * 1.9;
  const pad = rem * 0.6;
  const count = Math.max(1, panels.length);
  const panelW = (width - pad * (count + 1)) / count;
  const stripH = rem * 1.7;
  const panelH = height - barH - stripH - pad * 2;

  return (
    <Box style={{ flexDirection: "column", width: "100%", height: "100%", background: theme.bg }}>
      <Box
        style={{
          height: barH,
          alignItems: "center",
          gap: rem * 0.5,
          padding: { left: pad, right: pad },
          border: { bottom: [1, theme.hairline] },
        }}
      >
        <Text style={{ fontSize: rem * 0.75, color: theme.muted, wrap: false, selectable: false }}>
          cpu monitor
        </Text>
        <Box style={{ flexGrow: 1 }} />
        <Pill
          label={recording ? `■ stop  ${formatSeconds((Date.now() - recording.startedAt) / 1000)}` : "● record"}
          active={!!recording}
          color={theme.red}
          rem={rem}
          theme={theme}
          onClick={toggleRecording}
        />
        <Pill
          label={showLive ? "live on" : "live off"}
          active={false}
          color={theme.accent}
          rem={rem}
          theme={theme}
          onClick={() => setShowLive((on) => !on)}
        />
        <Pill
          label="logs"
          active={showLogs}
          color={theme.accent}
          rem={rem}
          theme={theme}
          onClick={() => setShowLogs((on) => !on)}
        />
        <Pill
          label={`${windowSeconds}s`}
          active={false}
          color={theme.accent}
          rem={rem}
          theme={theme}
          onClick={() => setWindowIndex((i) => (i + 1) % WINDOWS.length)}
        />
        <Text style={{ fontSize: rem * 0.62, color: theme.disabled, wrap: false, selectable: false }}>
          r record  l live  g logs  w window  c clear  q quit
        </Text>
      </Box>
      <Box style={{ height: stripH, alignItems: "center", gap: rem * 0.4, padding: { left: pad, right: pad } }}>
        <Text style={{ fontSize: rem * 0.62, color: theme.muted, wrap: false, selectable: false }}>
          {browsers.length === 0 ? "no terminal-browser instances running" : "instances, click one to show it"}
        </Text>
        {browsers.map((b) => {
          const shown = panels.some((p) => p.pid === b.pid);
          return (
            <Pill
              key={b.pid}
              label={`${browserName(b, b.pid)}  ${b.total.toFixed(1)}%`}
              active={shown}
              color={theme.accent}
              rem={rem}
              theme={theme}
              onClick={() => selectPanel(b)}
            />
          );
        })}
      </Box>
      <Box style={{ flexGrow: 1, padding: { left: pad, right: pad, bottom: pad }, gap: pad }}>
        {panels.length === 0 && (
          <Text style={{ fontSize: rem * 0.75, color: theme.muted, wrap: false, selectable: false }}>
            waiting for a terminal-browser instance
          </Text>
        )}
        {panels.map(({ pid }, index) => (
          <InstancePanel
            key={pid}
            pid={pid}
            showTerminal={index === 0}
            browser={browsers.find((b) => b.pid === pid)}
            points={livePointsFor(samples, pid, origin)}
            logLines={logs.get(pid) ?? []}
            hasLog={engineLog.hasLog(pid)}
            showLogs={showLogs}
            overlays={index === 0 ? recordings.filter((r) => overlays.has(r.id)) : []}
            showLive={showLive}
            visible={visible}
            onToggleSeries={(series) =>
              setVisible((set) => {
                const next = new Set(set);
                if (next.has(series)) next.delete(series);
                else next.add(series);
                return next;
              })
            }
            windowSeconds={windowSeconds}
            hover={hover}
            onHover={setHover}
            width={panelW}
            height={panelH}
            removable={panels.length > 1}
            onRemove={() => setPanels((list) => list.filter((p) => p.pid !== pid))}
            recording={index === 0 ? recording : null}
            recordings={index === 0 ? recordings : []}
            overlayIds={overlays}
            onToggleOverlay={(id) =>
              setOverlays((set) => {
                const next = new Set(set);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onDeleteRecording={(id) => {
              deleteRecording(id);
              setRecordings((list) => list.filter((r) => r.id !== id));
              setOverlays((set) => {
                const next = new Set(set);
                next.delete(id);
                return next;
              });
            }}
            rem={rem}
            theme={theme}
          />
        ))}
      </Box>
    </Box>
  );
}

function InstancePanel({
  pid,
  showTerminal,
  browser,
  points,
  logLines,
  hasLog,
  showLogs,
  overlays,
  showLive,
  visible,
  onToggleSeries,
  windowSeconds,
  hover,
  onHover,
  width,
  height,
  removable,
  onRemove,
  recording,
  recordings,
  overlayIds,
  onToggleOverlay,
  onDeleteRecording,
  rem,
  theme,
}: {
  pid: number;
  showTerminal: boolean;
  browser: BrowserSample | undefined;
  points: Point[];
  logLines: LogLine[];
  hasLog: boolean;
  showLogs: boolean;
  overlays: Recording[];
  showLive: boolean;
  visible: Set<SeriesKey>;
  onToggleSeries(series: SeriesKey): void;
  windowSeconds: number;
  hover: number | null;
  onHover(t: number | null): void;
  width: number;
  height: number;
  removable: boolean;
  onRemove(): void;
  recording: Recording | null;
  recordings: Recording[];
  overlayIds: Set<string>;
  onToggleOverlay(id: string): void;
  onDeleteRecording(id: string): void;
  rem: number;
  theme: Theme;
}) {
  const headerH = rem * 1.4;
  const legendW = Math.min(rem * 12, width * 0.4);
  const chartW = Math.max(rem * 6, width - legendW - rem * 0.4);
  const chartH = Math.max(rem * 5, height - headerH);

  const shownSeries = SERIES.filter((series) => showTerminal || series !== "terminal");
  const lines: Line[] = [];
  for (const rec of overlays) {
    for (const series of shownSeries) {
      if (visible.has(series)) {
        lines.push({ key: `${rec.id}-${series}`, series, points: rec.points, color: COLORS[series], overlay: true });
      }
    }
  }
  if (showLive) {
    for (const series of shownSeries) {
      if (visible.has(series)) lines.push({ key: `live-${series}`, series, points, color: COLORS[series], overlay: false });
    }
  }

  const hoverPoint =
    hover == null
      ? null
      : points.reduce<Point | null>(
          (best, point) => (best == null || Math.abs(point.t - hover) < Math.abs(best.t - hover) ? point : best),
          null,
        );
  const shown = hoverPoint ?? points[points.length - 1] ?? null;
  const average = (series: SeriesKey) =>
    points.length ? points.reduce((sum, p) => sum + p.values[series], 0) / points.length : 0;
  const seriesLabel = (series: SeriesKey) => {
    if (series === "terminal") return terminal?.app.toLowerCase() ?? "terminal";
    if (series === "total") return "browser total";
    return series;
  };

  return (
    <Box style={{ width, height, flexDirection: "column", flexShrink: 0 }}>
      <Box style={{ height: headerH, alignItems: "center", gap: rem * 0.4, padding: { left: rem * 0.2 } }}>
        <Text
          style={{ flexGrow: 1, flexBasis: 0,
                    minWidth: 0, fontSize: rem * 0.75, color: theme.fg, wrap: false, ellipsis: true, selectable: false }}
        >
          {browserName(browser, pid)}
        </Text>
        {recording && (
          <Text style={{ fontSize: rem * 0.62, color: theme.red, wrap: false, selectable: false }}>recording</Text>
        )}
        {removable && (
          <Box
            style={{
              width: rem * 1.1,
              height: rem * 1.1,
              alignItems: "center",
              justifyContent: "center",
              cornerRadius: rem * 0.25,
              hoverBackground: theme.hoverStrong,
              flexShrink: 0,
            }}
            onClick={onRemove}
          >
            <Text style={{ fontSize: rem * 0.7, color: theme.muted, wrap: false, selectable: false }}>×</Text>
          </Box>
        )}
      </Box>
      <Box style={{ gap: rem * 0.4 }}>
        {showLogs ? (
          <LogView lines={logLines} hasLog={hasLog} width={chartW} height={chartH} rem={rem} theme={theme} />
        ) : (
          <Chart
            width={chartW}
            height={chartH}
            windowSeconds={windowSeconds}
            lines={lines}
            hover={hover}
            onHover={onHover}
            rem={rem}
            theme={theme}
          />
        )}
        <Box style={{ width: legendW, flexDirection: "column", gap: rem * 0.3 }}>
          {shownSeries.map((series) => {
            const on = visible.has(series);
            return (
              <Box
                key={series}
                style={{
                  height: rem * 1.25,
                  alignItems: "center",
                  gap: rem * 0.35,
                  padding: { left: rem * 0.3, right: rem * 0.3 },
                  cornerRadius: rem * 0.25,
                  hoverBackground: theme.hover,
                }}
                onClick={() => onToggleSeries(series)}
              >
                <Box style={{ width: rem * 0.7, height: 2, background: on ? COLORS[series] : theme.disabled, flexShrink: 0 }} />
                <Text
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    minWidth: 0,
                    fontSize: rem * 0.68,
                    color: on ? theme.fg : theme.disabled,
                    wrap: false,
                    ellipsis: true,
                    selectable: false,
                  }}
                >
                  {seriesLabel(series)}
                </Text>
                <Text
                  style={{ width: rem * 3, fontSize: rem * 0.68, color: on ? theme.fg : theme.disabled, wrap: false, selectable: false }}
                >
                  {shown ? `${shown.values[series].toFixed(1)}%`.padStart(6) : "     –"}
                </Text>
                <Text style={{ width: rem * 2.5, fontSize: rem * 0.6, color: theme.muted, wrap: false, selectable: false }}>
                  {`~${average(series).toFixed(1)}`}
                </Text>
              </Box>
            );
          })}
          <Text style={{ fontSize: rem * 0.6, color: theme.muted, wrap: false, selectable: false, margin: { top: rem * 0.3, left: rem * 0.3 } }}>
            {hover != null
              ? `at ${hover.toFixed(0)}s`
              : recording
                ? "recording"
                : `last ${windowSeconds}s, ~ = average${showTerminal ? `, ${terminal?.app.toLowerCase() ?? "terminal"} is the whole app` : ""}`}
          </Text>
          {recordings.length > 0 && (
            <Text style={{ fontSize: rem * 0.6, color: theme.muted, wrap: false, selectable: false, margin: { top: rem * 0.5, left: rem * 0.3 } }}>
              recordings, click to overlay
            </Text>
          )}
          <Box style={{ flexDirection: "column", overflow: "scroll", flexGrow: 1 }}>
            {[...recordings].reverse().map((rec) => (
              <RecordingRow
                key={rec.id}
                recording={rec}
                on={overlayIds.has(rec.id)}
                rem={rem}
                theme={theme}
                onToggle={() => onToggleOverlay(rec.id)}
                onDelete={() => onDeleteRecording(rec.id)}
              />
            ))}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function LogView({
  lines,
  hasLog,
  width,
  height,
  rem,
  theme,
}: {
  lines: LogLine[];
  hasLog: boolean;
  width: number;
  height: number;
  rem: number;
  theme: Theme;
}) {
  const stamp = (at: number) => {
    const d = new Date(at);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };
  const levelColor = (level: string) =>
    level === "error" ? theme.red : level === "warn" ? theme.yellow : theme.muted;
  return (
    <Box
      style={{
        width,
        height,
        flexDirection: "column",
        flexShrink: 0,
        overflow: "scroll",
        padding: { left: rem * 0.3, right: rem * 0.3 },
        border: { width: 1, color: theme.hairline },
        cornerRadius: rem * 0.25,
      }}
    >
      {!hasLog && (
        <Text style={{ fontSize: rem * 0.66, color: theme.muted, wrap: true, selectable: false }}>
          no engine log for this instance: it predates log files, restart it
        </Text>
      )}
      {lines.map((line, index) => (
        <Box key={index} style={{ gap: rem * 0.4, flexShrink: 0 }}>
          <Text style={{ fontSize: rem * 0.62, color: theme.disabled, wrap: false, selectable: false, width: rem * 5 }}>
            {stamp(line.at)}
          </Text>
          <Text style={{ fontSize: rem * 0.62, color: levelColor(line.level), wrap: false, selectable: false, width: rem * 3.6 }}>
            {line.target}
          </Text>
          <Text style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, fontSize: rem * 0.62, color: theme.fg, wrap: false, ellipsis: true }}>
            {line.message}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function Pill({
  label,
  active,
  enabled = true,
  color,
  rem,
  theme,
  onClick,
}: {
  label: string;
  active: boolean;
  enabled?: boolean;
  color: [number, number, number, number];
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        height: rem * 1.3,
        alignItems: "center",
        padding: { left: rem * 0.6, right: rem * 0.6 },
        cornerRadius: rem * 0.65,
        background: active ? color : theme.field,
        hoverBackground: active ? color : enabled ? theme.hover : theme.field,
        border: { width: 1, color: active ? color : theme.fieldBorder },
        flexShrink: 0,
      }}
      onClick={enabled ? onClick : undefined}
    >
      <Text
        style={{
          fontSize: rem * 0.7,
          color: active ? [255, 255, 255, 255] : enabled ? theme.fg : theme.disabled,
          wrap: false,
          selectable: false,
        }}
      >
        {label}
      </Text>
    </Box>
  );
}

function RecordingRow({
  recording,
  on,
  rem,
  theme,
  onToggle,
  onDelete,
}: {
  recording: Recording;
  on: boolean;
  rem: number;
  theme: Theme;
  onToggle(): void;
  onDelete(): void;
}) {
  const duration = recording.points.length ? recording.points[recording.points.length - 1].t : 0;
  const avgTotal = recording.points.length
    ? recording.points.reduce((sum, p) => sum + p.values.total, 0) / recording.points.length
    : 0;
  return (
    <Box
      style={{
        height: rem * 1.25,
        alignItems: "center",
        gap: rem * 0.35,
        padding: { left: rem * 0.3, right: rem * 0.2 },
        cornerRadius: rem * 0.25,
        background: on ? theme.field : undefined,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onClick={onToggle}
    >
      <Text style={{ fontSize: rem * 0.68, color: on ? theme.fg : theme.muted, wrap: false, selectable: false }}>
        {on ? "▣" : "▢"}
      </Text>
      <Text
        style={{ flexGrow: 1, flexBasis: 0,
                    minWidth: 0, fontSize: rem * 0.64, color: on ? theme.fg : theme.muted, wrap: false, ellipsis: true, selectable: false }}
      >
        {`${recording.name}  ${formatSeconds(duration)}  ~${avgTotal.toFixed(1)}%`}
      </Text>
      <Box
        style={{
          width: rem * 1.1,
          height: rem * 1.1,
          alignItems: "center",
          justifyContent: "center",
          cornerRadius: rem * 0.25,
          hoverBackground: theme.hoverStrong,
          flexShrink: 0,
        }}
        onClick={onDelete}
      >
        <Text style={{ fontSize: rem * 0.64, color: theme.muted, wrap: false, selectable: false }}>×</Text>
      </Box>
    </Box>
  );
}

root.setTitle("cpu monitor");
root.render(<App />);

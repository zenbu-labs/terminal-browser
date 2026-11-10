"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const pixel_1 = require("@zenbu-labs/pixel");
const chart_1 = require("./chart");
const recordings_1 = require("./recordings");
const sampler_1 = require("./sampler");
const enginelog_1 = require("./enginelog");
const COLORS = {
    terminal: "#3987e5",
    total: "#d95926",
    engine: "#199e70",
    gpu: "#c98500",
};
const WINDOWS = [60, 120, 300];
const KEEP_SAMPLES = 900;
const engineLog = new enginelog_1.EngineLog();
const terminal = (0, sampler_1.findTerminal)();
const keys = { current: (_key, _ctrl) => false };
const resize = { current: () => { } };
const root = (0, pixel_1.createRoot)({
    name: "cpu monitor",
    onKey(event) {
        if (event.kind !== "press")
            return;
        if (event.mods.ctrl && event.key === "c") {
            root.stop();
            return true;
        }
        return keys.current(event.key, event.mods.ctrl);
    },
    onResize: () => resize.current(),
});
function pointOf(sample, pid, t) {
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
function livePointsFor(samples, pid, origin) {
    return samples.filter((s) => s.at >= origin).map((s) => pointOf(s, pid, (s.at - origin) / 1000));
}
function formatSeconds(seconds) {
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/// A browser that restarted keeps its pane, so a panel follows the tty when its pid is gone.
function resolvePanels(panels, browsers) {
    let changed = false;
    const next = panels.map((panel) => {
        if (browsers.some((b) => b.pid === panel.pid))
            return panel;
        const successor = panel.tty ? browsers.find((b) => b.tty === panel.tty) : undefined;
        if (!successor || panels.some((p) => p.pid === successor.pid))
            return panel;
        changed = true;
        return { pid: successor.pid, tty: successor.tty };
    });
    return changed ? next : panels;
}
function browserName(browser, pid) {
    if (!browser)
        return `pid ${pid} (gone)`;
    return `${browser.label}${browser.tty ? ` ${browser.tty}` : ""}`;
}
function App() {
    const [, setTick] = (0, react_1.useState)(0);
    const [samples, setSamples] = (0, react_1.useState)([]);
    const [panels, setPanels] = (0, react_1.useState)([]);
    const [logs, setLogs] = (0, react_1.useState)(new Map());
    const [showLogs, setShowLogs] = (0, react_1.useState)(false);
    const [recording, setRecording] = (0, react_1.useState)(null);
    const [recordings, setRecordings] = (0, react_1.useState)(() => (0, recordings_1.loadRecordings)());
    const [overlays, setOverlays] = (0, react_1.useState)(new Set());
    const [visible, setVisible] = (0, react_1.useState)(new Set(recordings_1.SERIES));
    const [windowIndex, setWindowIndex] = (0, react_1.useState)(0);
    const [showLive, setShowLive] = (0, react_1.useState)(true);
    const [hover, setHover] = (0, react_1.useState)(null);
    const recordingRef = (0, react_1.useRef)(recording);
    recordingRef.current = recording;
    const panelsRef = (0, react_1.useRef)(panels);
    panelsRef.current = panels;
    const theme = (0, pixel_1.makeTheme)((0, pixel_1.useTerminalColors)());
    const rem = root.info.basePx;
    const width = root.info.width;
    const height = root.info.height;
    const windowSeconds = WINDOWS[windowIndex];
    (0, react_1.useEffect)(() => {
        resize.current = () => setTick((t) => t + 1);
        const sampler = new sampler_1.Sampler(terminal);
        sampler.on("sample", (sample) => {
            setSamples((prev) => [...prev.slice(-KEEP_SAMPLES), sample]);
            if (panelsRef.current.length === 0 && sample.browsers.length > 0) {
                const busiest = [...sample.browsers].sort((a, b) => b.total - a.total)[0];
                setPanels([{ pid: busiest.pid, tty: busiest.tty }]);
            }
            else {
                const resolved = resolvePanels(panelsRef.current, sample.browsers);
                if (resolved !== panelsRef.current)
                    setPanels(resolved);
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
                (0, recordings_1.saveRecording)(finished);
                setRecordings((list) => [...list, finished]);
                setOverlays((set) => new Set([...set, finished.id]));
            }
        }
        else {
            setRecording((0, recordings_1.newRecording)(primary?.label ?? "browser"));
        }
    };
    const selectPanel = (browser) => {
        setPanels([{ pid: browser.pid, tty: browser.tty }]);
    };
    keys.current = (key, ctrl) => {
        if (ctrl)
            return false;
        if (key === "r")
            toggleRecording();
        else if (key === "c")
            setOverlays(new Set());
        else if (key === "w")
            setWindowIndex((i) => (i + 1) % WINDOWS.length);
        else if (key === "l")
            setShowLive((on) => !on);
        else if (key === "g")
            setShowLogs((on) => !on);
        else if (key === "q")
            root.stop();
        else
            return false;
        return true;
    };
    const origin = recording ? recording.startedAt : (latest?.at ?? Date.now()) - windowSeconds * 1000;
    const barH = rem * 1.9;
    const pad = rem * 0.6;
    const count = Math.max(1, panels.length);
    const panelW = (width - pad * (count + 1)) / count;
    const stripH = rem * 1.7;
    const panelH = height - barH - stripH - pad * 2;
    return ((0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: { flexDirection: "column", width: "100%", height: "100%", background: theme.bg }, children: [(0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: {
                    height: barH,
                    alignItems: "center",
                    gap: rem * 0.5,
                    padding: { left: pad, right: pad },
                    border: { bottom: [1, theme.hairline] },
                }, children: [(0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.75, color: theme.muted, wrap: false, selectable: false }, children: "cpu monitor" }), (0, jsx_runtime_1.jsx)(pixel_1.Box, { style: { flexGrow: 1 } }), (0, jsx_runtime_1.jsx)(Pill, { label: recording ? `■ stop  ${formatSeconds((Date.now() - recording.startedAt) / 1000)}` : "● record", active: !!recording, color: theme.red, rem: rem, theme: theme, onClick: toggleRecording }), (0, jsx_runtime_1.jsx)(Pill, { label: showLive ? "live on" : "live off", active: false, color: theme.accent, rem: rem, theme: theme, onClick: () => setShowLive((on) => !on) }), (0, jsx_runtime_1.jsx)(Pill, { label: "logs", active: showLogs, color: theme.accent, rem: rem, theme: theme, onClick: () => setShowLogs((on) => !on) }), (0, jsx_runtime_1.jsx)(Pill, { label: `${windowSeconds}s`, active: false, color: theme.accent, rem: rem, theme: theme, onClick: () => setWindowIndex((i) => (i + 1) % WINDOWS.length) }), (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.62, color: theme.disabled, wrap: false, selectable: false }, children: "r record  l live  g logs  w window  c clear  q quit" })] }), (0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: { height: stripH, alignItems: "center", gap: rem * 0.4, padding: { left: pad, right: pad } }, children: [(0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.62, color: theme.muted, wrap: false, selectable: false }, children: browsers.length === 0 ? "no terminal-browser instances running" : "instances, click one to show it" }), browsers.map((b) => {
                        const shown = panels.some((p) => p.pid === b.pid);
                        return ((0, jsx_runtime_1.jsx)(Pill, { label: `${browserName(b, b.pid)}  ${b.total.toFixed(1)}%`, active: shown, color: theme.accent, rem: rem, theme: theme, onClick: () => selectPanel(b) }, b.pid));
                    })] }), (0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: { flexGrow: 1, padding: { left: pad, right: pad, bottom: pad }, gap: pad }, children: [panels.length === 0 && ((0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.75, color: theme.muted, wrap: false, selectable: false }, children: "waiting for a terminal-browser instance" })), panels.map(({ pid }, index) => ((0, jsx_runtime_1.jsx)(InstancePanel, { pid: pid, showTerminal: index === 0, browser: browsers.find((b) => b.pid === pid), points: livePointsFor(samples, pid, origin), logLines: logs.get(pid) ?? [], hasLog: engineLog.hasLog(pid), showLogs: showLogs, overlays: index === 0 ? recordings.filter((r) => overlays.has(r.id)) : [], showLive: showLive, visible: visible, onToggleSeries: (series) => setVisible((set) => {
                            const next = new Set(set);
                            if (next.has(series))
                                next.delete(series);
                            else
                                next.add(series);
                            return next;
                        }), windowSeconds: windowSeconds, hover: hover, onHover: setHover, width: panelW, height: panelH, removable: panels.length > 1, onRemove: () => setPanels((list) => list.filter((p) => p.pid !== pid)), recording: index === 0 ? recording : null, recordings: index === 0 ? recordings : [], overlayIds: overlays, onToggleOverlay: (id) => setOverlays((set) => {
                            const next = new Set(set);
                            if (next.has(id))
                                next.delete(id);
                            else
                                next.add(id);
                            return next;
                        }), onDeleteRecording: (id) => {
                            (0, recordings_1.deleteRecording)(id);
                            setRecordings((list) => list.filter((r) => r.id !== id));
                            setOverlays((set) => {
                                const next = new Set(set);
                                next.delete(id);
                                return next;
                            });
                        }, rem: rem, theme: theme }, pid)))] })] }));
}
function InstancePanel({ pid, showTerminal, browser, points, logLines, hasLog, showLogs, overlays, showLive, visible, onToggleSeries, windowSeconds, hover, onHover, width, height, removable, onRemove, recording, recordings, overlayIds, onToggleOverlay, onDeleteRecording, rem, theme, }) {
    const headerH = rem * 1.4;
    const legendW = Math.min(rem * 12, width * 0.4);
    const chartW = Math.max(rem * 6, width - legendW - rem * 0.4);
    const chartH = Math.max(rem * 5, height - headerH);
    const shownSeries = recordings_1.SERIES.filter((series) => showTerminal || series !== "terminal");
    const lines = [];
    for (const rec of overlays) {
        for (const series of shownSeries) {
            if (visible.has(series)) {
                lines.push({ key: `${rec.id}-${series}`, series, points: rec.points, color: COLORS[series], overlay: true });
            }
        }
    }
    if (showLive) {
        for (const series of shownSeries) {
            if (visible.has(series))
                lines.push({ key: `live-${series}`, series, points, color: COLORS[series], overlay: false });
        }
    }
    const hoverPoint = hover == null
        ? null
        : points.reduce((best, point) => (best == null || Math.abs(point.t - hover) < Math.abs(best.t - hover) ? point : best), null);
    const shown = hoverPoint ?? points[points.length - 1] ?? null;
    const average = (series) => points.length ? points.reduce((sum, p) => sum + p.values[series], 0) / points.length : 0;
    const seriesLabel = (series) => {
        if (series === "terminal")
            return terminal?.app.toLowerCase() ?? "terminal";
        if (series === "total")
            return "browser total";
        return series;
    };
    return ((0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: { width, height, flexDirection: "column", flexShrink: 0 }, children: [(0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: { height: headerH, alignItems: "center", gap: rem * 0.4, padding: { left: rem * 0.2 } }, children: [(0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { flexGrow: 1, flexBasis: 0,
                            minWidth: 0, fontSize: rem * 0.75, color: theme.fg, wrap: false, ellipsis: true, selectable: false }, children: browserName(browser, pid) }), recording && ((0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.62, color: theme.red, wrap: false, selectable: false }, children: "recording" })), removable && ((0, jsx_runtime_1.jsx)(pixel_1.Box, { style: {
                            width: rem * 1.1,
                            height: rem * 1.1,
                            alignItems: "center",
                            justifyContent: "center",
                            cornerRadius: rem * 0.25,
                            hoverBackground: theme.hoverStrong,
                            flexShrink: 0,
                        }, onClick: onRemove, children: (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.7, color: theme.muted, wrap: false, selectable: false }, children: "\u00D7" }) }))] }), (0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: { gap: rem * 0.4 }, children: [showLogs ? ((0, jsx_runtime_1.jsx)(LogView, { lines: logLines, hasLog: hasLog, width: chartW, height: chartH, rem: rem, theme: theme })) : ((0, jsx_runtime_1.jsx)(chart_1.Chart, { width: chartW, height: chartH, windowSeconds: windowSeconds, lines: lines, hover: hover, onHover: onHover, rem: rem, theme: theme })), (0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: { width: legendW, flexDirection: "column", gap: rem * 0.3 }, children: [shownSeries.map((series) => {
                                const on = visible.has(series);
                                return ((0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: {
                                        height: rem * 1.25,
                                        alignItems: "center",
                                        gap: rem * 0.35,
                                        padding: { left: rem * 0.3, right: rem * 0.3 },
                                        cornerRadius: rem * 0.25,
                                        hoverBackground: theme.hover,
                                    }, onClick: () => onToggleSeries(series), children: [(0, jsx_runtime_1.jsx)(pixel_1.Box, { style: { width: rem * 0.7, height: 2, background: on ? COLORS[series] : theme.disabled, flexShrink: 0 } }), (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: {
                                                flexGrow: 1,
                                                flexBasis: 0,
                                                minWidth: 0,
                                                fontSize: rem * 0.68,
                                                color: on ? theme.fg : theme.disabled,
                                                wrap: false,
                                                ellipsis: true,
                                                selectable: false,
                                            }, children: seriesLabel(series) }), (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { width: rem * 3, fontSize: rem * 0.68, color: on ? theme.fg : theme.disabled, wrap: false, selectable: false }, children: shown ? `${shown.values[series].toFixed(1)}%`.padStart(6) : "     –" }), (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { width: rem * 2.5, fontSize: rem * 0.6, color: theme.muted, wrap: false, selectable: false }, children: `~${average(series).toFixed(1)}` })] }, series));
                            }), (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.6, color: theme.muted, wrap: false, selectable: false, margin: { top: rem * 0.3, left: rem * 0.3 } }, children: hover != null
                                    ? `at ${hover.toFixed(0)}s`
                                    : recording
                                        ? "recording"
                                        : `last ${windowSeconds}s, ~ = average${showTerminal ? `, ${terminal?.app.toLowerCase() ?? "terminal"} is the whole app` : ""}` }), recordings.length > 0 && ((0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.6, color: theme.muted, wrap: false, selectable: false, margin: { top: rem * 0.5, left: rem * 0.3 } }, children: "recordings, click to overlay" })), (0, jsx_runtime_1.jsx)(pixel_1.Box, { style: { flexDirection: "column", overflow: "scroll", flexGrow: 1 }, children: [...recordings].reverse().map((rec) => ((0, jsx_runtime_1.jsx)(RecordingRow, { recording: rec, on: overlayIds.has(rec.id), rem: rem, theme: theme, onToggle: () => onToggleOverlay(rec.id), onDelete: () => onDeleteRecording(rec.id) }, rec.id))) })] })] })] }));
}
function LogView({ lines, hasLog, width, height, rem, theme, }) {
    const stamp = (at) => {
        const d = new Date(at);
        const pad = (n, w = 2) => String(n).padStart(w, "0");
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    };
    const levelColor = (level) => level === "error" ? theme.red : level === "warn" ? theme.yellow : theme.muted;
    return ((0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: {
            width,
            height,
            flexDirection: "column",
            flexShrink: 0,
            overflow: "scroll",
            padding: { left: rem * 0.3, right: rem * 0.3 },
            border: { width: 1, color: theme.hairline },
            cornerRadius: rem * 0.25,
        }, children: [!hasLog && ((0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.66, color: theme.muted, wrap: true, selectable: false }, children: "no engine log for this instance: it predates log files, restart it" })), lines.map((line, index) => ((0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: { gap: rem * 0.4, flexShrink: 0 }, children: [(0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.62, color: theme.disabled, wrap: false, selectable: false, width: rem * 5 }, children: stamp(line.at) }), (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.62, color: levelColor(line.level), wrap: false, selectable: false, width: rem * 3.6 }, children: line.target }), (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { flexGrow: 1, flexBasis: 0, minWidth: 0, fontSize: rem * 0.62, color: theme.fg, wrap: false, ellipsis: true }, children: line.message })] }, index)))] }));
}
function Pill({ label, active, enabled = true, color, rem, theme, onClick, }) {
    return ((0, jsx_runtime_1.jsx)(pixel_1.Box, { style: {
            height: rem * 1.3,
            alignItems: "center",
            padding: { left: rem * 0.6, right: rem * 0.6 },
            cornerRadius: rem * 0.65,
            background: active ? color : theme.field,
            hoverBackground: active ? color : enabled ? theme.hover : theme.field,
            border: { width: 1, color: active ? color : theme.fieldBorder },
            flexShrink: 0,
        }, onClick: enabled ? onClick : undefined, children: (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: {
                fontSize: rem * 0.7,
                color: active ? [255, 255, 255, 255] : enabled ? theme.fg : theme.disabled,
                wrap: false,
                selectable: false,
            }, children: label }) }));
}
function RecordingRow({ recording, on, rem, theme, onToggle, onDelete, }) {
    const duration = recording.points.length ? recording.points[recording.points.length - 1].t : 0;
    const avgTotal = recording.points.length
        ? recording.points.reduce((sum, p) => sum + p.values.total, 0) / recording.points.length
        : 0;
    return ((0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: {
            height: rem * 1.25,
            alignItems: "center",
            gap: rem * 0.35,
            padding: { left: rem * 0.3, right: rem * 0.2 },
            cornerRadius: rem * 0.25,
            background: on ? theme.field : undefined,
            hoverBackground: theme.hover,
            flexShrink: 0,
        }, onClick: onToggle, children: [(0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.68, color: on ? theme.fg : theme.muted, wrap: false, selectable: false }, children: on ? "▣" : "▢" }), (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { flexGrow: 1, flexBasis: 0,
                    minWidth: 0, fontSize: rem * 0.64, color: on ? theme.fg : theme.muted, wrap: false, ellipsis: true, selectable: false }, children: `${recording.name}  ${formatSeconds(duration)}  ~${avgTotal.toFixed(1)}%` }), (0, jsx_runtime_1.jsx)(pixel_1.Box, { style: {
                    width: rem * 1.1,
                    height: rem * 1.1,
                    alignItems: "center",
                    justifyContent: "center",
                    cornerRadius: rem * 0.25,
                    hoverBackground: theme.hoverStrong,
                    flexShrink: 0,
                }, onClick: onDelete, children: (0, jsx_runtime_1.jsx)(pixel_1.Text, { style: { fontSize: rem * 0.64, color: theme.muted, wrap: false, selectable: false }, children: "\u00D7" }) })] }));
}
root.setTitle("cpu monitor");
root.render((0, jsx_runtime_1.jsx)(App, {}));

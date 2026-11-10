import { useEffect, useRef, useState } from "react";

import { Box, Text, WebView, createRoot, engineLogs, makeTheme, useStore, useTerminalColors } from "@zenbu-labs/pixel";
import type { Color, LogRow, Theme, WebViewHandle } from "@zenbu-labs/pixel";

// A page in a webview with our own chrome around it, plus a live panel of what the engine
// believes about geometry and what it sends. Resize, zoom the pane, and read the panel.
//
// keys: q quit  f frame events  o transmit outlines  w hide/show webview  c clear log  r reload

const url = process.argv[2] ?? "https://terminal-browser.com";

interface ResizeEvent {
  at: number;
  width: number;
  height: number;
  basePx: number;
}

const resizes: ResizeEvent[] = [];
let resizeListeners: (() => void)[] = [];
const notifyResizes = () => resizeListeners.forEach((l) => l());

const toggles = { frameEvents: false, outlines: false, webview: true };
let toggleListeners: (() => void)[] = [];
const notifyToggles = () => toggleListeners.forEach((l) => l());

let reloadListener: (() => void) | null = null;

const root = createRoot({
  onResize(size) {
    resizes.push({ at: Date.now(), ...size });
    if (resizes.length > 200) resizes.shift();
    notifyResizes();
  },
  onKey(event) {
    if (event.kind !== "press") return;
    if (event.key === "q" || (event.mods.ctrl && event.key === "c")) {
      root.stop();
      return true;
    }
    if (event.key === "f") {
      toggles.frameEvents = !toggles.frameEvents;
      root.setRender({ frameEvents: toggles.frameEvents });
      notifyToggles();
      return true;
    }
    if (event.key === "o") {
      toggles.outlines = !toggles.outlines;
      root.setRender({ highlightTransmits: toggles.outlines });
      notifyToggles();
      return true;
    }
    if (event.key === "w") {
      toggles.webview = !toggles.webview;
      notifyToggles();
      return true;
    }
    if (event.key === "c") {
      engineLogs.clear();
      resizes.length = 0;
      notifyResizes();
      return true;
    }
    if (event.key === "r") {
      reloadListener?.();
      return true;
    }
  },
});

function useTick(listeners: (() => void)[]) {
  const [, setN] = useState(0);
  useEffect(() => {
    const l = () => setN((n) => n + 1);
    listeners.push(l);
    return () => {
      const at = listeners.indexOf(l);
      if (at >= 0) listeners.splice(at, 1);
    };
  }, [listeners]);
}

const INTERESTING = /resize|full frame|opaque areas|resampling|cell|started/;

function colorFor(row: LogRow, theme: Theme): Color {
  if (row.level === "warn" || row.level === "error") return "#ff9f43";
  if (row.target === "geometry") return "#7dcfff";
  if (row.target === "present") return "#c0caf5";
  if (row.target === "paint") return "#ffd700";
  return theme.fg;
}

function clock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function Panel({ theme, rem }: { theme: Theme; rem: number }) {
  const logs = useStore(engineLogs.store);
  useTick(resizeListeners);
  useTick(toggleListeners);
  const rows = logs.rows.filter((r) => INTERESTING.test(r.text)).slice(-300);
  const last = resizes[resizes.length - 1];
  const small = rem * 0.62;
  return (
    <Box style={{ width: rem * 34, flexDirection: "column", background: theme.field, border: { left: [1, theme.hairline] }, padding: rem * 0.4, gap: rem * 0.2 }}>
      <Text style={{ fontSize: rem * 0.8, color: theme.fg, wrap: false }}>geometry</Text>
      <Text style={{ fontSize: small, color: "#7dcfff", wrap: true }}>
        {`engine info: ${JSON.stringify(root.info)}`}
      </Text>
      <Text style={{ fontSize: small, color: "#7dcfff", wrap: false }}>
        {last ? `last resize: ${last.width}x${last.height} base ${last.basePx.toFixed(1)} (${resizes.length} events)` : "no resize events yet"}
      </Text>
      <Text style={{ fontSize: small, color: theme.disabled, wrap: false }}>
        {`frame events ${toggles.frameEvents ? "on" : "off"} (f)   outlines ${toggles.outlines ? "on" : "off"} (o)   webview ${toggles.webview ? "shown" : "hidden"} (w)   clear (c)   reload (r)   quit (q)`}
      </Text>
      <Box style={{ height: 1, background: theme.hairline, flexShrink: 0 }} />
      <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "scroll" }}>
        {rows.map((row) => (
          <Text key={row.id} style={{ fontSize: small, color: colorFor(row, theme), wrap: true }}>
            {`${clock(row.epochMs)} ${row.target}: ${row.text}${row.count > 1 ? ` ×${row.count}` : ""}`}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function App() {
  const theme = makeTheme(useTerminalColors());
  const rem = root.info.basePx;
  const view = useRef<WebViewHandle>(null);
  const [title, setTitle] = useState("");
  useTick(toggleListeners);
  useEffect(() => {
    reloadListener = () => view.current?.reload();
    return () => {
      reloadListener = null;
    };
  }, []);
  return (
    <Box style={{ flexDirection: "column", width: "100%", height: "100%", background: theme.bg }}>
      <Box style={{ height: rem * 2, alignItems: "center", padding: { left: rem * 0.6, right: rem * 0.6 }, background: theme.field, border: { bottom: [1, theme.hairline] }, flexShrink: 0 }}>
        <Text style={{ fontSize: rem * 0.8, color: theme.fg, wrap: false }}>{`geometry-debug  ${title || url}`}</Text>
      </Box>
      <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "row" }}>
        <Box style={{ flexGrow: 1, flexBasis: 0, padding: rem * 0.4 }}>
          {toggles.webview ? (
            <WebView ref={view} src={url} style={{ width: "100%", height: "100%", cornerRadius: rem * 0.4 }} onChange={(state) => setTitle(state.title ?? "")} />
          ) : (
            <Box style={{ width: "100%", height: "100%", background: theme.hover, cornerRadius: rem * 0.4 }} />
          )}
        </Box>
        <Panel theme={theme} rem={rem} />
      </Box>
      <Box style={{ height: rem * 1.4, alignItems: "center", padding: { left: rem * 0.6 }, background: theme.field, border: { top: [1, theme.hairline] }, flexShrink: 0 }}>
        <Text style={{ fontSize: rem * 0.62, color: theme.disabled, wrap: false }}>
          {`window ${root.info.width ?? "?"}x${root.info.height ?? "?"} px   resizes ${resizes.length}`}
        </Text>
      </Box>
    </Box>
  );
}

root.render(<App />);

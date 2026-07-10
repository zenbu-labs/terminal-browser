import React, { useEffect } from "react";

import { Box, Text } from "../components";
import { closeDevtools, requestLayout, setPicking } from "./controller";
import { ElementsPanel } from "./Elements";
import { LogPanel } from "./LogPanel";
import { profilerHandleKey, ProfilerPanel } from "./Profiler";
import {
  consoleLogs,
  devtoolsStore,
  engineLogs,
  inspectorStore,
  layoutStore,
  profilerStore,
} from "./stores";
import { useStore } from "./store";
import { theme } from "./theme";

const TABS = [
  { id: "elements", label: "Elements" },
  { id: "console", label: "Console" },
  { id: "engine", label: "Engine" },
  { id: "profiler", label: "Profiler" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Keys the engine routes to the devtools pane (view 1). */
export function handleDevtoolsKey(key: string): boolean {
  const state = devtoolsStore.get();
  if (!state.open) return false;
  if (key === "escape" && inspectorStore.get().picking) {
    setPicking(false);
    return true;
  }
  if (state.tab === "profiler") {
    return profilerHandleKey(key);
  }
  return false;
}

function Tab(props: { id: TabId; label: string; active: boolean; rem: number }) {
  const { id, label, active, rem } = props;
  return (
    <Box
      style={{
        padding: { left: rem * 0.7, right: rem * 0.7, top: rem * 0.3, bottom: rem * 0.3 },
        background: active ? theme.bg : undefined,
        hoverBackground: active ? theme.bg : theme.chromeActive,
      }}
      onClick={() => devtoolsStore.update((s) => ({ ...s, tab: id }))}
    >
      <Text
        style={{
          color: active ? theme.text : theme.dim,
          fontSize: rem * 0.74,
          wrap: false,
        }}
      >
        {label}
      </Text>
    </Box>
  );
}

function TabBar(props: { tab: TabId; rem: number }) {
  const { tab, rem } = props;
  return (
    <Box
      style={{
        flexDirection: "row",
        alignItems: "center",
        background: theme.chrome,
        flexShrink: 0,
        justifyContent: "space-between",
      }}
    >
      <Box style={{ flexDirection: "row", alignItems: "center" }}>
        {TABS.map((entry) => (
          <Tab key={entry.id} id={entry.id} label={entry.label} active={tab === entry.id} rem={rem} />
        ))}
      </Box>
      <Box
        style={{
          padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.3, bottom: rem * 0.3 },
          hoverBackground: theme.chromeActive,
        }}
        onClick={closeDevtools}
      >
        <Text style={{ color: theme.dim, fontSize: rem * 0.8, wrap: false }}>×</Text>
      </Box>
    </Box>
  );
}

function StatusBar(props: { rem: number }) {
  const { rem } = props;
  const layout = useStore(layoutStore);
  const profiler = useStore(profilerStore);
  return (
    <Box
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        background: theme.chrome,
        padding: { left: rem * 0.5, right: rem * 0.5, top: rem * 0.12, bottom: rem * 0.12 },
        flexShrink: 0,
      }}
    >
      <Text style={{ color: theme.faint, fontSize: rem * 0.64, wrap: false }}>
        {`${layout.stats.fps.toFixed(0)} fps · ${layout.stats.frameMs.toFixed(1)} ms/frame · ${layout.rects.size} nodes`}
      </Text>
      {profiler.recording && (
        <Text style={{ color: theme.danger, fontSize: rem * 0.64, wrap: false }}>
          recording
        </Text>
      )}
    </Box>
  );
}

export function DevtoolsApp() {
  const state = useStore(devtoolsStore);
  const rem = Math.max(state.basePx, 10);

  useEffect(() => {
    if (!state.open) return;
    requestLayout();
    const timer = setInterval(requestLayout, 400);
    return () => clearInterval(timer);
  }, [state.open]);

  return (
    <Box
      style={{
        flexDirection: "column",
        width: "100%",
        flexGrow: 1,
        background: theme.bg,
        color: theme.text,
      }}
    >
      <TabBar tab={state.tab} rem={rem} />
      {state.tab === "elements" && <ElementsPanel rem={rem} />}
      {state.tab === "console" && (
        <LogPanel
          logs={consoleLogs}
          rem={rem}
          showTarget
          emptyText="Program output lands here — console.log, stdout and stderr."
        />
      )}
      {state.tab === "engine" && (
        <LogPanel
          logs={engineLogs}
          rem={rem}
          showTarget
          emptyText="Engine logs appear here."
        />
      )}
      {state.tab === "profiler" && <ProfilerPanel rem={rem} />}
      <StatusBar rem={rem} />
    </Box>
  );
}

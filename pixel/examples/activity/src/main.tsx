import os from "node:os";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Box, Input, createRoot, makeTheme, useTerminalColors } from "@zenbu-labs/pixel";
import type { EngineKeyEvent, NodeHandle } from "@zenbu-labs/pixel";

import { CoreBars, HISTORY_LENGTH, LineChart, StatCard } from "./charts";
import { ConfirmEnd } from "./confirm";
import { COPY } from "./copy";
import { Details } from "./details";
import { bytes, duration, percent } from "./format";
import { ProcessTable, compareProcesses } from "./process-table";
import type { Sort, SortKey } from "./process-table";
import { Sampler } from "./system";
import type { Process, Snapshot } from "./system";
import { Button, Icon, Kbd, Label, UiContext, useUi } from "./ui";

const SAMPLE_INTERVAL_MS = 1500;
const PAGE_ROWS = 10;

type KeyHandler = (event: EngineKeyEvent) => boolean;
const keyHandlers = new Set<KeyHandler>();
const resizeListeners = new Set<() => void>();

const root = createRoot({
  name: "activity",
  onKey(event) {
    if (event.kind === "release") return;
    if (event.mods.ctrl && event.key === "c") {
      root.stop();
      return true;
    }
    for (const handler of keyHandlers) if (handler(event)) return true;
  },
  onResize() {
    for (const listener of resizeListeners) listener();
  },
});

// The filter field would otherwise swallow these keys while it has focus, and submitting it clears its text.
root.setKeyCapture(["up", "down", "pageup", "pagedown", "escape", "enter"]);
root.setTitle(COPY.title);

function subscribeResize(listener: () => void) {
  resizeListeners.add(listener);
  return () => {
    resizeListeners.delete(listener);
  };
}

function useRem(): number {
  return useSyncExternalStore(subscribeResize, () => root.info.basePx);
}

function useKeys(handler: KeyHandler) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const forward: KeyHandler = (event) => latest.current(event);
    keyHandlers.add(forward);
    return () => {
      keyHandlers.delete(forward);
    };
  }, []);
}

function useSamples(paused: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memoryHistory, setMemoryHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const sampler = useRef(new Sampler());

  useEffect(() => {
    if (paused) return;
    let timer: NodeJS.Timeout | undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await sampler.current.sample();
        if (cancelled) return;
        const push = (history: number[], value: number) => [...history, value].slice(-HISTORY_LENGTH);
        setSnapshot(next);
        setCpuHistory((history) => push(history, next.cpu));
        setMemoryHistory((history) => push(history, (next.memoryUsed / next.memoryTotal) * 100));
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(COPY.samplingFailed(cause instanceof Error ? cause.message : String(cause)));
      }
      if (!cancelled) timer = setTimeout(tick, SAMPLE_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paused, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { snapshot, cpuHistory, memoryHistory, error, refresh };
}

function matches(process: Process, filter: string): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return (
    process.name.toLowerCase().includes(needle) ||
    process.executable.toLowerCase().includes(needle) ||
    process.user.toLowerCase().includes(needle) ||
    String(process.pid).startsWith(needle)
  );
}

function FilterField({
  inputRef,
  value,
  onChange,
}: {
  inputRef: React.Ref<NodeHandle>;
  value: string;
  onChange(text: string): void;
}) {
  const { rem, theme } = useUi();
  return (
    <Box
      style={{
        width: rem * 16,
        minWidth: rem * 7,
        height: rem * 1.7,
        alignItems: "center",
        gap: rem * 0.4,
        padding: { left: rem * 0.55, right: rem * 0.55 },
        cornerRadius: rem * 0.4,
        background: theme.field,
        border: { width: 1, color: theme.fieldBorder },
      }}
    >
      <Icon name="search" size={rem * 0.85} color={theme.muted} />
      <Box style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, height: "100%", alignItems: "center" }}>
        <Input
          ref={inputRef}
          defaultValue=""
          caretColor={theme.accent}
          selectionColor={theme.selection}
          style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 0.78, color: theme.fg, wrap: false }}
          onChange={onChange}
        />
        {!value && (
          <Box
            style={{
              position: "absolute",
              inset: { left: 0, top: 0, bottom: 0, right: 0 },
              alignItems: "center",
              pointerShape: "text",
            }}
          >
            <Label size={0.78} color={theme.disabled} grow>
              {COPY.filterPlaceholder}
            </Label>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function Footer({ status }: { status: string }) {
  const { rem, theme } = useUi();
  return (
    <Box
      style={{
        height: rem * 2,
        flexShrink: 0,
        alignItems: "center",
        gap: rem * 1,
        padding: { left: rem * 1, right: rem * 1 },
      }}
    >
      <Box style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, gap: rem * 1, alignItems: "center", overflow: "hidden" }}>
        {COPY.hints.map(([key, action]) => (
          <Box key={key} style={{ alignItems: "center", gap: rem * 0.35, flexShrink: 0 }}>
            <Kbd>{key}</Kbd>
            <Label size={0.7} color={theme.muted}>
              {action}
            </Label>
          </Box>
        ))}
      </Box>
      <Label size={0.72} color={theme.muted}>
        {status}
      </Label>
    </Box>
  );
}

function App() {
  const rem = useRem();
  const theme = makeTheme(useTerminalColors());
  const ui = useMemo(() => ({ rem, theme }), [rem, theme]);

  const [paused, setPaused] = useState(false);
  const { snapshot, cpuHistory, memoryHistory, error, refresh } = useSamples(paused);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "cpu", descending: true });
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<Process | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const filterInput = useRef<NodeHandle>(null);
  const lastSelected = useRef<Process | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const all = snapshot?.processes ?? [];
  const visible = useMemo(
    () => all.filter((process) => matches(process, filter)).sort(compareProcesses(sort)),
    [all, filter, sort],
  );
  const byPid = useMemo(() => new Map(all.map((process) => [process.pid, process])), [all]);
  const childCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const process of all) counts.set(process.ppid, (counts.get(process.ppid) ?? 0) + 1);
    return counts;
  }, [all]);

  useEffect(() => {
    if (selectedPid == null && visible.length > 0) setSelectedPid(visible[0].pid);
  }, [selectedPid, visible]);

  useEffect(() => {
    if (visible.length > 0 && !visible.some((process) => process.pid === selectedPid)) setSelectedPid(visible[0].pid);
  }, [filter]);

  const live = visible.find((process) => process.pid === selectedPid) ?? null;
  if (live) lastSelected.current = live;
  const exited = selectedPid != null && !byPid.has(selectedPid) && lastSelected.current?.pid === selectedPid;
  const selected = live ?? (exited ? lastSelected.current : null);

  const moveSelection = (delta: number) => {
    if (visible.length === 0) return;
    const at = visible.findIndex((process) => process.pid === selectedPid);
    const next = at < 0 ? 0 : Math.min(Math.max(at + delta, 0), visible.length - 1);
    setSelectedPid(visible[next].pid);
  };

  const clearFilter = () => {
    filterInput.current?.splice(0, filter.length, "");
    filterInput.current?.blur();
    setFilter("");
  };

  const selectAnywhere = (pid: number) => {
    if (!visible.some((process) => process.pid === pid)) clearFilter();
    setSelectedPid(pid);
  };

  const askToEnd = () => {
    if (!live) return;
    filterInput.current?.blur();
    setConfirming(live);
  };

  const end = (target: Process, force: boolean) => {
    setConfirming(null);
    try {
      process.kill(target.pid, force ? "SIGKILL" : "SIGTERM");
      setNotice(COPY.ended(target.name));
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      const reason = code === "EPERM" ? COPY.permissionDenied : cause instanceof Error ? cause.message : String(cause);
      setNotice(COPY.killFailed(target.name, reason));
    }
    refresh();
  };

  const sortBy = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, descending: !current.descending }
        : { key, descending: key !== "name" && key !== "user" },
    );

  useKeys((event) => {
    if (confirming) {
      if (event.key === "escape") setConfirming(null);
      else if (event.key === "enter") end(confirming, false);
      return true;
    }
    switch (event.key) {
      case "up":
        moveSelection(-1);
        return true;
      case "down":
        moveSelection(1);
        return true;
      case "pageup":
        moveSelection(-PAGE_ROWS);
        return true;
      case "pagedown":
        moveSelection(PAGE_ROWS);
        return true;
      case "escape":
        clearFilter();
        return true;
      case "enter":
        filterInput.current?.blur();
        return true;
      case "/":
        filterInput.current?.focus();
        return true;
      case "k":
        askToEnd();
        return true;
      case " ":
        setPaused((value) => !value);
        return true;
      case "q":
        root.stop();
        return true;
    }
    return false;
  });

  const memoryPercent = snapshot ? (snapshot.memoryUsed / snapshot.memoryTotal) * 100 : 0;
  const emptyText = !snapshot ? COPY.loading : visible.length === 0 ? COPY.noMatches(filter) : null;
  const status =
    notice ??
    error ??
    (paused ? COPY.paused : `${visible.length === all.length ? all.length : `${visible.length} / ${all.length}`} ${COPY.processes}`);

  return (
    <UiContext.Provider value={ui}>
      <Box style={{ width: "100%", height: "100%", flexDirection: "column", background: theme.bg }}>
        <Box
          style={{
            height: rem * 3.2,
            flexShrink: 0,
            alignItems: "center",
            gap: rem * 0.6,
            padding: { left: rem * 1, right: rem * 1 },
          }}
        >
          <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, minWidth: 0, gap: rem * 0.1 }}>
            <Label size={1.1}>{COPY.title}</Label>
            <Label size={0.7} color={theme.muted}>
              {`${os.hostname()}  ·  ${os.cpus().length} ${COPY.cores.toLowerCase()}  ·  ${bytes(os.totalmem())}  ·  up ${duration(os.uptime())}`}
            </Label>
          </Box>
          <FilterField
            inputRef={filterInput}
            value={filter}
            onChange={setFilter}
          />
          <Button
            label={paused ? COPY.resume : COPY.pause}
            icon={paused ? "play" : "pause"}
            onClick={() => setPaused((value) => !value)}
          />
        </Box>

        <Box style={{ height: rem * 7.8, flexShrink: 0, gap: rem * 0.75, padding: { left: rem * 1, right: rem * 1 } }}>
          <StatCard title={COPY.cpu} value={percent(snapshot?.cpu ?? 0)} detail={`${COPY.load} ${snapshot?.load[0].toFixed(2) ?? "–"}`} accent={theme.accent}>
            <LineChart values={cpuHistory} color={theme.accent} />
          </StatCard>
          <StatCard
            title={COPY.memory}
            value={percent(memoryPercent)}
            detail={snapshot ? `${bytes(snapshot.memoryUsed)} / ${bytes(snapshot.memoryTotal)}` : "–"}
            accent={theme.magenta}
          >
            <LineChart values={memoryHistory} color={theme.magenta} />
          </StatCard>
          <StatCard title={COPY.cores} value={String(snapshot?.cores.length ?? os.cpus().length)} detail="" accent={theme.green}>
            <CoreBars cores={snapshot?.cores ?? os.cpus().map(() => 0)} />
          </StatCard>
        </Box>

        <Box
          style={{
            flexGrow: 1,
            flexBasis: 0,
            margin: { left: rem * 1, right: rem * 1, top: rem * 0.75 },
            cornerRadius: rem * 0.6,
            border: { width: 1, color: theme.hairline },
            overflow: "hidden",
          }}
        >
          <ProcessTable
            processes={visible}
            selectedPid={selectedPid}
            sort={sort}
            emptyText={emptyText}
            onSort={sortBy}
            onSelect={setSelectedPid}
          />
          <Details
            process={selected}
            exited={exited}
            parent={selected ? byPid.get(selected.ppid) ?? null : null}
            childCount={selected ? childCounts.get(selected.pid) ?? 0 : 0}
            onSelect={selectAnywhere}
            onEnd={askToEnd}
          />
        </Box>

        <Footer status={status} />

        {confirming && <ConfirmEnd process={confirming} onCancel={() => setConfirming(null)} onEnd={(force) => end(confirming, force)} />}
      </Box>
    </UiContext.Provider>
  );
}

root.render(<App />);

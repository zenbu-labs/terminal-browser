import React, { useEffect, useRef, useState } from "react";

import { Box, Input, Text } from "../components";
import type { NodeHandle } from "../components";
import { consoleLogs, engineLogs } from "./stores";
import type { LogRow as LogRowData } from "./store";
import { useStore } from "./store";
import { MONO, theme } from "./theme";
import { Button, Chip, Divider, Empty, Toolbar } from "./ui";

const ROW_TINTS: Record<string, string | undefined> = {
  warn: "#e5c07b14",
  error: "#e06c7514",
};

const TEXT_COLORS: Record<string, string> = {
  debug: theme.dim,
  info: theme.text,
  warn: theme.warn,
  error: theme.danger,
};

interface SourcedRow {
  row: LogRowData;
  source: "program" | "engine";
}

function LogLine(props: { entry: SourcedRow; showTarget: boolean; rem: number }) {
  const { entry, showTarget, rem } = props;
  const { row } = entry;
  return (
    <Box
      style={{
        flexDirection: "row",
        alignItems: "start",
        gap: rem * 0.5,
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.14, bottom: rem * 0.14 },
        background: ROW_TINTS[row.level],
        hoverBackground: theme.hover,
      }}
    >
      {showTarget && (
        <Box style={{ width: rem * 3.2, flexShrink: 0 }}>
          <Text style={{ color: theme.faint, fontSize: rem * 0.66, font: MONO, wrap: false }}>
            {row.target}
          </Text>
        </Box>
      )}
      <Box style={{ flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
        <Text
          style={{ color: TEXT_COLORS[row.level] ?? theme.text, fontSize: rem * 0.74, font: MONO }}
        >
          {row.text}
        </Text>
      </Box>
      {row.count > 1 && (
        <Box
          style={{
            background: theme.accentDim,
            cornerRadius: rem * 0.5,
            padding: { left: rem * 0.3, right: rem * 0.3 },
            flexShrink: 0,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: rem * 0.62, wrap: false }}>
            {`x${row.count}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

const SOURCES = ["program", "engine", "both"] as const;
const LEVEL_FILTERS = ["all", "info", "warn", "error"] as const;

const EMPTY_TEXT: Record<(typeof SOURCES)[number], string> = {
  program: "Program output lands here — console.log, stdout and stderr.",
  engine: "Engine logs appear here.",
  both: "Program and engine logs, interleaved by time.",
};

/**
 * A row's target label only appears when it says something the current view
 * doesn't already imply: stdout/stderr for program logs, subsystems like
 * profiler/inspect for engine logs, and the source itself in the merged view.
 */
function targetVisible(entry: SourcedRow, source: (typeof SOURCES)[number]): boolean {
  if (entry.source === "program") return entry.row.target !== "console";
  if (source === "both") return true;
  return entry.row.target !== "engine";
}

export function LogPanel(props: { rem: number }) {
  const { rem } = props;
  const programBuffer = useStore(consoleLogs.store);
  const engineBuffer = useStore(engineLogs.store);
  const [source, setSource] = useState<(typeof SOURCES)[number]>("program");
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<(typeof LEVEL_FILTERS)[number]>("all");
  const follow = useRef(true);
  const list = useRef<NodeHandle>(null);

  useEffect(() => {
    if (follow.current) list.current?.scrollTo(1e9, false);
  }, [programBuffer.version, engineBuffer.version, source]);

  let entries: SourcedRow[];
  if (source === "program") {
    entries = programBuffer.rows.map((row) => ({ row, source: "program" as const }));
  } else if (source === "engine") {
    entries = engineBuffer.rows.map((row) => ({ row, source: "engine" as const }));
  } else {
    entries = [
      ...programBuffer.rows.map((row) => ({ row, source: "program" as const })),
      ...engineBuffer.rows.map((row) => ({ row, source: "engine" as const })),
    ].sort((a, b) => a.row.epochMs - b.row.epochMs);
  }

  const query = filter.trim().toLowerCase();
  const rows = entries.filter(({ row }) => {
    if (level === "warn" && row.level !== "warn" && row.level !== "error") return false;
    if (level === "error" && row.level !== "error") return false;
    if (level === "info" && row.level === "debug") return false;
    if (query && !row.text.toLowerCase().includes(query)) return false;
    return true;
  });

  const clear = () => {
    if (source !== "engine") consoleLogs.clear();
    if (source !== "program") engineLogs.clear();
  };

  return (
    <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
      <Toolbar rem={rem}>
        {SOURCES.map((entry) => (
          <Chip
            key={entry}
            rem={rem}
            label={entry}
            active={source === entry}
            onClick={() => setSource(entry)}
          />
        ))}
        <Box style={{ flexGrow: 1 }} />
        {LEVEL_FILTERS.map((entry) => (
          <Chip
            key={entry}
            rem={rem}
            label={entry}
            active={level === entry}
            onClick={() => setLevel(entry)}
          />
        ))}
        <Button rem={rem} label="Clear" onClick={clear} />
      </Toolbar>
      <Box
        style={{
          background: theme.panel,
          padding: { left: rem * 0.35, right: rem * 0.35, bottom: rem * 0.35 },
          flexShrink: 0,
        }}
      >
        <Box
          style={{
            background: theme.bg,
            border: { width: 1, color: theme.border },
            cornerRadius: rem * 0.25,
            padding: { left: rem * 0.4, right: rem * 0.4, top: rem * 0.1, bottom: rem * 0.1 },
            flexGrow: 1,
            flexBasis: 0,
            overflow: "hidden",
          }}
        >
          <Input
            style={{
              // Fill the box: an empty input measures zero wide and would
              // otherwise be impossible to click.
              flexGrow: 1,
              flexBasis: 0,
              fontSize: rem * 0.72,
              color: theme.text,
              font: MONO,
              wrap: false,
            }}
            defaultValue=""
            onChange={setFilter}
            caretColor={theme.accent}
          />
        </Box>
      </Box>
      <Divider />
      {rows.length === 0 ? (
        <Empty rem={rem} text={entries.length === 0 ? EMPTY_TEXT[source] : "No matches."} />
      ) : (
        <Box
          ref={list}
          style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "scroll" }}
          onScroll={(e) => {
            follow.current = e.offset >= e.max - 2;
          }}
        >
          {rows.slice(-500).map((entry) => (
            <LogLine
              key={`${entry.source}-${entry.row.id}`}
              entry={entry}
              showTarget={targetVisible(entry, source)}
              rem={rem}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

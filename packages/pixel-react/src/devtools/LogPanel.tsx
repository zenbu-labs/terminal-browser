import React, { useEffect, useRef, useState } from "react";

import { Box, Input, Text } from "../components";
import type { NodeHandle } from "../components";
import type { LogRow as LogRowData, LogStore } from "./store";
import { useStore } from "./store";
import { MONO, theme } from "./theme";
import { Button, Chip, Divider, Empty, Toolbar } from "./ui";

function formatTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function LogLine(props: { row: LogRowData; showTarget: boolean; rem: number }) {
  const { row, showTarget, rem } = props;
  return (
    <Box
      style={{
        flexDirection: "row",
        gap: rem * 0.5,
        padding: { left: rem * 0.5, right: rem * 0.5, top: rem * 0.15, bottom: rem * 0.15 },
        hoverBackground: theme.hover,
      }}
    >
      <Box
        style={{
          width: 3,
          flexShrink: 0,
          cornerRadius: 1.5,
          background: row.level === "info" ? theme.border : theme.levels[row.level],
        }}
      />
      <Text
        style={{ color: theme.faint, fontSize: rem * 0.68, font: MONO, wrap: false, flexShrink: 0 }}
      >
        {formatTime(row.epochMs)}
      </Text>
      {showTarget && (
        <Box
          style={{
            background: theme.chrome,
            cornerRadius: rem * 0.2,
            padding: { left: rem * 0.25, right: rem * 0.25 },
            flexShrink: 0,
            alignItems: "center",
          }}
        >
          <Text style={{ color: theme.dim, fontSize: rem * 0.62, wrap: false }}>
            {row.target}
          </Text>
        </Box>
      )}
      <Box style={{ flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
        <Text
          style={{ color: theme.levels[row.level] ?? theme.text, fontSize: rem * 0.74, font: MONO }}
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
            alignItems: "center",
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

const LEVEL_FILTERS = ["all", "info", "warn", "error"] as const;

export function LogPanel(props: {
  logs: LogStore;
  rem: number;
  showTarget?: boolean;
  emptyText: string;
}) {
  const { logs, rem, showTarget = false, emptyText } = props;
  const buffer = useStore(logs.store);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<(typeof LEVEL_FILTERS)[number]>("all");
  const follow = useRef(true);
  const list = useRef<NodeHandle>(null);

  useEffect(() => {
    if (follow.current) list.current?.scrollTo(1e9, false);
  }, [buffer.version]);

  const query = filter.trim().toLowerCase();
  const rows = buffer.rows.filter((row) => {
    if (level === "warn" && row.level !== "warn" && row.level !== "error") return false;
    if (level === "error" && row.level !== "error") return false;
    if (level === "info" && row.level === "debug") return false;
    if (query && !row.text.toLowerCase().includes(query)) return false;
    return true;
  });

  return (
    <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
      <Toolbar rem={rem}>
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
            style={{ fontSize: rem * 0.72, color: theme.text, font: MONO, wrap: false }}
            defaultValue=""
            onChange={setFilter}
            caretColor={theme.accent}
          />
        </Box>
        {LEVEL_FILTERS.map((entry) => (
          <Chip
            key={entry}
            rem={rem}
            label={entry}
            active={level === entry}
            onClick={() => setLevel(entry)}
          />
        ))}
        <Button rem={rem} label="Clear" onClick={() => logs.clear()} />
      </Toolbar>
      <Divider />
      {rows.length === 0 ? (
        <Empty rem={rem} text={buffer.rows.length === 0 ? emptyText : "No matches."} />
      ) : (
        <Box
          ref={list}
          style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "scroll" }}
          onScroll={(e) => {
            follow.current = e.offset >= e.max - 2;
          }}
        >
          {rows.slice(-500).map((row) => (
            <LogLine key={row.id} row={row} showTarget={showTarget} rem={rem} />
          ))}
        </Box>
      )}
    </Box>
  );
}

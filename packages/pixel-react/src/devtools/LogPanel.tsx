import React, { useEffect, useRef, useState } from "react";

import { Box, Input, Text } from "../components";
import type { NodeHandle } from "../components";
import type { LogRow as LogRowData, LogStore } from "./store";
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

function LogLine(props: { row: LogRowData; showTarget: boolean; rem: number }) {
  const { row, showTarget, rem } = props;
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
        <Text style={{ color: TEXT_COLORS[row.level] ?? theme.text, fontSize: rem * 0.74, font: MONO }}>
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

import { memo, useEffect, useMemo, useRef } from "react";

import { Box, useRect } from "@zenbu-labs/pixel";
import type { NodeHandle } from "@zenbu-labs/pixel";

import { COPY } from "./copy";
import { bytes, duration, elapsedSeconds, percent } from "./format";
import type { Process } from "./system";
import { Icon, Label, useUi } from "./ui";

export type SortKey = "name" | "pid" | "user" | "cpu" | "memory" | "elapsed";

export interface Sort {
  key: SortKey;
  descending: boolean;
}

interface Column {
  key: SortKey;
  chars: number | null;
  numeric: boolean;
}

const COLUMNS: Column[] = [
  { key: "name", chars: null, numeric: false },
  { key: "pid", chars: 7, numeric: true },
  { key: "user", chars: 12, numeric: false },
  { key: "cpu", chars: 7, numeric: true },
  { key: "memory", chars: 9, numeric: true },
  { key: "elapsed", chars: 8, numeric: true },
];

const DROP_ORDER: SortKey[] = ["elapsed", "user", "pid"];
const NAME_MIN_CHARS = 18;
const ROW_TEXT_SIZE = 0.78;
const MONO_ADVANCE = 0.6;

function charsWidth(chars: number, rem: number): number {
  return rem * (chars * ROW_TEXT_SIZE * MONO_ADVANCE + 1);
}

function columnStyle(column: Column, rem: number) {
  return column.chars == null
    ? { flexGrow: 1, flexBasis: 0, minWidth: 0 }
    : { width: charsWidth(column.chars, rem), flexShrink: 0 };
}

function fittingColumns(tableWidth: number | null, rem: number): Column[] {
  if (tableWidth == null) return COLUMNS;
  let columns = COLUMNS;
  const nameRoom = () =>
    tableWidth - rem * 0.8 - columns.reduce((sum, c) => sum + (c.chars == null ? 0 : charsWidth(c.chars, rem)), 0);
  for (const key of DROP_ORDER) {
    if (nameRoom() >= charsWidth(NAME_MIN_CHARS, rem)) break;
    columns = columns.filter((column) => column.key !== key);
  }
  return columns;
}

export function compareProcesses(sort: Sort): (a: Process, b: Process) => number {
  const value = (p: Process): number | string => {
    switch (sort.key) {
      case "name":
        return p.name.toLowerCase();
      case "pid":
        return p.pid;
      case "user":
        return p.user;
      case "cpu":
        return p.cpu;
      case "memory":
        return p.rssBytes;
      case "elapsed":
        return elapsedSeconds(p.elapsed);
    }
  };
  const direction = sort.descending ? -1 : 1;
  return (a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === right) return a.pid - b.pid;
    return (left < right ? -1 : 1) * direction;
  };
}

function cellText(process: Process, key: SortKey): string {
  switch (key) {
    case "name":
      return process.name;
    case "pid":
      return String(process.pid);
    case "user":
      return process.user;
    case "cpu":
      return percent(process.cpu);
    case "memory":
      return bytes(process.rssBytes);
    case "elapsed":
      return duration(elapsedSeconds(process.elapsed));
  }
}

function Cell({ column, children }: { column: Column; children: React.ReactNode }) {
  const { rem } = useUi();
  return (
    <Box
      style={{
        ...columnStyle(column, rem),
        justifyContent: column.numeric ? "end" : "start",
        alignItems: "center",
        gap: rem * 0.2,
        padding: { left: rem * 0.5, right: rem * 0.5 },
        overflow: "hidden",
      }}
    >
      {children}
    </Box>
  );
}

function Header({ columns, sort, onSort }: { columns: Column[]; sort: Sort; onSort(key: SortKey): void }) {
  const { rem, theme } = useUi();
  return (
    <Box
      style={{
        height: rem * 1.8,
        flexShrink: 0,
        padding: { left: rem * 0.4, right: rem * 0.4 },
        border: { bottom: [1, theme.hairline] },
      }}
    >
      {columns.map((column) => {
        const active = sort.key === column.key;
        return (
          <Box
            key={column.key}
            style={{
              ...columnStyle(column, rem),
              justifyContent: column.numeric ? "end" : "start",
              alignItems: "center",
              gap: rem * 0.15,
              padding: { left: rem * 0.5, right: rem * 0.5 },
              cornerRadius: rem * 0.3,
              hoverBackground: theme.hover,
              pointerShape: "pointer",
            }}
            onClick={() => onSort(column.key)}
          >
            <Label size={0.72} color={active ? theme.fg : theme.muted}>
              {COPY.columns[column.key]}
            </Label>
            {active && <Icon name={sort.descending ? "down" : "up"} size={rem * 0.8} color={theme.fg} />}
          </Box>
        );
      })}
    </Box>
  );
}

const Row = memo(function Row({
  columns,
  process,
  selected,
  rowRef,
  onSelect,
}: {
  columns: Column[];
  process: Process;
  selected: boolean;
  rowRef?: React.Ref<NodeHandle>;
  onSelect(pid: number): void;
}) {
  const { rem, theme } = useUi();
  const busy = process.cpu >= 50;
  return (
    <Box
      ref={rowRef}
      style={{
        height: rem * 1.6,
        flexShrink: 0,
        margin: { left: rem * 0.4, right: rem * 0.4 },
        cornerRadius: rem * 0.35,
        background: selected ? theme.selection : undefined,
        hoverBackground: selected ? undefined : theme.hover,
      }}
      onClick={() => onSelect(process.pid)}
    >
      {columns.map((column) => (
        <Cell key={column.key} column={column}>
          <Label
            size={ROW_TEXT_SIZE}
            grow={column.chars == null}
            color={column.key === "cpu" && busy ? theme.yellow : column.key === "name" ? theme.fg : theme.muted}
          >
            {cellText(process, column.key)}
          </Label>
        </Cell>
      ))}
    </Box>
  );
});

export function ProcessTable({
  processes,
  selectedPid,
  sort,
  emptyText,
  onSort,
  onSelect,
}: {
  processes: Process[];
  selectedPid: number | null;
  sort: Sort;
  emptyText: string | null;
  onSort(key: SortKey): void;
  onSelect(pid: number): void;
}) {
  const { rem, theme } = useUi();
  const selectedRow = useRef<NodeHandle>(null);
  const table = useRef<NodeHandle>(null);
  const tableWidth = useRect(table)?.width ?? null;
  const columns = useMemo(() => fittingColumns(tableWidth, rem), [tableWidth, rem]);
  useEffect(() => {
    selectedRow.current?.scrollIntoView();
  }, [selectedPid]);
  return (
    <Box ref={table} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, flexDirection: "column" }}>
      <Header columns={columns} sort={sort} onSort={onSort} />
      {emptyText ? (
        <Box style={{ flexGrow: 1, flexBasis: 0, alignItems: "center", justifyContent: "center" }}>
          <Label color={theme.muted}>{emptyText}</Label>
        </Box>
      ) : (
        <Box
          style={{
            flexGrow: 1,
            flexBasis: 0,
            flexDirection: "column",
            overflow: "scroll",
            padding: { top: rem * 0.3, bottom: rem * 0.3 },
            scrollbar: { thumbColor: theme.hoverStrong, thumbHoverColor: theme.muted },
          }}
        >
          {processes.map((process) => (
            <Row
              columns={columns}
              key={process.pid}
              process={process}
              selected={process.pid === selectedPid}
              rowRef={process.pid === selectedPid ? selectedRow : undefined}
              onSelect={onSelect}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

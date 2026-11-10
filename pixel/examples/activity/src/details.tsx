import { useEffect, useState } from "react";

import { Box, Text } from "@zenbu-labs/pixel";

import { COPY } from "./copy";
import { bytes, duration, elapsedSeconds, percent } from "./format";
import { commandLine } from "./system";
import type { Process } from "./system";
import { Button, Label, useUi } from "./ui";

function Field({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  const { rem, theme } = useUi();
  return (
    <Box style={{ height: rem * 1.5, alignItems: "center", gap: rem * 0.5 }}>
      <Box style={{ width: rem * 6, flexShrink: 0 }}>
        <Label size={0.75} color={theme.muted}>
          {label}
        </Label>
      </Box>
      <Box
        style={{
          flexGrow: 1,
          flexBasis: 0,
          minWidth: 0,
          alignItems: "center",
          padding: { left: rem * 0.3, right: rem * 0.3 },
          margin: { left: -rem * 0.3 },
          height: rem * 1.3,
          cornerRadius: rem * 0.3,
          hoverBackground: onClick ? theme.hover : undefined,
          pointerShape: onClick ? "pointer" : undefined,
        }}
        onClick={onClick}
      >
        <Label size={0.78} grow color={onClick ? theme.accent : theme.fg}>
          {value}
        </Label>
      </Box>
    </Box>
  );
}

function Block({ label, value }: { label: string; value: string }) {
  const { rem, theme } = useUi();
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.35 }}>
      <Label size={0.75} color={theme.muted}>
        {label}
      </Label>
      <Box style={{ padding: rem * 0.55, cornerRadius: rem * 0.4, background: theme.field, minWidth: 0 }}>
        <Text style={{ fontSize: rem * 0.7, color: theme.fg, wrap: true, selectable: true, flexGrow: 1, flexBasis: 0, minWidth: 0 }}>
          {value}
        </Text>
      </Box>
    </Box>
  );
}

export function Details({
  process,
  exited,
  parent,
  childCount,
  onSelect,
  onEnd,
}: {
  process: Process | null;
  exited: boolean;
  parent: Process | null;
  childCount: number;
  onSelect(pid: number): void;
  onEnd(): void;
}) {
  const { rem, theme } = useUi();
  const [command, setCommand] = useState<string | null>(null);
  const pid = process?.pid;
  useEffect(() => {
    setCommand(null);
    if (pid == null) return;
    let current = true;
    void commandLine(pid).then((line) => {
      if (current) setCommand(line);
    });
    return () => {
      current = false;
    };
  }, [pid]);

  return (
    <Box
      style={{
        width: rem * 22,
        maxWidth: "40%",
        flexShrink: 0,
        flexDirection: "column",
        border: { left: [1, theme.hairline] },
      }}
    >
      {process ? (
        <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", overflow: "scroll", padding: rem * 1, gap: rem * 0.9 }}>
          <Box style={{ flexDirection: "column", gap: rem * 0.2 }}>
            <Label size={1.15}>{process.name}</Label>
            <Label size={0.75} color={exited ? theme.red : theme.muted}>
              {exited ? COPY.details.exited : COPY.states[process.state[0]] ?? process.state}
            </Label>
          </Box>
          <Box style={{ flexDirection: "column" }}>
            <Field label={COPY.details.pid} value={String(process.pid)} />
            <Field
              label={COPY.details.parent}
              value={parent ? `${parent.name} (${parent.pid})` : String(process.ppid)}
              onClick={parent ? () => onSelect(parent.pid) : undefined}
            />
            <Field label={COPY.details.user} value={process.user} />
            <Field label={COPY.details.cpu} value={percent(process.cpu)} />
            <Field label={COPY.details.memory} value={`${bytes(process.rssBytes)}  ·  ${percent(process.memoryPercent)}`} />
            <Field label={COPY.details.elapsed} value={duration(elapsedSeconds(process.elapsed))} />
            <Field label={COPY.details.children} value={String(childCount)} />
          </Box>
          <Block label={COPY.details.executable} value={process.executable} />
          {command && command !== process.executable && <Block label={COPY.details.command} value={command} />}
          {!exited && (
            <Box style={{ gap: rem * 0.5 }}>
              <Button label={COPY.endProcess} icon="stop" tone="danger" onClick={onEnd} />
            </Box>
          )}
        </Box>
      ) : (
        <Box style={{ flexGrow: 1, flexBasis: 0, alignItems: "center", justifyContent: "center", padding: rem }}>
          <Label size={0.78} color={theme.muted}>
            {COPY.noSelection}
          </Label>
        </Box>
      )}
    </Box>
  );
}

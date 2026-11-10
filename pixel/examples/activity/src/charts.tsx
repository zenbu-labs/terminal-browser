import { useRef } from "react";

import { Box, Path, useRect } from "@zenbu-labs/pixel";
import type { NodeHandle, Rgba } from "@zenbu-labs/pixel";

import { Label, mix, useUi, withAlpha } from "./ui";

export const HISTORY_LENGTH = 90;

function linePath(values: number[], width: number, height: number, inset: number): string {
  const step = width / (HISTORY_LENGTH - 1);
  const offset = HISTORY_LENGTH - values.length;
  const y = (value: number) => inset + (1 - Math.min(Math.max(value, 0), 100) / 100) * (height - inset * 2);
  return values
    .map((value, i) => `${i === 0 ? "M" : "L"} ${((offset + i) * step).toFixed(1)} ${y(value).toFixed(1)}`)
    .join(" ");
}

export function LineChart({ values, color }: { values: number[]; color: Rgba }) {
  const { rem, theme } = useUi();
  const frame = useRef<NodeHandle>(null);
  const rect = useRect(frame);
  const stroke = Math.max(1.5, rem * 0.11);
  return (
    <Box ref={frame} style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", justifyContent: "space-between" }}>
      {[0, 1, 2, 3].map((line) => (
        <Box key={line} style={{ height: 1, background: withAlpha(theme.hairline, line === 3 ? 255 : 120) }} />
      ))}
      {rect && values.length > 1 && (
        <Path
          d={linePath(values, rect.width, rect.height, stroke)}
          stroke={{ width: stroke, color, cap: "round", join: "round" }}
          style={{ position: "absolute", inset: { left: 0, top: 0 }, width: rect.width, height: rect.height }}
        />
      )}
    </Box>
  );
}

function loadColor(value: number, theme: ReturnType<typeof useUi>["theme"]): Rgba {
  if (value > 85) return theme.red;
  if (value > 60) return theme.yellow;
  return theme.green;
}

export function CoreBars({ cores }: { cores: number[] }) {
  const { rem, theme } = useUi();
  return (
    <Box style={{ flexGrow: 1, flexBasis: 0, gap: Math.max(2, rem * 0.18), alignItems: "stretch" }}>
      {cores.map((value, i) => (
        <Box
          key={i}
          style={{
            flexGrow: 1,
            flexBasis: 0,
            flexDirection: "column",
            justifyContent: "end",
            cornerRadius: rem * 0.15,
            background: theme.field,
            overflow: "hidden",
          }}
        >
          <Box style={{ height: `${Math.max(2, Math.min(100, value))}%`, background: loadColor(value, theme) }} />
        </Box>
      ))}
    </Box>
  );
}

export function StatCard({
  title,
  value,
  detail,
  accent,
  children,
}: {
  title: string;
  value: string;
  detail: string;
  accent: Rgba;
  children: React.ReactNode;
}) {
  const { rem, theme } = useUi();
  return (
    <Box
      style={{
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        flexDirection: "column",
        gap: rem * 0.5,
        padding: rem * 0.8,
        cornerRadius: rem * 0.6,
        background: mix(theme.bg, theme.fg, 0.035),
        border: { width: 1, color: theme.hairline },
      }}
    >
      <Box style={{ alignItems: "center", gap: rem * 0.45 }}>
        <Box style={{ width: rem * 0.5, height: rem * 0.5, cornerRadius: rem * 0.25, background: accent, flexShrink: 0 }} />
        <Label size={0.75} color={theme.muted}>
          {title}
        </Label>
        <Box style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, justifyContent: "end" }}>
          <Label size={0.7} color={theme.muted} shrink>
            {detail}
          </Label>
        </Box>
      </Box>
      <Label size={1.6}>
        {value}
      </Label>
      <Box style={{ height: rem * 3.2, flexDirection: "column" }}>{children}</Box>
    </Box>
  );
}

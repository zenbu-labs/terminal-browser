import { Box, Text } from "@zenbu-labs/pixel";
import { Icon } from "../icons";
import type { IconName } from "../icons";
import type { Theme } from "../theme";

export function IconButton({
  icon,
  rem,
  theme,
  onClick,
}: {
  icon: IconName;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        width: rem * 1.6,
        height: rem * 1.6,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: rem * 0.3,
        hoverBackground: theme.hoverStrong,
      }}
      onClick={onClick}
    >
      <Icon icon={icon} size={rem * 1} color={theme.muted} />
    </Box>
  );
}

export function TextButton({
  label,
  rem,
  theme,
  onClick,
}: {
  label: string;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        height: rem * 1.55,
        alignItems: "center",
        padding: { left: rem * 0.7, right: rem * 0.7 },
        cornerRadius: rem * 0.3,
        background: theme.field,
        hoverBackground: theme.hoverStrong,
        border: { width: 1, color: theme.fieldBorder },
      }}
      onClick={onClick}
    >
      <Text style={{ fontSize: rem * 0.85, wrap: false, selectable: false }}>{label}</Text>
    </Box>
  );
}

export function Toggle({
  on,
  rem,
  theme,
  onChange,
}: {
  on: boolean;
  rem: number;
  theme: Theme;
  onChange(on: boolean): void;
}) {
  const height = Math.round(rem * 1.2);
  const knob = height - 6;
  return (
    <Box
      style={{
        width: Math.round(rem * 2.2),
        height,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: on ? "end" : "start",
        padding: 2,
        cornerRadius: height / 2,
        background: on ? theme.hoverStrong : theme.field,
        hoverBackground: theme.hoverStrong,
        border: { width: 1, color: theme.fieldBorder },
      }}
      onClick={() => onChange(!on)}
    >
      <Box
        style={{
          width: knob,
          height: knob,
          cornerRadius: knob / 2,
          background: on ? theme.fg : theme.muted,
        }}
      />
    </Box>
  );
}

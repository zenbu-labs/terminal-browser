import { createContext, useContext } from "react";

import { Box, Path, Text } from "@zenbu-labs/pixel";
import type { Color, Rgba, Theme } from "@zenbu-labs/pixel";

export interface Ui {
  rem: number;
  theme: Theme;
}

export const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("useUi needs a UiContext provider");
  return ui;
}

export function withAlpha(color: Rgba, alpha: number): Rgba {
  return [color[0], color[1], color[2], alpha];
}

export function mix(from: Rgba, to: Rgba, t: number): Rgba {
  const channel = (a: number, b: number) => Math.round(a + (b - a) * t);
  return [channel(from[0], to[0]), channel(from[1], to[1]), channel(from[2], to[2]), 255];
}

const ICONS = {
  search: "M 15.5 15.5 L 20 20 M 10.5 4 C 14.09 4 17 6.91 17 10.5 C 17 14.09 14.09 17 10.5 17 C 6.91 17 4 14.09 4 10.5 C 4 6.91 6.91 4 10.5 4 Z",
  pause: "M 9 6 L 9 18 M 15 6 L 15 18",
  play: "M 8 5.5 L 18.5 12 L 8 18.5 Z",
  up: "M 7 14.5 L 12 9.5 L 17 14.5",
  down: "M 7 9.5 L 12 14.5 L 17 9.5",
  close: "M 7 7 L 17 17 M 17 7 L 7 17",
  stop: "M 7 7 L 17 7 L 17 17 L 7 17 Z",
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size, color }: { name: IconName; size: number; color: Color }) {
  return (
    <Path
      d={ICONS[name]}
      viewBox={24}
      stroke={{ width: 2, color, cap: "round", join: "round" }}
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  );
}

export function Label({
  children,
  size = 0.8,
  color,
  grow = false,
  shrink = false,
}: {
  children: string;
  size?: number;
  color?: Color;
  grow?: boolean;
  shrink?: boolean;
}) {
  const { rem, theme } = useUi();
  return (
    <Text
      style={{
        fontSize: rem * size,
        color: color ?? theme.fg,
        wrap: false,
        ellipsis: true,
        selectable: false,
        ...(grow ? { flexGrow: 1, flexBasis: 0, minWidth: 0 } : shrink ? { flexShrink: 1, minWidth: 0 } : { flexShrink: 0 }),
      }}
    >
      {children}
    </Text>
  );
}

type ButtonTone = "plain" | "primary" | "danger";

export function Button({
  label,
  icon,
  tone = "plain",
  onClick,
}: {
  label: string;
  icon?: IconName;
  tone?: ButtonTone;
  onClick(): void;
}) {
  const { rem, theme } = useUi();
  const fill: Record<ButtonTone, Rgba> = {
    plain: theme.field,
    primary: theme.accent,
    danger: theme.red,
  };
  const text = tone === "plain" ? theme.fg : theme.bg;
  return (
    <Box
      style={{
        height: rem * 1.7,
        gap: rem * 0.35,
        padding: { left: rem * 0.75, right: rem * 0.75 },
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: rem * 0.4,
        background: fill[tone],
        border: tone === "plain" ? { width: 1, color: theme.fieldBorder } : undefined,
        hoverBackground: tone === "plain" ? theme.hover : mix(fill[tone], theme.fg, 0.15),
        pointerShape: "pointer",
        flexShrink: 0,
      }}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={rem * 0.85} color={text} />}
      <Label color={text} size={0.78}>
        {label}
      </Label>
    </Box>
  );
}

export function Kbd({ children }: { children: string }) {
  const { rem, theme } = useUi();
  return (
    <Box
      style={{
        height: rem * 1.15,
        padding: { left: rem * 0.3, right: rem * 0.3 },
        alignItems: "center",
        cornerRadius: rem * 0.25,
        background: theme.field,
        border: { width: 1, color: theme.fieldBorder },
        flexShrink: 0,
      }}
    >
      <Label size={0.62} color={theme.muted}>
        {children}
      </Label>
    </Box>
  );
}

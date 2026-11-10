import type { EngineInfo, Rgba } from "@zenbu-labs/pixel";

export interface Theme {
  bg: Rgba;
  overlay: Rgba;
  fg: Rgba;
  muted: Rgba;
  disabled: Rgba;
  accent: Rgba;
  field: Rgba;
  fieldBorder: Rgba;
  frame: Rgba;
  hover: Rgba;
  hoverStrong: Rgba;
  hairline: Rgba;
  selection: Rgba;
  red: Rgba;
  green: Rgba;
  yellow: Rgba;
  magenta: Rgba;
  cyan: Rgba;
}

export function withAlpha(color: Rgba, alpha: number): Rgba {
  return [color[0], color[1], color[2], alpha];
}

export function mix(base: Rgba, toward: Rgba, t: number): Rgba {
  const channel = (b: number, w: number) => Math.round(b + (w - b) * t);
  return [
    channel(base[0], toward[0]),
    channel(base[1], toward[1]),
    channel(base[2], toward[2]),
    255,
  ];
}

export function makeTheme(colors: EngineInfo["colors"]): Theme {
  const bg = colors.background ?? [30, 32, 38, 255];
  const fg = colors.foreground ?? [235, 237, 242, 255];
  const accent = colors.palette[12] ?? colors.palette[4] ?? [93, 156, 255, 255];
  // the chrome never paints its own backdrop: bg is fully transparent so the
  // terminal shows through, and lifted fills are translucent veils (over an
  // opaque terminal a veil composites to exactly the old opaque mix)
  const lift = (toward: Rgba, t: number) => withAlpha(toward, Math.round(255 * t));
  return {
    bg: withAlpha(bg, 0),
    overlay: bg,
    fg,
    accent,
    muted: mix(fg, bg, 0.35),
    disabled: mix(fg, bg, 0.7),
    field: lift(fg, 0.06),
    fieldBorder: lift(fg, 0.16),
    frame: withAlpha(fg, 64),
    hover: lift(fg, 0.12),
    hoverStrong: lift(fg, 0.26),
    hairline: lift(fg, 0.12),
    selection: lift(accent, 0.35),
    red: colors.palette[9] ?? colors.palette[1] ?? [229, 72, 77, 255],
    green: colors.palette[10] ?? colors.palette[2] ?? [48, 164, 108, 255],
    yellow: colors.palette[11] ?? colors.palette[3] ?? [245, 165, 36, 255],
    magenta: colors.palette[13] ?? colors.palette[5] ?? [186, 148, 255, 255],
    cyan: colors.palette[14] ?? colors.palette[6] ?? [94, 201, 227, 255],
  };
}

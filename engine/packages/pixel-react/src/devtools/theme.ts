import type { Rgba, TerminalColors } from "../native";

const FALLBACK_BG: Rgba = [30, 31, 34, 255];
const FALLBACK_FG: Rgba = [223, 225, 229, 255];

function hexToRgba(value: string): Rgba {
  const n = parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function mix(base: Rgba, toward: Rgba, t: number): Rgba {
  const channel = (b: number, c: number) => Math.round(b + (c - b) * t);
  return [
    channel(base[0], toward[0]),
    channel(base[1], toward[1]),
    channel(base[2], toward[2]),
    255,
  ];
}

function hex(color: Rgba): string {
  return `#${color
    .slice(0, 3)
    .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function build(colors: TerminalColors) {
  const bg = colors.background ?? FALLBACK_BG;
  const fg = colors.foreground ?? FALLBACK_FG;
  const slot = (at: number, fallback: string) => colors.palette[at] ?? hexToRgba(fallback);
  const accent = colors.palette[12] ?? slot(4, "#4d9fff");
  const red = slot(1, "#e06c75");
  const green = slot(2, "#98c379");
  const yellow = slot(3, "#e5c07b");
  const magenta = slot(5, "#c586c0");
  const cyan = slot(6, "#5db0d7");

  // shades of one hue so stacked bars in a flame lane stay apart
  const lane = (base: Rgba, count: number) =>
    Array.from({ length: count }, (_, i) =>
      hex(i % 2 === 0 ? mix(base, fg, i * 0.12) : mix(base, bg, i * 0.1)),
    );

  return {
    bg: hex(bg),
    panel: hex(mix(bg, fg, 0.04)),
    chrome: hex(mix(bg, fg, 0.09)),
    chromeActive: hex(mix(bg, fg, 0.15)),
    border: hex(mix(bg, fg, 0.18)),
    text: hex(fg),
    dim: hex(mix(fg, bg, 0.35)),
    faint: hex(mix(fg, bg, 0.55)),
    accent: hex(accent),
    accentDim: hex(mix(bg, accent, 0.4)),
    selectionBg: hex(mix(bg, accent, 0.35)),
    hover: hex(mix(bg, fg, 0.11)),
    tag: hex(cyan),
    attrName: hex(yellow),
    attrValue: hex(green),
    danger: hex(red),
    warn: hex(yellow),
    ok: hex(green),
    levels: {
      debug: hex(mix(fg, bg, 0.45)),
      info: hex(fg),
      warn: hex(yellow),
      error: hex(red),
    } as Record<string, string>,
    flame: {
      react: lane(accent, 4),
      bridge: lane(magenta, 2),
      engine: lane(green, 4),
      devtools: lane(mix(fg, bg, 0.45), 2),
      images: lane(cyan, 2),
    },
  };
}

export type DevtoolsTheme = ReturnType<typeof build>;

export let theme: DevtoolsTheme = build({ foreground: null, background: null, palette: [] });

export function refreshTheme(colors: TerminalColors): void {
  theme = build(colors);
}

export const MONO = 1;
export const UI = 0;

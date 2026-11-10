import type { SettingKey, Settings } from "./settings";

export const AUTO = "auto";
export const DISPLAY_FPS = "display";
export const UNCAPPED = "uncapped";

export function maxFps(value: string, displayHz: number): number {
  if (value === DISPLAY_FPS) return displayHz;
  if (value === UNCAPPED) return 0;
  return Number(value);
}

export function renderEnv(get: <K extends SettingKey>(key: K) => Settings[K]): Record<string, string> {
  const env: Record<string, string> = {};
  const presenter = get("render.presenter");
  if (presenter !== AUTO) env.TERMINAL_BROWSER_PRESENT = presenter;
  const transport = get("render.transport");
  if (transport !== AUTO) env.TERMINAL_BROWSER_FRAMES = transport;
  return env;
}

import { screen } from "electron";

import type { EngineInfo } from "./react";
import type { Terminal } from "./terminal";
import { debug } from "./debug";
import { terminalWindowScale } from "./terminal/window";

export function hostDisplayScale(
  terminal: Terminal | null,
  env: NodeJS.ProcessEnv,
  tty: string | undefined,
): number {
  const [source, scale] = chooseDisplayScale(terminal, env, tty);
  debug("display scale", { source, scale });
  return scale;
}

function chooseDisplayScale(
  terminal: Terminal | null,
  env: NodeJS.ProcessEnv,
  tty: string | undefined,
): [string, number] {
  const explicit = Number(env.PIXEL_DISPLAY_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) return ["PIXEL_DISPLAY_SCALE", explicit];
  if (terminal?.reportsCssPixels) return ["css pixels", 1];
  const scales = new Set(screen.getAllDisplays().map((display) => display.scaleFactor));
  if (scales.size === 1) return ["only display scale", [...scales][0]];
  const windowScale = tty ? terminalWindowScale(tty) : null;
  if (windowScale !== null) return ["terminal window", windowScale];
  return ["display under pointer", screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor];
}

export class CellZoomFollower {
  private last: { rows: number; basePx: number } | null = null;

  ratio(info: EngineInfo): number | null {
    const { height, basePx, cellHeight } = info;
    const rows = cellHeight > 0 ? Math.round(height / cellHeight) : 0;
    const prev = this.last;
    this.last = { rows, basePx };
    if (!prev || !prev.basePx || !prev.rows || !rows) return null;
    const ratio = basePx / prev.basePx;
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.01) return null;
    if (rows === prev.rows) return null;
    return ratio;
  }
}

import { screen } from "electron";

import type { EngineInfo } from "./react";
import type { Terminal } from "./terminal";

export function hostDisplayScale(terminal: Terminal | null, env: NodeJS.ProcessEnv): number {
  const explicit = Number(env.PIXEL_DISPLAY_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (terminal?.reportsCssPixels) return 1;
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor;
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

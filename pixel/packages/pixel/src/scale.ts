import { screen } from "electron";

import type { EngineInfo } from "./react";
import type { Terminal } from "./terminal";

export function hostDisplayScale(terminal: Terminal | null, env: NodeJS.ProcessEnv): number {
  const explicit = Number(env.PIXEL_DISPLAY_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (terminal?.reportsCssPixels) return 1;
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor;
}

type Sample = { rows: number; basePx: number; width: number; height: number };

export class CellZoomFollower {
  private last: Sample | null = null;

  ratio(info: EngineInfo): number | null {
    const { width, height, basePx, cellWidth, cellHeight } = info;
    const rows = cellHeight > 0 ? Math.round(height / cellHeight) : 0;
    const prev = this.last;
    this.last = { rows, basePx, width, height };
    if (!prev || !prev.basePx || !prev.rows || !rows) return null;
    const ratio = basePx / prev.basePx;
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.01) return null;
    if (rows === prev.rows) return null;
    // A font zoom changes the cells inside a pane that stays about the same size. A big size
    // change means the terminal sized the pane for the first time or moved it to another display.
    if (resized(width, prev.width, cellWidth) || resized(height, prev.height, cellHeight)) return null;
    return ratio;
  }
}

function resized(size: number, before: number, cell: number) {
  return Math.abs(size - before) > Math.max(before * 0.1, cell * 2);
}

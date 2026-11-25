import { screen } from "electron";

import type { EngineInfo } from "./react";
import type { Terminal } from "./terminal";

export function hostDisplayScale(terminal: Terminal | null, env: NodeJS.ProcessEnv): number {
  const explicit = Number(env.PIXEL_DISPLAY_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (terminal?.reportsCssPixels) return 1;
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor;
}

type Sample = { rows: number; basePx: number; width: number; height: number; cellWidth: number; cellHeight: number };

export class CellZoomFollower {
  private last: Sample | null = null;

  ratio(info: EngineInfo): number | null {
    const { width, height, basePx, cellWidth, cellHeight } = info;
    const rows = cellHeight > 0 ? Math.round(height / cellHeight) : 0;
    const prev = this.last;
    this.last = { rows, basePx, width, height, cellWidth, cellHeight };
    if (!prev || !prev.basePx || !prev.rows || !rows) return null;
    const ratio = basePx / prev.basePx;
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.01) return null;
    if (rows === prev.rows) return null;
    // A font zoom changes the cells inside a pane that keeps its size. If the pane's pixel size
    // changed by more than a cell, the terminal resized or first sized the pane instead.
    if (Math.abs(width - prev.width) > Math.max(cellWidth, prev.cellWidth)) return null;
    if (Math.abs(height - prev.height) > Math.max(cellHeight, prev.cellHeight)) return null;
    return ratio;
  }
}

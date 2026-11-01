import type { CompletionItem } from "../completion/complete";

export interface BarColors {
  fg: string;
  muted: string;
  faint: string;
  border: string;
  button: string;
  buttonGlyph: string;
  panel: string;
  hover: string;
  codeBg: string;
  error: string;
  on: string;
  knob: string;
}

const GENEROUS_LINE_HEIGHT = 1.5;
export const ANSWER_MAX_HEIGHT = 360;
export const ANSWER_PADDING_TOP = 6;
export const MARGIN_BOTTOM = 4;

function emptyBarHeight(s: number): number {
  return 2 * Math.max(1, Math.round(s)) + 5 * s + 4 * s + 13 * s * GENEROUS_LINE_HEIGHT + 4 * s + 20 * s + 6 * s;
}

export function fullBarHeight(s: number): number {
  return emptyBarHeight(s) + (ANSWER_PADDING_TOP + ANSWER_MAX_HEIGHT + MARGIN_BOTTOM) * s;
}

export const COMPLETION_VISIBLE_ROWS = 12;

export function completionSizes(s: number) {
  return {
    row: Math.round(22 * s),
    inset: Math.round(4 * s),
    divider: Math.round(9 * s),
    font: 12 * s,
    width: Math.round(260 * s),
    detailsWidth: Math.round(270 * s),
    border: Math.max(1, Math.round(s)),
    rowPadding: { left: Math.round(8 * s), right: Math.round(6 * s) },
  };
}

export function dividerAfter(rows: CompletionItem[], top: number, visible: number): number {
  const end = Math.min(rows.length, top + visible);
  for (let at = top; at < end - 1; at++) if (rows[at].history && !rows[at + 1].history) return at;
  return -1;
}

export function completionChrome(rows: CompletionItem[], top: number, visible: number, empty: boolean, more: number, s: number): number {
  const size = completionSizes(s);
  const divider = !empty && dividerAfter(rows, top, visible) >= 0 ? size.divider : 0;
  return (!empty && more > 0 ? size.row : 0) + divider + 2 * size.inset + 2 * size.border;
}

export function completionWidth(rows: CompletionItem[], scale: number, max: number): number {
  const size = completionSizes(scale);
  const glyph = 0.6 * size.font;
  let widest = 0;
  for (const item of rows) {
    const detail = item.description ? 16 * scale + Math.min(50, item.description.length) * glyph : 0;
    widest = Math.max(widest, item.label.length * glyph + detail);
  }
  const chrome = size.rowPadding.left + size.rowPadding.right + 2 * size.inset + 2 * size.border;
  return Math.round(Math.min(max, Math.max(size.width, widest + chrome)));
}

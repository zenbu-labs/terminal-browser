import { sgr } from "./vt";
import type { Vt } from "./vt";

export type CellContent = { image: number; row: number; col: number };

const PLACEHOLDER = "\u{10EEEE}";
const DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357,
  0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484,
  0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
  0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
  0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6, 0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2,
  0x06e4, 0x06e7, 0x06e8, 0x06eb, 0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743,
  0x0745, 0x0747, 0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817, 0x0818, 0x0819,
  0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a, 0x082b, 0x082c,
  0x082d, 0x0951, 0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd, 0x193a, 0x1a17, 0x1a75, 0x1a76,
  0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1,
  0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1,
  0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1,
  0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7,
  0x20e9, 0x20f0, 0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea,
  0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa,
  0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1, 0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5,
  0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7,
  0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23, 0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187,
  0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
].map((c) => String.fromCodePoint(c));

export const MAX_IMAGE_CELLS = DIACRITICS.length;

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLOSE_LINK = "\x1b]8;;\x1b\\";
const MOUSE_MODES = [["x10Mouse", 9], ["normalMouse", 1000], ["buttonMouse", 1002], ["anyMouse", 1003], ["utf8Mouse", 1005], ["sgrMouse", 1006], ["urxvtMouse", 1015], ["sgrPixelsMouse", 1016]] as const;

function cup(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`;
}

function imageColor(id: number): string {
  return `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
}

function render(content: CellContent): string {
  return imageColor(content.image) + PLACEHOLDER + DIACRITICS[content.row] + DIACRITICS[content.col];
}

export class Overlay {
  private desired = new Map<number, CellContent>();
  private painted = new Map<number, string>();
  private cols: number;
  private rows: number;
  wantMouse = false;
  cursor: "shell" | "hidden" = "shell";
  private mouseOurs = false;
  private cursorShown: "shell" | "hidden" = "shell";
  private childMouse = "";

  constructor(
    private readonly vt: Vt,
    private readonly write: (data: string) => void,
  ) {
    const info = vt.info();
    this.cols = info.cols;
    this.rows = info.rows;
  }

  get showing(): boolean {
    return this.painted.size > 0;
  }

  get active(): boolean {
    return this.desired.size > 0 || this.wantMouse || this.cursor !== "shell";
  }

  setCells(cells: Map<number, CellContent>): void {
    this.desired = cells;
  }

  key(row: number, col: number): number {
    return row * this.cols + col;
  }

  resized(firstSeenRow: number): string {
    const info = this.vt.info();
    this.cols = info.cols;
    this.rows = info.rows;
    const wasShowing = this.painted.size > 0;
    this.painted.clear();
    this.desired.clear();
    if (!wasShowing) return "";
    const seen = new Set<number>();
    for (let i = firstSeenRow * this.cols; i < this.cols * this.rows; i++) seen.add(i);
    return this.restoreCells(seen);
  }

  lift(): void {
    if (!this.painted.size && this.cursor === "shell") return;
    const out = this.prologue() + this.restoreCells(new Set(this.painted.keys())) + this.epilogue();
    this.painted.clear();
    this.write(out);
  }

  commit(): boolean {
    if (!this.vt.atGround()) return false;
    const gone = new Set<number>();
    for (const key of this.painted.keys()) if (!this.desired.has(key)) gone.add(key);
    const restore = gone.size ? this.withWholeWideCharacters(gone) : gone;
    for (const key of restore) this.painted.delete(key);
    const paint: [number, string][] = [];
    for (const [key, content] of this.desired) {
      const bytes = render(content);
      if (this.painted.get(key) !== bytes) paint.push([key, bytes]);
    }
    const modes = this.restoreModes();
    if (!restore.size && !paint.length && !modes) return true;
    let out = this.prologue();
    if (restore.size) out += this.restoreCells(restore);
    if (paint.length) out += this.paintCells(paint);
    out += modes;
    out += this.epilogue();
    this.write(out);
    this.childMouse = this.mouseSignature();
    return true;
  }

  private prologue(): string {
    let out = this.vt.mode("synchronized") ? "" : SYNC_START;
    out += CLOSE_LINK;
    if (this.vt.mode("insert")) out += "\x1b[4l";
    return out;
  }

  private epilogue(): string {
    const info = this.vt.info();
    let out = "";
    if (this.vt.mode("insert")) out += "\x1b[4h";
    if (info.pendingWrap && info.cursorX === this.cols - 1 && this.vt.mode("wraparound")) {
      const cell = this.vt.cell(info.cursorX, info.cursorY);
      out += cup(info.cursorY, info.cursorX) + sgr(cell.style) + (cell.text || " ");
    } else {
      out += cup(info.cursorY, info.cursorX);
    }
    out += sgr(this.vt.pen());
    if (!this.vt.mode("synchronized")) out += SYNC_END;
    return out;
  }

  private mouseSignature(): string {
    return MOUSE_MODES.map(([name]) => (this.vt.mode(name) ? "1" : "0")).join("");
  }

  private restoreModes(): string {
    let out = "";
    const wantMouse = this.wantMouse && !this.vt.info().mouseTracking;
    const shellMayHaveTurnedOursOff = this.mouseSignature() !== this.childMouse;
    if (wantMouse && (!this.mouseOurs || shellMayHaveTurnedOursOff)) {
      out += "\x1b[?1003h\x1b[?1006h";
      this.mouseOurs = true;
    } else if (!wantMouse && this.mouseOurs) {
      out += "\x1b[?1003l\x1b[?1006l";
      for (const [name, mode] of MOUSE_MODES) if (this.vt.mode(name)) out += `\x1b[?${mode}h`;
      this.mouseOurs = false;
    }
    if (this.cursor !== this.cursorShown) {
      if (this.cursor === "hidden") out += "\x1b[?25l";
      else out += this.vt.info().cursorVisible ? "\x1b[?25h" : "\x1b[?25l";
      this.cursorShown = this.cursor;
    }
    return out;
  }

  private withWholeWideCharacters(keys: Set<number>): Set<number> {
    const out = new Set(keys);
    for (const key of keys) {
      const row = Math.floor(key / this.cols);
      const col = key % this.cols;
      const cell = this.vt.cell(col, row);
      if (cell.wide && col + 1 < this.cols) out.add(key + 1);
      if (cell.spacer && col > 0) out.add(key - 1);
    }
    return out;
  }

  private paintCells(cells: [number, string][]): string {
    cells.sort((a, b) => a[0] - b[0]);
    let out = "";
    let next = -1;
    for (const [key, bytes] of cells) {
      if (key !== next || key % this.cols === 0) out += cup(Math.floor(key / this.cols), key % this.cols);
      out += bytes;
      this.painted.set(key, bytes);
      next = key + 1;
    }
    return out;
  }

  private restoreCells(keys: Set<number>): string {
    const sorted = [...this.withWholeWideCharacters(keys)].filter((k) => k < this.cols * this.rows).sort((a, b) => a - b);
    let out = "";
    let pen = "";
    let link: string | null = null;
    for (let i = 0; i < sorted.length; ) {
      const row = Math.floor(sorted[i] / this.cols);
      let end = i;
      while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1 && Math.floor(sorted[end + 1] / this.cols) === row) end++;
      const first = sorted[i] % this.cols;
      const last = sorted[end] % this.cols;
      out += cup(row, first);
      for (let col = first; col <= last; ) {
        const cell = this.vt.cell(col, row);
        if (cell.spacer) {
          col++;
          if (col <= last) out += cup(row, col);
          continue;
        }
        if (cell.link !== link) {
          out += cell.link ? `\x1b]8;;${cell.link}\x1b\\` : CLOSE_LINK;
          link = cell.link;
        }
        const cellPen = sgr(cell.style);
        if (cellPen !== pen) {
          out += cellPen;
          pen = cellPen;
        }
        if (!cell.text) {
          let run = 1;
          while (col + run <= last) {
            const next = this.vt.cell(col + run, row);
            if (next.text || next.spacer || next.link !== link || sgr(next.style) !== pen) break;
            run++;
          }
          out += `\x1b[${run}X`;
          col += run;
          if (col <= last) out += `\x1b[${run}C`;
          continue;
        }
        out += cell.text;
        col += cell.wide ? 2 : 1;
      }
      i = end + 1;
    }
    if (link) out += CLOSE_LINK;
    return out;
  }
}

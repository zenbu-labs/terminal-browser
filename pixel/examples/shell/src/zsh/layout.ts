export interface Point {
  row: number;
  col: number;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZeroWidth(cp: number): boolean {
  return (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f);
}

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

export function indexAt(places: Point[], target: Point): number {
  let best = 0;
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    if (p.row > target.row || (p.row === target.row && p.col > target.col)) break;
    best = i;
  }
  return best;
}

export function placeChars(chars: string[], start: Point, cols: number): Point[] {
  const places: Point[] = [];
  let { row, col } = start;
  for (const ch of chars) {
    if (ch === "\n") {
      places.push({ row, col });
      row++;
      col = 0;
      continue;
    }
    const width = charWidth(ch);
    if (col + width > cols) {
      row++;
      col = 0;
    }
    places.push({ row, col });
    col += width;
    if (col >= cols) {
      row++;
      col = 0;
    }
  }
  places.push({ row, col });
  return places;
}

export function bufferStarts(chars: string[], cursorIndex: number, cursorAt: Point, cols: number): Point[] {
  const starts: Point[] = [];
  for (let col = 0; col < cols; col++) {
    const places = placeChars(chars, { row: 0, col }, cols);
    const at = places[Math.min(cursorIndex, places.length - 1)];
    if (at.col === cursorAt.col) starts.push({ row: cursorAt.row - at.row, col });
  }
  return starts;
}

export function bufferRows(chars: string[], places: Point[]): { row: number; col: number; end: number; text: string }[] {
  const rows: { row: number; col: number; end: number; text: string }[] = [];
  chars.forEach((ch, i) => {
    if (ch === "\n") return;
    const at = places[i];
    const last = rows[rows.length - 1];
    if (last && last.row === at.row) {
      last.text += ch;
      last.end = at.col + charWidth(ch);
    } else {
      rows.push({ row: at.row, col: at.col, end: at.col + charWidth(ch), text: ch });
    }
  });
  return rows;
}

export function barPlacement(o: { roomBelow: number; roomAbove: number; tallest: number; side?: "below" | "above" }): { side: "below" | "above"; maxHeight: number } {
  const side = o.side ?? (o.tallest <= o.roomBelow ? "below" : o.tallest <= o.roomAbove ? "above" : o.roomBelow >= o.roomAbove ? "below" : "above");
  return { side, maxHeight: Math.max(0, side === "below" ? o.roomBelow : o.roomAbove) };
}

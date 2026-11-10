const GLYPHS: Record<string, string[]> = {
  p: ["....", "....", "####", "#..#", "#..#", "#..#", "####", "#...", "#..."],
  i: ["#", ".", "#", "#", "#", "#", "#", ".", "."],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", ".....", "....."],
  e: ["....", "....", "####", "#..#", "####", "#...", "####", "....", "...."],
  l: ["#.", "#.", "#.", "#.", "#.", "#.", "##", "..", ".."],
};
const WORD = "pixel";
const ROWS = 9;
const CELL = 15;
const GAP = 1;

function columns() {
  const cols: boolean[][] = [];
  for (const letter of WORD) {
    const glyph = GLYPHS[letter];
    for (let x = 0; x < glyph[0].length; x++) cols.push(glyph.map((row) => row[x] === "#"));
    cols.push(new Array(ROWS).fill(false));
  }
  cols.pop();
  return cols;
}

export default function Wordmark() {
  const cols = columns();
  return (
    <svg
      id="wordmark"
      role="img"
      aria-label="pixel"
      fill="currentColor"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${cols.length * CELL} ${ROWS * CELL}`}
    >
      {cols.flatMap((col, x) =>
        col.map((on, y) =>
          on ? <rect key={`${x}-${y}`} x={x * CELL} y={y * CELL} width={CELL - GAP} height={CELL - GAP} /> : null,
        ),
      )}
    </svg>
  );
}

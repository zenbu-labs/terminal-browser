const GLYPHS: Record<string, string[]> = {
  p: ["....", "....", "####", "#..#", "#..#", "#..#", "####", "#...", "#..."],
  i: ["#", ".", "#", "#", "#", "#", "#", ".", "."],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", ".....", "....."],
  e: ["....", "....", "####", "#..#", "####", "#...", "####", "....", "...."],
  l: ["#.", "#.", "#.", "#.", "#.", "#.", "##", "..", ".."],
  g: ["....", "....", "####", "#..#", "#..#", "#..#", "####", "...#", "####"],
  u: ["....", "....", "#..#", "#..#", "#..#", "#..#", "####", "....", "...."],
};
const LETTERS = [
  { letter: "p" },
  { letter: "i" },
  { letter: "x" },
  { letter: "e" },
  { letter: "l" },
  { letter: "g", color: "r" },
  { letter: "u", color: "g" },
  { letter: "i", color: "b" },
];
export const ROWS = 9;
export const CELL = 15;
export const GAP = 1;

export function layout() {
  let width = 0;
  const cells: { x: number; y: number; color?: string }[] = [];
  for (const { letter, color } of LETTERS) {
    const glyph = GLYPHS[letter];
    glyph.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === "#") cells.push({ x: width + x, y, color });
    });
    width += glyph[0].length + 1;
  }
  return { cells, width: width - 1 };
}

export default function Wordmark() {
  const { cells, width } = layout();
  return (
    <svg
      id="wordmark"
      role="img"
      aria-label="pixelgui"
      fill="currentColor"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${width * CELL} ${ROWS * CELL}`}
    >
      {cells.map(({ x, y, color }) => (
        <rect key={`${x}-${y}`} x={x * CELL} y={y * CELL} width={CELL - GAP} height={CELL - GAP} fill={color && `var(--${color})`} />
      ))}
    </svg>
  );
}

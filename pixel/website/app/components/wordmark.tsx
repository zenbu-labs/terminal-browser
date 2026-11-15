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
  { letter: "g", color: "var(--r)" },
  { letter: "u", color: "var(--g)" },
  { letter: "i", color: "var(--b)" },
];
const ROWS = 9;
const CELL = 15;
const GAP = 1;

function layout() {
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
        <rect key={`${x}-${y}`} x={x * CELL} y={y * CELL} width={CELL - GAP} height={CELL - GAP} fill={color} />
      ))}
    </svg>
  );
}

const COPY = [
  "..######",
  "..#....#",
  "######.#",
  "#....#.#",
  "#....###",
  "#....#..",
  "#....#..",
  "######..",
];

const CHECK = [
  "........",
  ".......#",
  "......##",
  "#....##.",
  "##..##..",
  ".####...",
  "..##....",
  "........",
];

const SWEEP_MS = 28;

const PIXELS = COPY.flatMap((row, y) =>
  [...row].map((_, x) => ({ x, y, copy: COPY[y][x] === "#", check: CHECK[y][x] === "#" })).filter((p) => p.copy || p.check),
);

export default function PixelCopyIcon({ done }: { done: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 8 8" fill="currentColor" shapeRendering="crispEdges" aria-hidden>
      {PIXELS.map(({ x, y, copy, check }) => {
        const on = done ? check : copy;
        const wave = done ? x + y : 14 - x - y;
        return (
          <rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width={1}
            height={1}
            className={on ? "px" : "px off"}
            style={{ transitionDelay: `${on ? wave * SWEEP_MS : wave * (SWEEP_MS / 3)}ms` }}
          />
        );
      })}
    </svg>
  );
}

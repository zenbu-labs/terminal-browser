import { Box, Link, Text, createRoot, makeTheme, useTerminalColors } from "@zenbu-labs/pixel";
import type { Theme } from "@zenbu-labs/pixel";

const GRAPHICS_TERMINALS = [
  "Ghostty",
  "iTerm2",
  "xterm.js",
  "Konsole",
  "WezTerm",
  "Warp",
  "noctty (Ghostty for Windows)",
  "Mobile SSH",
  "st (with a patch)",
  "wayst",
  "AbsoluteTelnet/SSH",
];

const root = createRoot({
  onUnsupportedTerminal: () =>
    [
      "",
      "  \x1b[1mThis terminal doesn't support graphics\x1b[0m",
      "",
      "  Example terminals that support graphics:",
      ...GRAPHICS_TERMINALS.map((name) => `    - ${name}`),
      "",
      "",
    ].join("\n"),
  onKey(event) {
    if (event.kind === "press" && event.mods.ctrl && event.key === "c") {
      root.stop();
      return true;
    }
  },
});

const PIXEL = "https://github.com/zenbu-labs/terminal-browser/tree/main/pixel";

const LINKS = [
  { title: "Docs", url: `${PIXEL}#docs` },
  { title: "Examples", url: `${PIXEL}/examples` },
];

const GLYPHS: Record<string, string[]> = {
  p: ["....", "....", "####", "#..#", "#..#", "#..#", "####", "#...", "#..."],
  i: ["#", ".", "#", "#", "#", "#", "#", ".", "."],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", ".....", "....."],
  e: ["....", "....", "####", "#..#", "####", "#...", "####", "....", "...."],
  l: ["#.", "#.", "#.", "#.", "#.", "#.", "##", "..", ".."],
};
const ROWS = 9;

function wordmarkCells() {
  const cols: boolean[][] = [];
  for (const letter of "pixel") {
    const glyph = GLYPHS[letter];
    for (let x = 0; x < glyph[0].length; x++) cols.push(glyph.map((row) => row[x] === "#"));
    cols.push(new Array(ROWS).fill(false));
  }
  cols.pop();
  return cols;
}

const CELLS = wordmarkCells();

function Wordmark({ cell, color }: { cell: number; color: Theme["fg"] }) {
  const gap = Math.max(1, Math.round(cell / 15));
  return (
    <Box style={{ width: CELLS.length * cell, height: ROWS * cell, flexShrink: 0 }}>
      {CELLS.flatMap((col, x) =>
        col.map((on, y) =>
          on ? (
            <Box
              key={`${x}-${y}`}
              style={{
                position: "absolute",
                inset: { left: x * cell, top: y * cell },
                width: cell - gap,
                height: cell - gap,
                background: color,
              }}
            />
          ) : null,
        ),
      )}
    </Box>
  );
}

function App() {
  const theme = makeTheme(useTerminalColors());
  const rem = root.info.basePx;

  return (
    <Box
      style={{
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: rem * 2.5,
        width: "100%",
        height: "100%",
        padding: rem * 2,
      }}
    >
      <Wordmark cell={Math.round(rem * 0.7)} color={theme.fg} />

      <Box style={{ gap: rem * 2 }}>
        {LINKS.map((link) => (
          <Link key={link.title} href={link.url} style={{ fontSize: rem * 0.9, color: theme.muted, hoverColor: theme.fg }}>
            {`${link.title} →`}
          </Link>
        ))}
      </Box>

      <Text style={{ fontSize: rem * 0.75, color: theme.disabled, selectable: false }}>ctrl+c to quit</Text>
    </Box>
  );
}

root.render(<App />);

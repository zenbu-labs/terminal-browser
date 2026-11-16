import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CELL, GAP, ROWS, layout } from "./components/wordmark";

export const alt = "pixelgui · Build graphical applications in the terminal";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const WORDMARK_WIDTH_PX = 760;
const COLORS: Record<string, string> = { r: "#ff4d5e", g: "#3ddc84", b: "#4d9fff" };

function Wordmark() {
  const { cells, width } = layout();
  return (
    <svg
      width={WORDMARK_WIDTH_PX}
      height={(WORDMARK_WIDTH_PX * ROWS) / width}
      viewBox={`0 0 ${width * CELL} ${ROWS * CELL}`}
      shapeRendering="crispEdges"
    >
      {cells.map(({ x, y, color }) => (
        <rect
          key={`${x}-${y}`}
          x={x * CELL}
          y={y * CELL}
          width={CELL - GAP}
          height={CELL - GAP}
          fill={color ? COLORS[color] : "#eeeeee"}
        />
      ))}
    </svg>
  );
}

export default async function OpengraphImage() {
  const fonts = join(process.cwd(), "app", "fonts");
  const [regular, semibold] = await Promise.all([
    readFile(join(fonts, "JetBrainsMono-Regular.ttf")),
    readFile(join(fonts, "JetBrainsMono-SemiBold.ttf")),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#000000",
          fontFamily: "JetBrains Mono",
        }}
      >
        <Wordmark />
        {/* fixme: placeholder copy */}
        <div style={{ marginTop: 56, fontSize: 36, color: "#8c8c8c" }}>Build graphical applications in the terminal</div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "JetBrains Mono", data: regular, weight: 400, style: "normal" },
        { name: "JetBrains Mono", data: semibold, weight: 600, style: "normal" },
      ],
    },
  );
}

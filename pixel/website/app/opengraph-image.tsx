import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "Pixel · Build graphical applications in the terminal";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TITLE_PX = 110;
const LOGO_PX = 90;

function Logo() {
  return (
    <svg width={LOGO_PX} height={LOGO_PX} viewBox="0 0 32 32" shapeRendering="crispEdges">
      <rect x="9" y="2" width="14" height="14" fill="#ff4d5e" />
      <rect x="1" y="17" width="14" height="14" fill="#3ddc84" />
      <rect x="17" y="17" width="14" height="14" fill="#4d9fff" />
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
        <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
          <span style={{ fontSize: TITLE_PX, fontWeight: 600, letterSpacing: -1, color: "#eeeeee", lineHeight: 1 }}>
            Pixel
          </span>
          <Logo />
        </div>
        {/* fixme: placeholder copy */}
        <div style={{ marginTop: 40, fontSize: 36, color: "#8c8c8c" }}>Build graphical applications in the terminal</div>
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

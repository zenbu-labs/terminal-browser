import type { TerminalStream } from "../react/native";

export const STREAM_ENV = "PIXEL_TERMINAL_STREAM";
export const STREAM_SIZE_ENV = "PIXEL_TERMINAL_SIZE";

export function streamFromEnv(env: NodeJS.ProcessEnv = process.env): TerminalStream | null {
  const socket = env[STREAM_ENV];
  if (!socket) return null;
  const [cells, pixels] = (env[STREAM_SIZE_ENV] ?? "").split(",");
  const [cols, rows] = (cells ?? "").split("x").map(Number);
  const [widthPx, heightPx] = (pixels ?? "").split("x").map(Number);
  return {
    socket,
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 24,
    ...(widthPx > 0 && heightPx > 0 && { widthPx, heightPx }),
  };
}

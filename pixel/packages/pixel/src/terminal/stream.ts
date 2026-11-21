import type { TerminalStream } from "../react/native";

export const STREAM_ENV = "PIXEL_TERMINAL_STREAM";
export const STREAM_SIZE_ENV = "PIXEL_TERMINAL_SIZE";
export const TERMINAL_ENV = "PIXEL_TERMINAL_ENV";
export const FEATURES_VAR = "PIXEL_TERMINAL_FEATURES";

const TERMINAL_VARIABLES = /^(TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|COLORTERM|COLORFGBG|LANG|LANGUAGE|LC_[A-Z_]+)$/;

export function terminalVariables(env: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => TERMINAL_VARIABLES.test(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0),
  );
}

export function streamEnv(stream: { socket: string; cols: number; rows: number; terminal: Record<string, unknown> }): Record<string, string> {
  return {
    [STREAM_ENV]: stream.socket,
    [STREAM_SIZE_ENV]: `${stream.cols}x${stream.rows}`,
    [TERMINAL_ENV]: JSON.stringify({ ...terminalVariables(stream.terminal), [FEATURES_VAR]: "local-terminal" }),
  };
}

export function streamed(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[STREAM_ENV]);
}

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

export function terminalFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  try {
    const described = JSON.parse(env[TERMINAL_ENV] ?? "{}") as Record<string, unknown>;
    const features = described[FEATURES_VAR];
    return { ...terminalVariables(described), ...(typeof features === "string" && { [FEATURES_VAR]: features }) };
  } catch {
    return {};
  }
}

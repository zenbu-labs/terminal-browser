export type PixelUnit = "device" | "css";

export function reportedPixelUnit(env: NodeJS.ProcessEnv = process.env): PixelUnit {
  if (env.TERM_PROGRAM === "vscode" || env.VSCODE_INJECTION) return "css";
  return "device";
}

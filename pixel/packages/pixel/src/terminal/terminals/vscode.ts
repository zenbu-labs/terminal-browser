import type { Detect } from "../terminal";

// we could implement the full api with a vscode extension
export const vscode: Detect = (env) => {
  if (env.TERM_PROGRAM !== "vscode" && !env.VSCODE_INJECTION) return null;
  return {
    name: "vscode",
    reportsCssPixels: true,
  };
};

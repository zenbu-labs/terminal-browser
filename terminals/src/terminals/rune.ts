import type { Detect } from "../terminal";

export const rune: Detect = (env) => {
  if (!env.RUNE_SOCKET) return null;
  return {
    name: "rune",
    graphics: "unsupported",
  };
};

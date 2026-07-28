import { ghostty } from "./ghostty";
import { kitty } from "./kitty";
import { wezterm } from "./wezterm";
import { Backend } from "./shared";

export type { Backend, Direction, Pane } from "./shared";
export { callerTty, setPaneTitle } from "./shared";

export function detectBackend(): Backend {
  if (process.env.TERM_PROGRAM === "ghostty" || process.env.GHOSTTY_RESOURCES_DIR) {
    if (process.platform !== "darwin") {
      throw new Error("Ghostty split control is only available on macOS; use pixel open --here");
    }
    return ghostty;
  }
  if (process.env.KITTY_WINDOW_ID || process.env.KITTY_PID) return kitty;
  if (process.env.TERM_PROGRAM === "WezTerm" || process.env.WEZTERM_PANE) return wezterm;
  throw new Error(
    "unsupported terminal: need Ghostty, kitty (allow_remote_control), or WezTerm",
  );
}

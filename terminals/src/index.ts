import { ghostty } from "./ghostty";
import { createKitty } from "./kitty";
import { createTmux } from "./tmux";
import { createTty7 } from "./tty7";
import { createWezterm } from "./wezterm";
import { Backend } from "./shared";

export type { Backend, Direction, Pane } from "./shared";
export { callerTty, setPaneTitle } from "./shared";
export { prepareTmux } from "./tmux";
export type { GraphicsSupport } from "./graphics";
export type { PixelUnit } from "./pixels";
export { reportedPixelUnit } from "./pixels";
export {
  checkKittyGraphics,
  graphicsFromEnv,
  probeKittyGraphics,
  unsupportedGraphicsMessage,
  SKIP_ENV as GRAPHICS_SKIP_ENV,
} from "./graphics";

export function detectBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  const term = env.TERM ?? "";
  if (env.TTY7_PANE || env.TERM_PROGRAM === "tty7") return createTty7(env);
  if (env.TMUX) return createTmux(env);
  if (term.includes("ghostty") || env.TERM_PROGRAM === "ghostty" || env.GHOSTTY_RESOURCES_DIR) {
    if ((env.TERM_PROGRAM_VERSION?.localeCompare("1.3.0", undefined, { numeric: true }) ?? 0) < 0) throw new Error(`Ghostty ${env.TERM_PROGRAM_VERSION} does not support automation: upgrade to Ghostty 1.3.0 or newer.`);
    return ghostty;
  }
  if (env.KITTY_WINDOW_ID || env.KITTY_PID) return createKitty(env);
  if (env.TERM_PROGRAM === "WezTerm" || env.WEZTERM_PANE) return createWezterm(env);
  throw new Error(
    "terminal-browser cannot control this terminal. We recommend Ghostty (https://ghostty.org/download). tty7, kitty, WezTerm, and tmux also work.",
  );
}

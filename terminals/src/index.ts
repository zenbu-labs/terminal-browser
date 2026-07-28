import { ghostty } from "./ghostty";
import { createKitty } from "./kitty";
import { createTmux } from "./tmux";
import { createWezterm } from "./wezterm";
import { Backend } from "./shared";
import { TERMINALS_URL } from "./graphics";

export type { Backend, Direction, Pane } from "./shared";
export { callerTty, setPaneTitle } from "./shared";
export { prepareTmux } from "./tmux";
export type { GraphicsSupport } from "./graphics";
export {
  checkKittyGraphics,
  graphicsFromEnv,
  probeKittyGraphics,
  unsupportedGraphicsMessage,
  SKIP_ENV as GRAPHICS_SKIP_ENV,
  TERMINALS_URL,
} from "./graphics";

export function detectBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  const term = env.TERM ?? "";
  if (env.TMUX) return createTmux(env);
  if (term.includes("ghostty")) return detectGhostty();
  if (term.includes("kitty")) return createKitty(env);
  if (env.TERM_PROGRAM === "ghostty" || env.GHOSTTY_RESOURCES_DIR) {
    return detectGhostty();
  }
  if (env.KITTY_WINDOW_ID || env.KITTY_PID) return createKitty(env);
  if (env.TERM_PROGRAM === "WezTerm" || env.WEZTERM_PANE) return createWezterm(env);
  throw new Error(
    "unsupported terminal: need Ghostty, kitty (allow_remote_control), or WezTerm\n" +
      `\nTerminals that work: ${TERMINALS_URL}`,
  );
}

function detectGhostty(): Backend {
  if (process.platform !== "darwin") {
    throw new Error("Ghostty split control is only available on macOS");
  }
  return ghostty;
}

import fs from "node:fs";
import path from "node:path";

export const EXTENSION_WINDOW_ENV = "TERMINAL_BROWSER_EXTENSION_WINDOW";

// A pane starts with the terminal's environment, so the profile the daemon runs
// with has to travel along or the new browser would join a different daemon.
const PROFILE_ENV = [
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "TERMINAL_BROWSER_APPDATA",
  "TERMINAL_BROWSER_DIST_ROOT",
];

// What a new pane runs to open a browser in it: `terminal-browser open`, like `--split` does.
export function paneLaunchCommand(env: NodeJS.ProcessEnv, argv: string[], extra: Record<string, string>): string[] | null {
  const vars: Record<string, string> = {};
  for (const key of PROFILE_ENV) {
    const value = env[key] ?? process.env[key];
    if (value) vars[key] = value;
  }
  Object.assign(vars, extra);
  let runner: string[];
  if (vars.TERMINAL_BROWSER_DIST_ROOT) {
    runner = [path.join(vars.TERMINAL_BROWSER_DIST_ROOT, "bin", "terminal-browser")];
  } else {
    const cli = path.resolve(__dirname, "../../../cli/dist/main.js");
    if (!fs.existsSync(cli)) return null;
    runner = [process.execPath, cli];
    vars.ELECTRON_RUN_AS_NODE = "1";
  }
  return ["/usr/bin/env", ...Object.entries(vars).map(([key, value]) => `${key}=${value}`), ...runner, "open", ...argv];
}

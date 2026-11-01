export const LAUNCH_ENV = "TERMINAL_BROWSER_LAUNCH";

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

// What a new pane runs to open a browser in it. Terminals hand this to whatever shell the
// user has (fish, nushell...), so it holds no URLs or flags: the new browser fetches those
// from the daemon with `token`.
export function paneLaunchCommand(
  env: NodeJS.ProcessEnv,
  runner: string[],
  token: string,
  extra: Record<string, string> = {},
): string[] {
  const vars: Record<string, string> = {};
  for (const key of PROFILE_ENV) {
    const value = env[key] ?? process.env[key];
    if (value) vars[key] = value;
  }
  Object.assign(vars, extra, { [LAUNCH_ENV]: token });
  return ["/usr/bin/env", ...Object.entries(vars).map(([key, value]) => `${key}=${value}`), ...runner, "open"];
}

export function isLaunchToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

const OPT_OUT_ENV_VARS = ["DO_NOT_TRACK", "TERMINAL_BROWSER_NO_TELEMETRY"];

export function telemetryOptedOutByEnv(): boolean {
  return OPT_OUT_ENV_VARS.some((name) => {
    const value = process.env[name]?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
  });
}

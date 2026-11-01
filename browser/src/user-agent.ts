import { app } from "electron";

// Chrome's own user agent shape, without Electron's app and "Electron/" tokens,
// so sites (the Chrome Web Store included) treat us like Chrome.
export function chromeUserAgent(fallback = app.userAgentFallback): string {
  const platform = /\(([^)]*)\)/.exec(fallback)?.[1] ?? "Macintosh; Intel Mac OS X 10_15_7";
  const major = (process.versions.chrome ?? "").split(".")[0] || "152";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

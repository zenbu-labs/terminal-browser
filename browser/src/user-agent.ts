import { app } from "electron";

let presented: string | null = null;

export function browserUserAgent(): string {
  presented ??= withoutEmbedderTokens(app.userAgentFallback);
  return presented;
}

export function applyUserAgentPolicy(): void {
  app.userAgentFallback = browserUserAgent();
}

// Electron's default user agent carries "<app name>/<version>" and "Electron/<version>" next to
// Chromium's own tokens. Google and other identity providers refuse OAuth flows from either, so
// drop both products and leave the rest of the string as Chromium built it. navigator.userAgentData
// still reports Chromium and not Google Chrome; Electron gives us no way to change that.
function withoutEmbedderTokens(userAgent: string): string {
  const appProduct = app.getName().replace(/\s+/g, "").toLowerCase();
  return userAgent
    .split(" ")
    .filter((token) => {
      const slash = token.indexOf("/");
      const product = (slash < 0 ? token : token.slice(0, slash)).toLowerCase();
      return product !== "electron" && product !== appProduct;
    })
    .join(" ");
}

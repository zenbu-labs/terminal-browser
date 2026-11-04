import { quarantineFile } from "@zenbu-labs/pixel/native";
import { app } from "electron";

export interface DownloadSource {
  url: string;
  referrer: string;
  initiator: string;
}

// quarantine::SanitizeUrlForQuarantine: data: URLs carry no authority, blob:
// and filesystem: URLs only mean their origin, and web URLs lose credentials.
export function quarantineUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.protocol === "data:") return "";
  if (parsed.protocol === "blob:" || parsed.protocol === "filesystem:") {
    try {
      const origin = new URL(parsed.pathname).origin;
      return origin === "null" ? "" : `${origin}/`;
    } catch {
      return "";
    }
  }
  if (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    parsed.username = "";
    parsed.password = "";
  }
  return parsed.href;
}

// The referrer a link click sends under the default policy
// (strict-origin-when-cross-origin), which is what Chrome records as a
// download's referrer.
export function downloadReferrer(page: string, download: string): string {
  try {
    const from = new URL(page);
    const to = new URL(download);
    if (from.protocol !== "http:" && from.protocol !== "https:") return "";
    if (from.protocol === "https:" && to.protocol === "http:") return "";
    if (from.origin !== to.origin) return `${from.origin}/`;
    from.username = "";
    from.password = "";
    from.hash = "";
    return from.href;
  } catch {
    return "";
  }
}

// quarantine::QuarantineFile: the source falls back to the initiator when the
// URL itself says nothing about where the bytes came from.
export function quarantineDownload(file: string, source: DownloadSource) {
  const url = quarantineUrl(source.url) || quarantineUrl(source.initiator);
  quarantineFile(file, url, quarantineUrl(source.referrer), app.getName());
}

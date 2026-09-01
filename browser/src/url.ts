import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function localFile(input: string, cwd?: string): string | null {
  const expanded =
    input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(1)) : input;
  let absolute: string | null = null;
  if (path.isAbsolute(expanded)) absolute = expanded;
  else if (cwd && /^\.\.?(?:\/|$)/.test(expanded)) absolute = path.resolve(cwd, expanded);
  if (!absolute) return null;
  return fs.existsSync(absolute) ? absolute : null;
}

/** Hosts a dev server listens on, which a browser has to reach over http. */
function servedLocally(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost")
  );
}

function barePort(input: string): string | null {
  const port = Number(input);
  return /^\d+$/.test(input) && port >= 1 && port <= 65535 ? input : null;
}

export function searchOrUrl(text: string, cwd?: string): string {
  const trimmed = text.trim();
  if (HAS_AUTHORITY.test(trimmed) || SCHEMES_WITHOUT_HOST.test(trimmed)) return trimmed;
  if (localFile(trimmed, cwd)) return trimmed;
  if (!trimmed.includes(" ") && trimmed.includes(".")) return trimmed;
  if (/^[\w-]+:\d+(\/.*)?$/.test(trimmed)) return trimmed;
  if (servedLocally(trimmed.split(/[:/?#]/)[0].toLowerCase())) return trimmed;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function normalizeUrl(value: string, cwd?: string): string {
  const input = value.trim();
  if (!input) return "about:blank";
  if (HAS_AUTHORITY.test(input) || SCHEMES_WITHOUT_HOST.test(input)) {
    try {
      return new URL(input).toString();
    } catch {}
  }
  const file = localFile(input, cwd);
  if (file) return pathToFileURL(file).toString();
  // a bare port is a dev server; without this the url parser reads the digits
  // as an ipv4 address, so `3000` would load https://0.0.11.184
  const port = barePort(input);
  if (port) return new URL(`http://localhost:${port}`).toString();
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(input)) {
    const host = input.split(/[:/]/)[0].toLowerCase();
    const scheme = servedLocally(host) ? "http" : "https";
    return new URL(`${scheme}://${input}`).toString();
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEMES_WITHOUT_HOST = /^(?:data|mailto|tel|about|blob|chrome|view-source):/i;

/** Compact form shown in the tab strip. */
export function displayUrl(url: string): string {
  if (!url || url === "about:blank") return "new tab";
  if (url.startsWith("file://")) return homeRelative(url);
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function homeRelative(url: string): string {
  try {
    const file = fileURLToPath(url);
    const home = os.homedir();
    if (file === home) return "~";
    return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
  } catch {
    return url;
  }
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

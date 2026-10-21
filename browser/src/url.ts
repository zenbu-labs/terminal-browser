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

export type SearchUrl = (query: string) => string;

export function searchUrlFor(template: string): SearchUrl {
  return (query) => {
    const encoded = encodeURIComponent(query);
    return template.includes("%s") ? template.split("%s").join(encoded) : `${template}${encoded}`;
  };
}

export function searchOrUrl(text: string, cwd: string | undefined, search: SearchUrl): string {
  const trimmed = text.trim();
  if (HAS_AUTHORITY.test(trimmed) || SCHEMES_WITHOUT_HOST.test(trimmed)) return trimmed;
  if (localFile(trimmed, cwd)) return trimmed;
  if (!trimmed.includes(" ") && trimmed.includes(".")) return trimmed;
  if (/^[\w-]+:\d+(\/.*)?$/.test(trimmed)) return trimmed;
  return search(trimmed);
}

export function normalizeUrl(value: string, cwd: string | undefined, search: SearchUrl): string {
  const input = value.trim();
  if (!input) return "about:blank";
  if (HAS_AUTHORITY.test(input) || SCHEMES_WITHOUT_HOST.test(input)) {
    try {
      return new URL(input).toString();
    } catch {}
  }
  const file = localFile(input, cwd);
  if (file) return pathToFileURL(file).toString();
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(input)) {
    const host = input.split(/[:/]/)[0].toLowerCase();
    const scheme = host === "localhost" || host === "127.0.0.1" ? "http" : "https";
    return new URL(`${scheme}://${input}`).toString();
  }
  return search(input);
}

export function resolveRestoreUrl(
  restore: boolean,
  lastUrl: string | null | undefined,
): string | null {
  if (!restore) return null;
  const last = lastUrl?.trim();
  return last && /^https?:\/\//.test(last) ? last : null;
}

export function resolveDefaultUrl(
  env: NodeJS.ProcessEnv,
  homeDefault: string,
  startUrl: string,
  devUrl: string,
): string {
  // Tooling sessions set =1 to land empty tabs on the dev dashboard.
  if (env.TERMINAL_BROWSER_START_PAGE === "1") return devUrl;
  return homeDefault === "blank" ? "about:blank" : startUrl;
}

const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEMES_WITHOUT_HOST = /^(?:data|mailto|tel|about|blob|chrome|view-source):/i;

export function displayUrl(url: string): string {
  if (!url) return "about:blank";
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

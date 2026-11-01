import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// local files are served through this scheme so markdown can be rendered and
// html previews can be sandboxed
export const DOC_SCHEME = "terminal-browser-file";

export function documentUrl(file: string): string {
  return `${DOC_SCHEME}://file${file.split(path.sep).map(encodeURIComponent).join("/")}`;
}

// The local document a file:// url shows, or null for a file on another host.
export function documentUrlForFile(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return null;
    return `${documentUrl(fileURLToPath(parsed))}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

// The file:// url Chrome would show for a local document.
export function fileUrlForDocument(url: string): string {
  const prefix = `${DOC_SCHEME}://file`;
  return url.startsWith(prefix) ? `file://${url.slice(prefix.length)}` : url;
}

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
  const input = value.trim().replace(/^chrome:\/\//i, "terminal-browser://");
  if (!input) return "about:blank";
  if (HAS_AUTHORITY.test(input) || SCHEMES_WITHOUT_HOST.test(input)) {
    try {
      const url = new URL(input);
      if (url.protocol === "file:") return documentUrlForFile(url.href) ?? url.toString();
      return url.toString();
    } catch {}
  }
  const file = localFile(input, cwd);
  if (file) return documentUrl(file);
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(input)) {
    const host = input.split(/[:/]/)[0].toLowerCase();
    const scheme = host === "localhost" || host === "127.0.0.1" ? "http" : "https";
    return new URL(`${scheme}://${input}`).toString();
  }
  return search(input);
}

const MARKDOWN = /\.(?:md|markdown)$/i;
const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEMES_WITHOUT_HOST = /^(?:data|mailto|tel|about|blob|chrome|view-source):/i;

export function displayUrl(url: string): string {
  if (!url) return "about:blank";
  if (url.startsWith("file://")) return homeRelative(url);
  if (url.startsWith(`${DOC_SCHEME}://`)) return homeRelative(`file://${url.slice(`${DOC_SCHEME}://file`.length)}`);
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

export function isMarkdownDocument(url: string): boolean {
  return url.startsWith(`${DOC_SCHEME}://`) && MARKDOWN.test(url.split(/[?#]/)[0]);
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

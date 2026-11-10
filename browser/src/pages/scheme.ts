import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { protocol } from "electron";

import { MARKDOWN_CSP, renderMarkdown } from "./markdown";
import { renderStartPage } from "./start";
import type { Theme } from "../ui/theme";
import { DOC_SCHEME } from "../url";



export const SCHEME = "terminal-browser";
export const START_URL = `${SCHEME}://start`;
export const HOME_URL = "https://terminal-browser.com";

export interface PageContext {
  cwd: string;
  theme: Theme | null;
}

type Rgba = [number, number, number, number];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".vtt": "text/vtt; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};


export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: DOC_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ]);
}

export function servePages(context: () => PageContext) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host === "start") return renderStartPage(url, context());
    return new Response("", { status: 404 });
  });
  protocol.handle(DOC_SCHEME, async (request) => {
    const url = new URL(request.url);
    return serveDocument(decodeURIComponent(url.pathname), request.headers.get("range"), context().theme);
  });
}

const DOC_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-src https: http: data:; object-src 'none'";

async function serveDocument(file: string, range: string | null, theme: Theme | null): Promise<Response> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return new Response("", { status: 404 });
    const extension = path.extname(file).toLowerCase();
    if (extension === ".md" || extension === ".markdown") {
      const source = await fs.promises.readFile(file, "utf8");
      return new Response(await renderMarkdown(source, path.basename(file), theme), {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": MARKDOWN_CSP },
      });
    }
    const headers: Record<string, string> = {
      "content-security-policy": DOC_CSP,
      "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "accept-ranges": "bytes",
    };
    const bytes = range ? byteRange(range, stat.size) : null;
    if (bytes === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${stat.size}` } });
    }
    const [start, end] = bytes ?? [0, stat.size - 1];
    if (bytes) headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
    headers["content-length"] = String(Math.max(0, end - start + 1));
    const body = stat.size === 0 ? null : (Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream);
    return new Response(body, { status: bytes ? 206 : 200, headers });
  } catch {
    return new Response("", { status: 404 });
  }
}

function byteRange(header: string, size: number): [number, number] | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (match[1] && match[2] && Number(match[1]) > Number(match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start >= size || start > end ? "unsatisfiable" : [start, end];
}

export function html(markup: string): Response {
  return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function css(color: Rgba | undefined, fallback: string): string {
  if (!color) return fallback;
  const [r, g, b, a] = color;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function pageColors(theme: Theme | null) {
  return {
    bg: css(theme?.bg, "#1e1e1e"),
    fg: css(theme?.fg, "#e6e6e6"),
    muted: css(theme?.muted, "#8a8f98"),
    accent: css(theme?.accent, "#6ea8ff"),
    hairline: css(theme?.hairline, "rgba(255,255,255,0.12)"),
    field: css(theme?.field, "rgba(255,255,255,0.06)"),
    red: css(theme?.red, "#f2777a"),
    green: css(theme?.green, "#99cc99"),
    yellow: css(theme?.yellow, "#ffcc66"),
    magenta: css(theme?.magenta, "#cc99cc"),
    cyan: css(theme?.cyan, "#66cccc"),
  };
}

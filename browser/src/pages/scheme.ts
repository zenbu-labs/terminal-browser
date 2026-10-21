import fs from "node:fs";
import path from "node:path";

import { protocol } from "electron";

import { ConfigStore, SETTINGS_FILE, SHORTCUTS_FILE, SUGGESTIONS_OFF } from "shared";

import { renderMarkdown } from "./markdown";
import { collectStartData, loadStartAsset, loadStartAssetBytes, renderStartPage } from "./start";
import { routeStartApi, suggestUrl } from "./start-api";
import type { Theme } from "../ui/theme";



export const SCHEME = "terminal-browser";
// local file previews get their own scheme without fetch/CORS, so a page opened
// from disk can run its scripts but cannot read other local files
export const DOC_SCHEME = "terminal-browser-file";
export const START_URL = `${SCHEME}://start`;
export const HOME_URL = "https://terminal-browser.com";
export const DEV_URL = `${SCHEME}://dev`;

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
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};


export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: DOC_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

function activeSuggestTemplate(): string | null {
  try {
    const settings = new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE }).load().settings;
    const value = settings?.["search.suggestions"];
    if (!value || value === SUGGESTIONS_OFF) return null;
    return value;
  } catch {
    return null;
  }
}

export function servePages(context: () => PageContext) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== "start" && url.host !== "dev") return new Response("", { status: 404 });
    const route = routeStartApi(request.method, url);
    switch (route.kind) {
      case "page":
        return renderStartPage(url, context());
      case "data":
        return json(await collectStartData(context().cwd));
      case "suggest": {
        // Suggestions go through the main process; the page calls ./api/suggest.
        if (!route.query.trim()) return json({ error: "missing query" }, 400);
        const upstream = suggestUrl(activeSuggestTemplate(), route.query);
        if (!upstream) return json({ error: "suggestions off" }, 404);
        try {
          const response = await fetch(upstream, { signal: AbortSignal.timeout(3000) });
          if (!response.ok) return json({ error: "suggestion fetch failed" }, 502);
          return new Response(await response.text(), {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        } catch {
          return json({ error: "suggestion fetch failed" }, 502);
        }
      }
      case "page-css":
        return new Response(loadStartAsset("page.css"), {
          headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
        });
      case "page-icon":
        return new Response(loadStartAssetBytes("icon.png"), {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
        });
      case "not-found":
        return json({ error: "not found" }, 404);
    }
  });
  protocol.handle(DOC_SCHEME, async (request) => {
    const url = new URL(request.url);
    return serveDocument(decodeURIComponent(url.pathname), context().theme);
  });
}

export function documentUrl(file: string): string {
  return `${DOC_SCHEME}://file${file.split(path.sep).map(encodeURIComponent).join("/")}`;
}

// a previewed file may embed remote frames but not other local files, so it
// cannot reach a same-origin local document to read its DOM
const DOC_CSP = "frame-src https: http: data:; object-src 'none'";

async function serveDocument(file: string, theme: Theme | null): Promise<Response> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return new Response("", { status: 404 });
    const body = await fs.promises.readFile(file);
    const extension = path.extname(file).toLowerCase();
    const headers: Record<string, string> = { "content-security-policy": DOC_CSP };
    if (extension === ".md" || extension === ".markdown") {
      headers["content-type"] = "text/html; charset=utf-8";
      return new Response(await renderMarkdown(body.toString("utf8"), path.basename(file), theme), { headers });
    }
    headers["content-type"] = CONTENT_TYPES[extension] ?? "application/octet-stream";
    return new Response(body, { headers });
  } catch {
    return new Response("", { status: 404 });
  }
}

export function html(markup: string): Response {
  return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
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
    fg: css(theme?.fg, "#e6e6e6"),
    muted: css(theme?.muted, "#8a8f98"),
    accent: css(theme?.accent, "#4d9fff"),
    hairline: css(theme?.hairline, "rgba(255,255,255,0.12)"),
    field: css(theme?.field, "rgba(255,255,255,0.06)"),
  };
}

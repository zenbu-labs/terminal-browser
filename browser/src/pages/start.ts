import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { engineBySearch } from "shared";

import { bundledAsset } from "../assets";
import type { Theme } from "../ui/theme";
import { documentUrl, escape, html, json, pageColors } from "./scheme";
import type { PageContext } from "./scheme";
import { resolveSearchEngine, startVariant } from "./start-api";



interface Port {
  port: number;
  command: string;
}

interface Document {
  url: string;
  label: string;
  age: string;
}

const PullRequest = z.object({ url: z.string(), title: z.string(), number: z.number() });
type PullRequest = z.infer<typeof PullRequest>;

const exec = promisify(execFile);
const RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_PORTS = 10;
const MAX_DOCUMENTS = 8;
const PORT_NOISE = ["ControlCe", "rapportd", "sharingd", "agent-bro", "identitys", "Electron", "terminal-"];

const SHELL = `<!doctype html>
<html><head><meta charset="utf-8"><title>terminal-browser</title><link rel="icon" href="./icon.png">
<link rel="stylesheet" href="./page.css">
{{THEME_STYLE}}</head>
<body>
{{HERO}}
{{DEV}}
{{FOOT}}
<script>{{PAGE_JS}}</script>
</body></html>`;

export async function renderStartPage(url: URL, context: PageContext): Promise<Response> {
  // Home skips the slow port, document and pull request lookups so it appears immediately.
  if (startVariant(url) === "home" && !url.searchParams.has("data")) {
    const data = { searchEngine: resolveSearchEngine(context.searchEngine), ports: [], documents: [], pr: null };
    return html(render(data, context.theme, "home"));
  }
  const data = await collectStartData(context);
  if (url.searchParams.has("data")) return json(data);
  return html(render(data, context.theme, startVariant(url)));
}

export async function collectStartData(context: PageContext) {
  const [ports, documents, pr] = await Promise.all([
    listeningPorts(),
    recentDocuments(context.cwd),
    openPullRequest(context.cwd),
  ]);
  return { ports, documents, pr, searchEngine: resolveSearchEngine(context.searchEngine) };
}

async function listeningPorts(): Promise<Port[]> {
  let stdout = "";
  try {
    ({ stdout } = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { timeout: 3000 }));
  } catch {
    return [];
  }
  const seen = new Map<number, Port>();
  for (const line of stdout.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    const command = parts[0];
    const port = Number(parts[8]?.split(":").pop());
    if (!command || !Number.isInteger(port) || port < 1024 || seen.has(port)) continue;
    if (PORT_NOISE.some((noise) => command.startsWith(noise))) continue;
    seen.set(port, { port, command });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port).slice(0, MAX_PORTS);
}

async function recentDocuments(cwd: string): Promise<Document[]> {
  const now = Date.now();
  const found: { file: string; mtime: number }[] = [];
  const scan = async (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) await scan(file, depth - 1);
        continue;
      }
      if (!/\.(?:html?|md|markdown)$/i.test(entry.name)) continue;
      try {
        const mtime = (await fs.promises.stat(file)).mtimeMs;
        if (now - mtime <= RECENT_WINDOW_MS) found.push({ file, mtime });
      } catch {}
    }
  };
  await Promise.all([cwd, ...new Set([os.tmpdir(), "/tmp"])].map((dir) => scan(dir, 1)));
  found.sort((a, b) => b.mtime - a.mtime);
  const home = os.homedir();
  return found.slice(0, MAX_DOCUMENTS).map(({ file, mtime }) => ({
    url: documentUrl(file),
    label: file.startsWith(cwd + path.sep)
      ? file.slice(cwd.length + 1)
      : file.startsWith(home + path.sep)
        ? `~${file.slice(home.length)}`
        : file,
    age: ago(now - mtime),
  }));
}

async function openPullRequest(cwd: string): Promise<PullRequest | null> {
  try {
    const { stdout } = await exec("gh", ["pr", "view", "--json", "url,title,number"], { cwd, timeout: 4000 });
    const parsed = PullRequest.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function loadStartAsset(name: string): string {
  const file = bundledAsset(`start/${name}`);
  if (!file) throw new Error(`missing start asset: start/${name}`);
  return fs.readFileSync(file, "utf8");
}

export function loadStartAssetBytes(name: string): Uint8Array<ArrayBuffer> {
  const file = bundledAsset(`start/${name}`);
  if (!file) throw new Error(`missing start asset: start/${name}`);
  return fs.readFileSync(file);
}

export function render(
  data: Awaited<ReturnType<typeof collectStartData>>,
  theme: Theme | null,
  variant: "home" | "dev" = "home",
): string {
  const { fg, muted, accent, hairline, field, overlay } = pageColors(theme);
  const link = (href: string, text: string) => `<a href="${escape(href)}" target="_blank">${escape(text)}</a>`;
  const section = (title: string, rows: string[]) =>
    rows.length === 0 ? "" : `<section><h2>${escape(title)}</h2><ul>${rows.join("")}</ul></section>`;
  const suggest = engineBySearch(data.searchEngine)?.suggest ?? null;
  const hero = `<header class="hero">
<h1><img src="./icon.png" alt="" width="30" height="30"> terminal-browser</h1>
<form id="search-form" role="search"><input id="search-input" name="q" type="search" autofocus autocomplete="off" spellcheck="false" placeholder="Search or enter URL..." aria-label="Search or enter URL" data-search-template="${escape(data.searchEngine)}"${suggest ? ` data-suggest-template="${escape(suggest)}"` : ""}><ul id="search-suggest" role="listbox" aria-label="Search suggestions" hidden></ul></form>
<p class="hint">Enter opens here · Alt+Enter opens a new tab · / focuses search</p>
</header>`;
  const body =
    section("Pull request", data.pr ? [`<li>${link(data.pr.url, `#${data.pr.number} ${data.pr.title}`)}</li>`] : []) +
    section(
      "Running servers",
      data.ports.map((p) => `<li>${link(`http://localhost:${p.port}`, `localhost:${p.port}`)}<span>${escape(p.command)}</span></li>`),
    ) +
    section(
      "Recent documents",
      data.documents.map((d) => `<li>${link(d.url, d.label)}<span>${escape(d.age)}</span></li>`),
    );
  const themeStyle = `<style>:root{--fg:${fg};--muted:${muted};--accent:${accent};--hairline:${hairline};--field:${field};--overlay:${overlay};}</style>`;
  const pageJs = loadStartAsset("page.js");
  const dev = body || `<p class="empty">no running servers, no recent documents, no open pull request</p>`;
  const foot = `<p class="hint" id="home-foot">prefer a blank page? set home.default to blank and turn off home.restore in settings (ctrl+,)</p>
<p class="hint">running servers and recent files live at <a href="terminal-browser://dev">terminal-browser://dev</a></p>`;
  // A replacer function keeps `$&` in inserted text literal.
  const parts: Record<string, string> = {
    HERO: variant === "home" ? hero : "",
    DEV: variant === "dev" ? dev : "",
    FOOT: variant === "home" ? foot : "",
    THEME_STYLE: themeStyle,
    PAGE_JS: pageJs,
  };
  return SHELL.replace(
    /{{(HERO|DEV|FOOT|THEME_STYLE|PAGE_JS)}}/g,
    (_match, key: keyof typeof parts) => parts[key],
  );
}

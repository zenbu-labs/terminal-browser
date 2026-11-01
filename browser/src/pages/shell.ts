import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Theme } from "../ui/theme";
import { escape, pageColors } from "./scheme";

const scripts = new Map<string, string>();

function clientScript(name: string): string {
  const cached = scripts.get(name);
  if (cached !== undefined) return cached;
  const candidates = [path.join(__dirname, "client", `${name}.js`), path.join(__dirname, "pages", "client", `${name}.js`)];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`page script missing (looked in ${candidates.join(", ")})`);
  const source = fs.readFileSync(found, "utf8").replace(/<\/script/gi, "<\\/script");
  scripts.set(name, source);
  return source;
}

export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

// Lucide "chevron-down" (lucide.dev) for select boxes, which can't draw their
// arrow in the text colour any other way.
function chevron(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function pageStyles(theme: Theme | null): string {
  const { fg, muted, accent, hairline, field, red, surface, hover } = pageColors(theme);
  return `
  :root { color-scheme: dark light; --fg: ${fg}; --muted: ${muted}; --accent: ${accent}; --hairline: ${hairline};
    --field: ${field}; --red: ${red}; --surface: ${surface}; --hover: ${hover}; }
  html, body { margin: 0; background: transparent; color: var(--fg); }
  body { font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 760px; padding: 28px 32px 48px; }
  header { position: relative; display: flex; align-items: center; gap: 14px; min-height: 30px; margin-bottom: 20px; }
  .popover { position: absolute; z-index: 1; top: calc(100% + 6px); left: -12px; right: -12px; padding: 10px 12px;
    background: var(--surface); border: 1px solid var(--hairline); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
  .popover .row { padding: 0; }
  .popover .error { margin: 8px 0 0; }
  .invisible { visibility: hidden; }
  button.fixed-remove { min-width: 7ch; text-align: left; }
  button.fixed-status { min-width: calc(10ch + 22px); }
  button.fixed-import { min-width: calc(11ch + 22px); }
  button.fixed-shortcut { min-width: calc(17ch + 22px); }
  h1 { flex: 1; font-size: 15px; font-weight: 600; margin: 0; white-space: nowrap; }
  h2 { font-size: 11px; font-weight: 500; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 6px; }
  section + section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--hairline); }
  ul { list-style: none; margin: 0; padding: 0; }
  a { color: var(--accent); text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
  .glyph { width: 1em; height: 1em; flex-shrink: 0; }
  a.back { display: inline-flex; align-items: center; gap: 0.4em; }
  .muted { color: var(--muted); }
  .error { color: var(--red); }
  .grow { flex: 1; min-width: 0; }
  .clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row { display: flex; align-items: center; gap: 12px; padding: 7px 0; min-height: 26px; }
  .row + .row { border-top: 1px solid var(--hairline); }
  .actions { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
  .hover-only { visibility: hidden; }
  .row:hover .hover-only, .row:focus-within .hover-only { visibility: visible; }
  button { font: inherit; color: var(--fg); background: var(--field); border: 1px solid var(--hairline);
    border-radius: 6px; padding: 2px 10px; cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--hover); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.link { background: none; border: none; padding: 0; color: var(--accent); border-radius: 0; }
  button.link:hover { text-decoration: underline; background: none; }
  button.quiet { color: var(--muted); }
  button.danger { color: var(--red); }
  input[type="text"], input[type="search"], select { font: inherit; color: var(--fg); background: var(--field);
    border: 1px solid var(--hairline); border-radius: 6px; padding: 3px 10px; outline: none; min-width: 0; }
  input[type="search"] { width: 240px; }
  input:focus, select:focus { border-color: var(--accent); }
  select { appearance: none; padding-right: 28px; background-image: url("${chevron(muted)}");
    background-repeat: no-repeat; background-position: right 8px center; background-size: 14px; }
  select::picker-icon { display: none; }
  select option { background: var(--surface); color: var(--fg); }
  input[type="checkbox"] { accent-color: var(--accent); margin: 0; }
  .switch { position: relative; width: 30px; height: 17px; flex-shrink: 0; padding: 0; border: none; border-radius: 9px;
    background: var(--hairline); }
  .switch:hover { background: var(--hairline); filter: brightness(1.15); }
  .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 11px; height: 11px; border-radius: 50%;
    background: var(--muted); transition: left 0.12s; }
  .switch[aria-checked="true"], .switch[aria-checked="true"]:hover { background: var(--accent); }
  .switch[aria-checked="true"]::after { left: 16px; background: var(--surface); }
  .icon { width: 24px; height: 24px; flex-shrink: 0; object-fit: contain; }
  .icon.blank { border-radius: 6px; background: var(--field); }
  .badge { color: var(--red); border: 1px solid var(--red); border-radius: 4px; padding: 0 5px; font-size: 11px; }
  .label { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .kv { display: grid; grid-template-columns: 150px 1fr; column-gap: 16px; row-gap: 10px; }
  .kv > :nth-child(odd) { color: var(--muted); }
  .kv > :nth-child(even) { min-width: 0; overflow-wrap: anywhere; }
  .bar { height: 3px; border-radius: 2px; background: var(--hairline); overflow: hidden; margin-top: 4px; }
  .bar > div { height: 100%; background: var(--accent); }
  .empty { color: var(--muted); padding: 7px 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .chips button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  .unavailable { color: var(--muted); cursor: default; }
  .unavailable .icon { opacity: 0.5; }
  .item + .item { border-top: 1px solid var(--hairline); }
  .import-status { max-width: 60%; min-height: 1.6em; }
  .spinner { display: block; margin: 0.3em 0 0 auto; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  `;
}

export function pageHtml(options: { title: string; theme: Theme | null; body?: string; script?: string; inline?: string }) {
  const nonce = crypto.randomBytes(16).toString("base64");
  const script = options.script ? clientScript(options.script) : (options.inline ?? "");
  const markup = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(options.title)}</title>
<style nonce="${nonce}">${pageStyles(options.theme)}</style></head>
<body>${options.body ?? `<main id="app"></main>`}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
  return new Response(markup, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": pageCsp(nonce),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

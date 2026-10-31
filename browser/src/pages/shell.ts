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

export function pageStyles(theme: Theme | null): string {
  const { fg, muted, accent, hairline, field, red, surface, hover } = pageColors(theme);
  return `
  :root { color-scheme: dark light; --fg: ${fg}; --muted: ${muted}; --accent: ${accent}; --hairline: ${hairline};
    --field: ${field}; --red: ${red}; --surface: ${surface}; --hover: ${hover}; }
  html, body { margin: 0; background: transparent; color: var(--fg); }
  body { font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 760px; padding: 28px 32px 48px; }
  header { display: flex; align-items: center; gap: 14px; min-height: 30px; margin-bottom: 20px; }
  h1 { flex: 1; font-size: 15px; font-weight: 600; margin: 0; white-space: nowrap; }
  h2 { font-size: 11px; font-weight: 500; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 6px; }
  section + section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--hairline); }
  ul { list-style: none; margin: 0; padding: 0; }
  a { color: var(--accent); text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
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
  .form { margin-bottom: 18px; }
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

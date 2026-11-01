import os from "node:os";

import { session } from "electron";

import { DATA_DIR, installedVersion } from "shared";

import { escape } from "./scheme";
import type { PageContext } from "./scheme";
import { pageHtml } from "./shell";

export function renderVersionPage(context: PageContext): Response {
  const rows: [string, string][] = [
    ["terminal-browser", installedVersion() ?? "dev"],
    ["Chromium", process.versions.chrome],
    ["Electron", process.versions.electron],
    ["V8", process.versions.v8],
    ["Node", process.versions.node],
    ["OS", `${os.type()} ${os.release()} (${os.arch()})`],
    ["User agent", session.defaultSession.getUserAgent()],
    ["Command line", process.argv.join(" ")],
    ["Executable", process.execPath],
    ["Profile", DATA_DIR],
  ];
  const body = rows.map(([label, value]) => `<div>${escape(label)}</div><div>${escape(value)}</div>`).join("");
  const title = "About terminal-browser";
  return pageHtml({
    title,
    theme: context.theme,
    body: `<main><header><h1>${escape(title)}</h1></header><div class="kv">${body}</div></main>`,
  });
}

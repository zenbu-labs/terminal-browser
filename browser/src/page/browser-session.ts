import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, net, session } from "electron";
import type { Session } from "electron";

export interface DownloadProgress {
  name: string;
  savePath: string;
  received: number;
  total: number;
  state: "progressing" | "done" | "failed";
}

const GRANTED = new Set([
  "fullscreen",
  "pointerLock",
  "clipboard-sanitized-write",
  "midi",
]);

const configured = new WeakSet<Session>();

export function configureBrowserSession(
  partition: string | null,
  onDownload: (progress: DownloadProgress) => void,
): Session {
  const target = partition ? session.fromPartition(partition) : session.defaultSession;
  if (configured.has(target)) return target;
  configured.add(target);

  target.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(GRANTED.has(permission));
  });
  target.setPermissionCheckHandler((_contents, permission) => GRANTED.has(permission));

  target.webRequest.onBeforeRequest({ urls: ["file://*", "file://*/*"] }, (details, callback) => {
    callback({ cancel: details.resourceType === "xhr" });
  });

  target.protocol.handle("file", async (request) => {
    const directory = requestedDirectory(request.url);
    if (directory) return directoryListing(directory);
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });

  target.on("will-download", (_event, item) => {
    const savePath = downloadPath(item.getFilename());
    item.setSavePath(savePath);
    const report = (state: DownloadProgress["state"]) =>
      onDownload({
        name: path.basename(savePath),
        savePath,
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        state,
      });
    item.on("updated", (_updated, state) =>
      report(state === "interrupted" ? "failed" : "progressing"),
    );
    item.once("done", (_done, state) => report(state === "completed" ? "done" : "failed"));
    report("progressing");
  });

  return target;
}

function requestedDirectory(url: string): string | null {
  try {
    const file = fileURLToPath(new URL(url).href.split(/[?#]/)[0]);
    return fs.statSync(file).isDirectory() ? file : null;
  } catch {
    return null;
  }
}

function directoryListing(directory: string): Response {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, directory: isDirectory(directory, entry) }))
    .sort((a, b) =>
      a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1,
    );
  const parent = path.dirname(directory);
  const rows = entries.map((entry) => {
    const href = pathToFileURL(path.join(directory, entry.name)).toString();
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(entry.name)}${entry.directory ? "/" : ""}</a></li>`;
  });
  const up = parent === directory ? "" : `<li><a href="${pathToFileURL(parent)}">../</a></li>`;
  const html = `<!doctype html><meta charset="utf-8"><title>Index of ${escapeHtml(directory)}</title>
<style>:root{color-scheme:light dark}body{font:14px ui-monospace,Menlo,monospace;margin:2rem}h1{font-size:1rem;font-weight:600;margin:0 0 1rem}ul{list-style:none;padding:0}li{padding:2px 0}a{text-decoration:none}a:hover{text-decoration:underline}</style>
<h1>Index of ${escapeHtml(directory)}</h1><ul>${up}${rows.join("")}</ul>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function isDirectory(parent: string, entry: fs.Dirent): boolean {
  if (!entry.isSymbolicLink()) return entry.isDirectory();
  try {
    return fs.statSync(path.join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );
}

function downloadPath(filename: string): string {
  const dir = app.getPath("downloads");
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? filename : `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

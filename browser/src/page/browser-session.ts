import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, net, session } from "electron";
import type { Session, WebContents } from "electron";

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
const clipboardReaders = new WeakSet<WebContents>();

const SELECT_PICKER_PRELOAD = `const { webFrame } = require("electron");
webFrame.insertCSS("select, ::picker(select) { appearance: base-select !important }", {
  cssOrigin: "user",
});
`;

let selectPreloadFile: string | null = null;
function selectPreloadPath(): string {
  if (!selectPreloadFile) {
    selectPreloadFile = path.join(app.getPath("userData"), "terminal-browser-select-preload.js");
    fs.writeFileSync(selectPreloadFile, SELECT_PICKER_PRELOAD);
  }
  return selectPreloadFile;
}

export function allowClipboardRead(contents: WebContents): void {
  clipboardReaders.add(contents);
}

function granted(contents: WebContents | null, permission: string): boolean {
  if (GRANTED.has(permission)) return true;
  return (
    permission === "clipboard-read" && contents !== null && clipboardReaders.has(contents)
  );
}

export function configureBrowserSession(
  partition: string | null,
  onDownload: (progress: DownloadProgress) => void,
): Session {
  const target = browserSession(partition);
  if (configured.has(target)) return target;
  configured.add(target);

  target.registerPreloadScript({ type: "frame", filePath: selectPreloadPath() });

  target.setPermissionRequestHandler((contents, permission, callback) => {
    callback(granted(contents, permission));
  });
  target.setPermissionCheckHandler((contents, permission) => granted(contents, permission));

  target.webRequest.onBeforeRequest({ urls: ["file://*", "file://*/*"] }, (details, callback) => {
    callback({ cancel: details.resourceType === "xhr" });
  });

  target.protocol.handle("file", async (request) => {
    const directory = requestedDirectory(request.url);
    if (directory) return directoryListing(directory);
    const range = request.headers.get("range");
    const ranged = range ? rangeResponse(request.url, range) : null;
    return ranged ?? net.fetch(request, { bypassCustomProtocolHandlers: true });
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

const socksProxied = new WeakSet<Session>();
let webrtcGuardInstalled = false;

export async function routeThroughSocksProxy(
  partition: string | null,
  port: number,
): Promise<void> {
  const target = browserSession(partition);
  socksProxied.add(target);
  if (!webrtcGuardInstalled) {
    webrtcGuardInstalled = true;
    app.on("web-contents-created", (_event, contents) => {
      if (socksProxied.has(contents.session)) {
        contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      }
    });
  }
  await target.setProxy({
    proxyRules: `socks5://127.0.0.1:${port}`,
    proxyBypassRules: "<-loopback>",
  });
}

export async function clearSiteData(partition: string | null, origin?: string): Promise<void> {
  await browserSession(partition).clearData(origin ? { origins: [origin] } : {});
}

export function browserSession(partition: string | null): Session {
  return partition ? session.fromPartition(persistentPartition(partition)) : session.defaultSession;
}

export function persistentPartition(partition: string): string {
  return partition.startsWith("persist:") ? partition : `persist:${partition}`;
}

function rangeResponse(url: string, range: string): Response | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let file: string;
  let size: number;
  try {
    file = fileURLToPath(new URL(url).href.split(/[?#]/)[0]);
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    size = stat.size;
  } catch {
    return null;
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${size}` },
    });
  }
  const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
    },
  });
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

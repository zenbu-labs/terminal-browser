import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, net, session, systemPreferences } from "electron";
import type { Session, WebContents } from "electron";

export interface DownloadProgress {
  name: string;
  savePath: string;
  received: number;
  total: number;
  state: "progressing" | "done" | "failed";
}

const userGrantedMedia = new Set<string>();
const userDeniedMedia = new Set<string>();
const userRequestedMediaOrigins = new Set<string>();

export function clearMediaPermissionsForOrigin(origin: string): void {
  userGrantedMedia.delete(`${origin}:microphone`);
  userGrantedMedia.delete(`${origin}:camera`);
  userDeniedMedia.delete(`${origin}:microphone`);
  userDeniedMedia.delete(`${origin}:camera`);
}

export function setMediaPermissionForOrigin(origin: string, capability: "microphone" | "camera", granted: boolean): void {
  const key = `${origin}:${capability}`;
  if (granted) {
    userGrantedMedia.add(key);
    userDeniedMedia.delete(key);
  } else {
    userDeniedMedia.add(key);
    userGrantedMedia.delete(key);
  }
}

export function hasMediaPermissionRequested(origin: string): boolean {
  return (
    userRequestedMediaOrigins.has(origin) ||
    userGrantedMedia.has(`${origin}:microphone`) ||
    userGrantedMedia.has(`${origin}:camera`) ||
    userDeniedMedia.has(`${origin}:microphone`) ||
    userDeniedMedia.has(`${origin}:camera`)
  );
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

function promptTerminalPermission(
  contents: WebContents,
  permission: "microphone" | "camera",
  requestingUrl: string | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    app.emit("terminal-browser:permission-request", contents, permission, requestingUrl, (allow: boolean) => {
      resolve(allow);
    });
  });
}

export function configureBrowserSession(
  partition: string | null,
  onDownload: (progress: DownloadProgress) => void,
): Session {
  const target = browserSession(partition);
  if (configured.has(target)) return target;
  configured.add(target);

  target.registerPreloadScript({ type: "frame", filePath: selectPreloadPath() });

  const cleanUserAgent = target.getUserAgent()
    .replace(/terminal-browser\/[0-9\.]+\s?/g, "")
    .replace(/Electron\/[0-9\.]+\s?/g, "")
    .trim();
  target.setUserAgent(cleanUserAgent);

  target.setDevicePermissionHandler(() => true);

  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl;
    const origin = requestingUrl ? new URL(requestingUrl).origin : null;

    if (!origin) {
      callback(granted(contents, permission));
      return;
    }

    const permStr = permission as string;
    if (
      permission === "media" ||
      permStr === "camera" ||
      permStr === "microphone" ||
      permStr === "audio-capture" ||
      permStr === "video-capture"
    ) {
      if (origin) userRequestedMediaOrigins.add(origin);
      const rawTypes = (details as any)?.mediaTypes;
      const singleType = (details as any)?.mediaType;
      const mediaTypes: string[] = Array.isArray(rawTypes)
        ? rawTypes
        : typeof singleType === "string"
        ? [singleType]
        : [];
      const needsCamera =
        permStr === "camera" ||
        permStr === "video-capture" ||
        (permission === "media" && (mediaTypes.length === 0 || mediaTypes.includes("video")));
      const needsMic =
        permStr === "microphone" ||
        permStr === "audio-capture" ||
        (permission === "media" && (mediaTypes.length === 0 || mediaTypes.includes("audio")));

      const isDarwin = process.platform === "darwin";

      const handleMedia = async () => {
        if (isDarwin) {
          if (needsCamera) {
            const status = systemPreferences.getMediaAccessStatus("camera");
            if (status === "not-determined") {
              await systemPreferences.askForMediaAccess("camera");
            }
          }
          if (needsMic) {
            const status = systemPreferences.getMediaAccessStatus("microphone");
            if (status === "not-determined") {
              await systemPreferences.askForMediaAccess("microphone");
            }
          }
        }

        if (needsMic) {
          const micKey = `${origin}:microphone`;
          if (userDeniedMedia.has(micKey)) {
            callback(false);
            return;
          }
          if (!userGrantedMedia.has(micKey)) {
            const allowMic = await promptTerminalPermission(contents, "microphone", requestingUrl);
            if (allowMic) {
              userGrantedMedia.add(micKey);
              userDeniedMedia.delete(micKey);
            } else {
              userDeniedMedia.add(micKey);
              userGrantedMedia.delete(micKey);
              callback(false);
              return;
            }
          }
        }

        if (needsCamera) {
          const camKey = `${origin}:camera`;
          if (userDeniedMedia.has(camKey)) {
            callback(false);
            return;
          }
          if (!userGrantedMedia.has(camKey)) {
            const allowCam = await promptTerminalPermission(contents, "camera", requestingUrl);
            if (allowCam) {
              userGrantedMedia.add(camKey);
              userDeniedMedia.delete(camKey);
            } else {
              userDeniedMedia.add(camKey);
              userGrantedMedia.delete(camKey);
              callback(false);
              return;
            }
          }
        }

        callback(true);
      };

      handleMedia().catch(() => callback(false));
      return;
    }

    callback(granted(contents, permission));
  });

  target.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const requestingUrl = (details as any)?.requestingUrl;
    const origin = requestingUrl ? new URL(requestingUrl).origin : null;

    const permStr = permission as string;
    if (
      origin &&
      (permission === "media" ||
        permStr === "camera" ||
        permStr === "microphone" ||
        permStr === "audio-capture" ||
        permStr === "video-capture")
    ) {
      const rawTypes = (details as any)?.mediaTypes;
      const singleType = (details as any)?.mediaType;
      const mediaTypes: string[] = Array.isArray(rawTypes)
        ? rawTypes
        : typeof singleType === "string"
        ? [singleType]
        : [];
      const checkCamera =
        permStr === "camera" ||
        permStr === "video-capture" ||
        (permission === "media" && (mediaTypes.length === 0 || mediaTypes.includes("video")));
      const checkMic =
        permStr === "microphone" ||
        permStr === "audio-capture" ||
        (permission === "media" && (mediaTypes.length === 0 || mediaTypes.includes("audio")));

      if (checkMic && userDeniedMedia.has(`${origin}:microphone`)) return false;
      if (checkCamera && userDeniedMedia.has(`${origin}:camera`)) return false;

      return true;
    }
    return granted(contents, permission);
  });

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

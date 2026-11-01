import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { app, nativeImage, net } from "electron";
import type { Session } from "electron";

const RASTER_URL = /\.(png|jpe?g|webp|gif)(\?|$)/i;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const ICON_TIMEOUT_MS = 10_000;
// Chromium's net::URLRequest::kMaxRedirects.
const MAX_REDIRECTS = 20;

function isIco(data: Buffer): boolean {
  return data.length > 4 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0;
}

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// Chrome loads a page's icon as an image the page itself requests, so a page can name web and data: icons, and an
// extension page its own files, but never local files, the browser's own pages or another extension's files.
export function iconAllowed(url: string, pageOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "data:") return true;
  return parsed.protocol === "chrome-extension:" && `chrome-extension://${parsed.host}` === pageOrigin;
}

let clears = 0;

export async function clearFavicons(): Promise<void> {
  clears++;
  await fs.promises.rm(path.join(app.getPath("userData"), "favicons"), { recursive: true, force: true });
}

async function readCapped(body: ReadableStream<Uint8Array>): Promise<Buffer | null> {
  const reader = body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    size += value.length;
    if (size > MAX_ICON_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(Buffer.from(value));
  }
}

// Like Chrome's favicon download: a no-cors image load made as the page, so cookies go only to the page's own origin,
// and every redirect has to stay on the web.
function fetchWebIcon(url: string, ses: Session, pageOrigin: string, signal: AbortSignal): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const request = net.request({ session: ses, url, origin: pageOrigin, credentials: "same-origin", redirect: "manual" });
    let redirects = 0;
    let done = false;
    const finish = (data: Buffer | null) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", stop);
      resolve(data);
    };
    const stop = () => {
      request.abort();
      finish(null);
    };
    request.on("redirect", (_status, _method, location) => {
      if (++redirects > MAX_REDIRECTS || !isWebUrl(location)) return stop();
      request.followRedirect();
    });
    request.on("response", (response) => {
      if (response.statusCode < 200 || response.statusCode > 299) return stop();
      const parts: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_ICON_BYTES) return stop();
        parts.push(chunk);
      });
      response.on("end", () => finish(Buffer.concat(parts)));
      response.on("error", () => finish(null));
    });
    request.on("error", () => finish(null));
    request.on("abort", () => finish(null));
    signal.addEventListener("abort", stop);
    request.end();
  });
}

async function fetchIcon(url: string, ses: Session, pageOrigin: string): Promise<Buffer | null> {
  const signal = AbortSignal.timeout(ICON_TIMEOUT_MS);
  if (isWebUrl(url)) return fetchWebIcon(url, ses, pageOrigin, signal);
  if (url.length > MAX_ICON_BYTES * 2) return null;
  const fetchImpl = url.startsWith("data:") ? fetch : ses.fetch.bind(ses);
  const response = await fetchImpl(url, { redirect: "error", signal });
  if (!response.ok || !response.body) return null;
  return readCapped(response.body);
}

export class FaviconCache {
  constructor(private readonly dir: string = path.join(app.getPath("userData"), "favicons")) {}

  async resolve(urls: string[], ses: Session, pageOrigin: string): Promise<string | null> {
    if (urls.length === 0) return null;
    const clearsBefore = clears;
    const candidates = [...urls].sort((a, b) => Number(RASTER_URL.test(b)) - Number(RASTER_URL.test(a)));
    try {
      const fallback = new URL("/favicon.ico", urls[0]).toString();
      if (!candidates.includes(fallback)) candidates.push(fallback);
    } catch {}
    const allowed = candidates.filter((url) => iconAllowed(url, pageOrigin));
    if (allowed.length === 0) return null;
    const stem = path.join(
      this.dir,
      crypto
        .createHash("sha1")
        .update(`${ses.storagePath ?? ""}\0${pageOrigin}\0${clearsBefore}\0${allowed.join("\n")}`)
        .digest("hex")
        .slice(0, 16),
    );
    const cached = [`${stem}.png`, `${stem}.ico`].find((file) => fs.existsSync(file));
    if (cached) return cached;
    for (const url of allowed) {
      const file = await this.fetchDecodable(url, ses, pageOrigin, stem);
      if (file && clears !== clearsBefore) {
        await fs.promises.rm(file, { force: true });
        return null;
      }
      if (file) return file;
    }
    return null;
  }

  private async fetchDecodable(url: string, ses: Session, pageOrigin: string, stem: string): Promise<string | null> {
    try {
      const data = await fetchIcon(url, ses, pageOrigin);
      if (!data || data.length === 0) return null;
      const decoded = nativeImage.createFromBuffer(data);
      if (!decoded.isEmpty()) {
        const file = `${stem}.png`;
        fs.mkdirSync(this.dir, { recursive: true });
        await fs.promises.writeFile(file, decoded.resize({ width: 32, height: 32 }).toPNG());
        return file;
      }
      if (isIco(data)) {
        const file = `${stem}.ico`;
        fs.mkdirSync(this.dir, { recursive: true });
        await fs.promises.writeFile(file, data);
        return file;
      }
      return null;
    } catch {
      return null;
    }
  }
}

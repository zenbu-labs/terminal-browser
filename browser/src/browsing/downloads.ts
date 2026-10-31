import fs from "node:fs";
import path from "node:path";

import { app, session as electronSession, shell } from "electron";
import type { DownloadItem, Session } from "electron";

import { createDownload, deleteDownload, getDownload, interruptStaleDownloads, listDownloads, updateDownload } from "shared";
import type { DownloadRecord } from "shared";

import { Listeners } from "./listeners";

export interface DownloadRequest {
  url: string;
  filename?: string;
  conflictAction?: "uniquify" | "overwrite" | "prompt";
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  extensionId: string | null;
}

interface Control {
  pause(): void;
  resume(): void;
  cancel(): void;
  canResume(): boolean;
}

interface Pending {
  url: string;
  savePath: string | null;
  extensionId: string | null;
  resolve(id: number): void;
}

const PROGRESS_WRITE_MS = 1000;
const START_TIMEOUT_MS = 30_000;

export function downloadsFolder(): string {
  return app.getPath("downloads");
}

function uniquePath(dir: string, filename: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? filename : `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function requestedPath(filename: string, conflictAction: DownloadRequest["conflictAction"]): string {
  const normalized = path.normalize(filename);
  if (path.isAbsolute(filename) || normalized.startsWith("..") || filename.includes("\\") || !path.basename(normalized)) {
    throw new Error("Invalid filename");
  }
  const target = path.join(downloadsFolder(), normalized);
  if (conflictAction === "overwrite") {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return target;
  }
  return uniquePath(path.dirname(target), path.basename(target));
}

export class DownloadManager {
  readonly created = new Listeners<[DownloadRecord]>();
  readonly changed = new Listeners<[DownloadRecord]>();
  readonly erased = new Listeners<[number]>();
  readonly progressed = new Listeners<[]>();
  private readonly live = new Map<number, { record: DownloadRecord; control: Control; writtenAt: number }>();
  private readonly pending: Pending[] = [];
  private readonly attached = new WeakSet<Session>();

  start() {
    interruptStaleDownloads();
    this.attach(electronSession.defaultSession);
    app.on("session-created", (session) => this.attach(session));
  }

  // Runs before the page download toast, so a download an extension asked for
  // keeps the filename it chose.
  private attach(session: Session) {
    if (this.attached.has(session)) return;
    this.attached.add(session);
    session.prependListener("will-download", (_event, item) => this.track(item));
  }

  list(): DownloadRecord[] {
    return listDownloads().map((record) => this.live.get(record.id)?.record ?? record);
  }

  get(id: number): DownloadRecord | null {
    return this.live.get(id)?.record ?? getDownload(id);
  }

  canResume(id: number): boolean {
    return this.live.get(id)?.control.canResume() ?? false;
  }

  async download(request: DownloadRequest): Promise<number> {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      throw new Error("Invalid URL");
    }
    if (!["http:", "https:", "data:", "blob:", "file:"].includes(parsed.protocol)) throw new Error("Invalid URL");
    const savePath = request.filename ? requestedPath(request.filename, request.conflictAction) : null;
    if ((request.method && request.method !== "GET") || request.body !== undefined) {
      return this.fetchDownload(request, savePath ?? uniquePath(downloadsFolder(), path.basename(parsed.pathname) || "download"));
    }
    return new Promise<number>((resolve, reject) => {
      const entry: Pending = { url: parsed.href, savePath, extensionId: request.extensionId, resolve };
      this.pending.push(entry);
      setTimeout(() => {
        const at = this.pending.indexOf(entry);
        if (at < 0) return;
        this.pending.splice(at, 1);
        reject(new Error("Invalid URL"));
      }, START_TIMEOUT_MS);
      electronSession.defaultSession.downloadURL(parsed.href, request.headers ? { headers: request.headers } : undefined);
    });
  }

  pause(id: number) {
    const entry = this.live.get(id);
    if (!entry || entry.record.state !== "in_progress") throw new Error("Download must be in progress");
    entry.control.pause();
    this.update(id, { paused: true });
  }

  resume(id: number) {
    const entry = this.live.get(id);
    if (!entry || !entry.control.canResume()) throw new Error("DownloadItem.canResume must be true");
    entry.control.resume();
    this.update(id, { paused: false, state: "in_progress", error: null });
  }

  cancel(id: number) {
    this.live.get(id)?.control.cancel();
  }

  open(id: number) {
    const record = this.get(id);
    if (!record || record.state !== "complete") throw new Error("Download must be complete");
    void shell.openPath(record.filename);
  }

  show(id: number) {
    const record = this.get(id);
    if (!record) throw new Error("Invalid downloadId");
    if (fs.existsSync(record.filename)) shell.showItemInFolder(record.filename);
    else void shell.openPath(path.dirname(record.filename));
  }

  showDefaultFolder() {
    void shell.openPath(downloadsFolder());
  }

  erase(id: number) {
    const entry = this.live.get(id);
    if (entry) {
      this.live.delete(id);
      entry.control.cancel();
    }
    deleteDownload(id);
    this.erased.emit(id);
    this.progressed.emit();
  }

  removeFile(id: number) {
    const record = this.get(id);
    if (!record || record.state !== "complete") throw new Error("Download must be complete");
    if (!fs.existsSync(record.filename)) throw new Error("Download file already deleted");
    fs.rmSync(record.filename, { force: true });
    this.changed.emit(record);
    this.progressed.emit();
  }

  private track(item: DownloadItem) {
    const url = item.getURLChain()[0] ?? item.getURL();
    const at = this.pending.findIndex((entry) => entry.url === url);
    const request = at >= 0 ? this.pending.splice(at, 1)[0] : null;
    if (request?.savePath) item.setSavePath(request.savePath);
    else if (!item.getSavePath()) item.setSavePath(uniquePath(downloadsFolder(), item.getFilename()));
    const started = item.getStartTime();
    const record = createDownload({
      url,
      finalUrl: item.getURL(),
      filename: item.getSavePath(),
      mime: item.getMimeType(),
      startTime: started > 0 ? Math.round(started * 1000) : Date.now(),
      endTime: null,
      state: "in_progress",
      error: null,
      paused: false,
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      byExtensionId: request?.extensionId ?? null,
    });
    const control: Control = {
      pause: () => item.pause(),
      resume: () => item.resume(),
      cancel: () => item.cancel(),
      canResume: () => item.canResume() && (item.isPaused() || item.getState() === "interrupted"),
    };
    this.live.set(record.id, { record, control, writtenAt: Date.now() });
    this.created.emit(record);
    this.progressed.emit();
    request?.resolve(record.id);
    item.on("updated", (_event, state) => {
      this.update(record.id, {
        state: state === "interrupted" ? "interrupted" : "in_progress",
        error: state === "interrupted" ? "NETWORK_FAILED" : null,
        paused: item.isPaused(),
        finalUrl: item.getURL(),
        filename: item.getSavePath(),
        mime: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
      });
    });
    item.once("done", (_event, state) => {
      const received = item.getReceivedBytes();
      this.update(record.id, {
        state: state === "completed" ? "complete" : "interrupted",
        error: state === "completed" ? null : state === "cancelled" ? "USER_CANCELED" : "NETWORK_FAILED",
        paused: false,
        endTime: Date.now(),
        filename: item.getSavePath(),
        receivedBytes: received,
        totalBytes: state === "completed" ? Math.max(received, item.getTotalBytes()) : item.getTotalBytes(),
      });
      this.live.delete(record.id);
    });
  }

  private async fetchDownload(request: DownloadRequest, savePath: string): Promise<number> {
    const abort = new AbortController();
    const record = createDownload({
      url: request.url,
      finalUrl: request.url,
      filename: savePath,
      mime: "",
      startTime: Date.now(),
      endTime: null,
      state: "in_progress",
      error: null,
      paused: false,
      totalBytes: 0,
      receivedBytes: 0,
      byExtensionId: request.extensionId,
    });
    const control: Control = {
      pause: () => {
        throw new Error("This download can't be paused");
      },
      resume: () => {},
      cancel: () => abort.abort(),
      canResume: () => false,
    };
    this.live.set(record.id, { record, control, writtenAt: Date.now() });
    this.created.emit(record);
    this.progressed.emit();
    void (async () => {
      const file = fs.createWriteStream(savePath);
      try {
        const response = await electronSession.defaultSession.fetch(request.url, {
          method: request.method ?? "GET",
          headers: request.headers,
          body: request.body,
          signal: abort.signal,
        });
        if (!response.ok) throw new Error(`SERVER_BAD_CONTENT`);
        this.update(record.id, {
          finalUrl: response.url || request.url,
          mime: response.headers.get("content-type")?.split(";")[0] ?? "",
          totalBytes: Number(response.headers.get("content-length")) || 0,
        });
        let received = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          received += chunk.byteLength;
          if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
          this.update(record.id, { receivedBytes: received });
        }
        await new Promise<void>((resolve) => file.end(() => resolve()));
        this.update(record.id, { state: "complete", endTime: Date.now(), totalBytes: received, receivedBytes: received });
      } catch (error) {
        file.destroy();
        const reason = abort.signal.aborted ? "USER_CANCELED" : error instanceof Error && error.message === "SERVER_BAD_CONTENT" ? "SERVER_BAD_CONTENT" : "NETWORK_FAILED";
        this.update(record.id, { state: "interrupted", error: reason, endTime: Date.now() });
      } finally {
        this.live.delete(record.id);
      }
    })();
    return record.id;
  }

  private update(id: number, change: Partial<Omit<DownloadRecord, "id">>) {
    const entry = this.live.get(id);
    const previous = entry?.record ?? getDownload(id);
    if (!previous) return;
    const next = { ...previous, ...change };
    const meaningful = (Object.keys(change) as (keyof typeof change)[]).some(
      (key) => key !== "receivedBytes" && change[key] !== previous[key],
    );
    if (entry) entry.record = next;
    const now = Date.now();
    if (meaningful || !entry || now - entry.writtenAt >= PROGRESS_WRITE_MS) {
      updateDownload(id, next);
      if (entry) entry.writtenAt = now;
    }
    if (meaningful) this.changed.emit(next);
    this.progressed.emit();
  }
}

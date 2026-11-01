import fs from "node:fs";
import path from "node:path";

import { app, session as electronSession, shell } from "electron";
import type { DownloadItem, Session } from "electron";

import { createDownload, deleteDownload, getDownload, interruptStaleDownloads, listDownloads, updateDownload } from "shared";
import type { DownloadRecord } from "shared";

import { Listeners } from "./listeners";
import { mimeForFile } from "./mime";

export type ConflictAction = "uniquify" | "overwrite" | "prompt";

export interface FilenameSuggestion {
  filename: string;
  conflictAction: ConflictAction;
}

// Asked once per download before its file name is final; null means nobody
// wants a say, so the download keeps the name it would have had anyway.
export type FilenameDeterminer = (record: DownloadRecord, suggestedPath: string) => Promise<FilenameSuggestion | null> | null;

export interface DownloadRequest {
  url: string;
  filename?: string;
  conflictAction?: ConflictAction;
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
  remainingMs(): number | null;
}

interface Pending {
  url: string;
  creator: FilenameSuggestion | null;
  extensionId: string | null;
  resolve(id: number): void;
}

interface Live {
  record: DownloadRecord;
  control: Control;
  writtenAt: number;
  determined: Promise<void>;
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

export function safeRelativeFilename(filename: string): string | null {
  const unified = filename.replace(/\\/g, "/");
  if (unified.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return unified;
}

// `keep` is the file the download is already writing to, which may itself be the right name.
function targetPath(suggestion: FilenameSuggestion, keep: string | null): string {
  const relative = safeRelativeFilename(suggestion.filename);
  if (!relative) throw new Error("Invalid filename");
  const target = path.join(downloadsFolder(), relative);
  if (target === keep) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (suggestion.conflictAction === "overwrite") return target;
  return uniquePath(path.dirname(target), path.basename(target));
}

function attachmentName(disposition: string | null): string | null {
  if (!disposition) return null;
  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return path.basename(decodeURIComponent(encoded.trim()));
    } catch {}
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
  const name = (plain?.[1] ?? plain?.[2])?.trim();
  return name ? path.basename(name) : null;
}

export class DownloadManager {
  readonly created = new Listeners<[DownloadRecord]>();
  // Every update, including progress that only moved receivedBytes.
  readonly changed = new Listeners<[DownloadRecord]>();
  readonly erased = new Listeners<[number]>();
  readonly progressed = new Listeners<[]>();
  determiner: FilenameDeterminer | null = null;
  private readonly live = new Map<number, Live>();
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
    session.prependListener("will-download", (event, item) => {
      if (event.defaultPrevented) return;
      try {
        this.track(item);
      } catch (error) {
        process.stderr.write(`download tracking failed: ${error instanceof Error ? error.stack : String(error)}\n`);
      }
    });
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

  remainingMs(id: number): number | null {
    return this.live.get(id)?.control.remainingMs() ?? null;
  }

  async download(request: DownloadRequest): Promise<number> {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      throw new Error("Invalid URL");
    }
    if (!["http:", "https:", "data:", "blob:", "file:"].includes(parsed.protocol)) throw new Error("Invalid URL");
    if (request.filename !== undefined && !safeRelativeFilename(request.filename)) throw new Error("Invalid filename");
    const creator: FilenameSuggestion | null = request.filename
      ? { filename: request.filename, conflictAction: request.conflictAction ?? "uniquify" }
      : null;
    if ((request.method && request.method !== "GET") || request.body !== undefined) {
      return this.fetchDownload(request, parsed, creator);
    }
    return new Promise<number>((resolve, reject) => {
      const entry: Pending = { url: parsed.href, creator, extensionId: request.extensionId, resolve };
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
    try {
      fs.unlinkSync(record.filename);
    } catch {
      throw new Error("Unable to remove file");
    }
    this.changed.emit(record);
    this.progressed.emit();
  }

  private track(item: DownloadItem) {
    const url = item.getURLChain()[0] ?? item.getURL();
    const at = this.pending.findIndex((entry) => entry.url === url);
    const request = at >= 0 ? this.pending.splice(at, 1)[0] : null;
    const started = item.getStartTime();
    const record = createDownload({
      url,
      finalUrl: item.getURL(),
      filename: "",
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
      remainingMs: () => {
        const speed = item.getState() === "progressing" && !item.isPaused() ? item.getCurrentBytesPerSecond() : 0;
        const total = item.getTotalBytes();
        if (speed <= 0 || total <= 0) return null;
        return ((total - item.getReceivedBytes()) / speed) * 1000;
      },
    };
    const entry: Live = { record, control, writtenAt: Date.now(), determined: Promise.resolve() };
    this.live.set(record.id, entry);
    this.created.emit(record);
    this.progressed.emit();
    request?.resolve(record.id);

    const fallback = uniquePath(downloadsFolder(), item.getFilename());
    const choose = (suggestion: FilenameSuggestion | null, writingTo: string | null) => {
      try {
        return suggestion ? targetPath(suggestion, writingTo) : fallback;
      } catch {
        return fallback;
      }
    };
    const determination = this.determiner?.({ ...entry.record }, path.join(downloadsFolder(), item.getFilename())) ?? null;
    if (determination) {
      // The name is only known once every extension answered, so the bytes land
      // under the usual name first and move when the download finishes.
      item.setSavePath(fallback);
      entry.determined = determination
        .catch(() => null)
        .then((suggestion) => this.setTarget(record.id, choose(suggestion ?? request?.creator ?? null, fallback)));
    } else {
      const target = choose(request?.creator ?? null, null);
      item.setSavePath(target);
      this.setTarget(record.id, target);
    }

    item.on("updated", (_event, state) => {
      this.update(record.id, {
        state: state === "interrupted" ? "interrupted" : "in_progress",
        error: state === "interrupted" ? "NETWORK_FAILED" : null,
        paused: item.isPaused(),
        finalUrl: item.getURL(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
      });
    });
    item.once("done", (_event, state) => {
      this.finish(record.id, item, state).catch((error) => {
        process.stderr.write(`download finish failed: ${error instanceof Error ? error.stack : String(error)}\n`);
      });
    });
  }

  private setTarget(id: number, target: string) {
    const record = this.get(id);
    if (!record) return;
    this.update(id, { filename: target, mime: mimeForFile(target) ?? record.mime });
  }

  private async finish(id: number, item: DownloadItem, state: "completed" | "cancelled" | "interrupted") {
    const entry = this.live.get(id);
    if (state === "completed" && entry) await entry.determined;
    const written = item.getSavePath();
    let filename = this.get(id)?.filename || written;
    if (state === "completed" && filename !== written) {
      try {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.renameSync(written, filename);
      } catch {
        filename = written;
      }
    }
    const received = item.getReceivedBytes();
    this.update(id, {
      state: state === "completed" ? "complete" : "interrupted",
      error: state === "completed" ? null : state === "cancelled" ? "USER_CANCELED" : "NETWORK_FAILED",
      paused: false,
      endTime: Date.now(),
      filename,
      receivedBytes: received,
      totalBytes: state === "completed" ? Math.max(received, item.getTotalBytes()) : item.getTotalBytes(),
    });
    this.live.delete(id);
  }

  private fetchDownload(request: DownloadRequest, url: URL, creator: FilenameSuggestion | null): number {
    const abort = new AbortController();
    const record = createDownload({
      url: request.url,
      finalUrl: request.url,
      filename: "",
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
      remainingMs: () => null,
    };
    this.live.set(record.id, { record, control, writtenAt: Date.now(), determined: Promise.resolve() });
    this.created.emit(record);
    this.progressed.emit();
    void this.runFetch(record.id, request, url, creator, abort)
      .catch((error) => process.stderr.write(`download failed: ${error instanceof Error ? error.stack : String(error)}\n`))
      .finally(() => this.live.delete(record.id));
    return record.id;
  }

  private async runFetch(id: number, request: DownloadRequest, url: URL, creator: FilenameSuggestion | null, abort: AbortController) {
    let file: fs.WriteStream | null = null;
    let writeError: Error | null = null;
    let failWrite: (error: Error) => void = () => {};
    const failed = new Promise<never>((_resolve, reject) => {
      failWrite = reject;
      abort.signal.addEventListener("abort", () => reject(new Error("USER_CANCELED")), { once: true });
    });
    failed.catch(() => {});
    try {
      const response = await electronSession.defaultSession.fetch(request.url, {
        method: request.method ?? "GET",
        headers: request.headers,
        body: request.body,
        signal: abort.signal,
      });
      if (!response.ok) throw new Error("SERVER_BAD_CONTENT");
      this.update(id, {
        finalUrl: response.url || request.url,
        mime: response.headers.get("content-type")?.split(";")[0] ?? "",
        totalBytes: Number(response.headers.get("content-length")) || 0,
      });
      const name = attachmentName(response.headers.get("content-disposition")) || path.basename(url.pathname) || "download";
      const determination = this.determiner?.({ ...this.get(id)! }, path.join(downloadsFolder(), name)) ?? null;
      const suggestion = determination ? await Promise.race([determination.catch(() => null), failed]) : null;
      const chosen = suggestion ?? creator;
      let target: string;
      try {
        target = chosen ? targetPath(chosen, null) : uniquePath(downloadsFolder(), name);
      } catch {
        target = uniquePath(downloadsFolder(), name);
      }
      this.setTarget(id, target);
      const stream = fs.createWriteStream(target);
      file = stream;
      stream.on("error", (error) => {
        writeError ??= error;
        failWrite(error);
      });
      let received = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (writeError) throw writeError;
        received += chunk.byteLength;
        if (!stream.write(chunk)) await Promise.race([new Promise<void>((resolve) => stream.once("drain", () => resolve())), failed]);
        this.update(id, { receivedBytes: received });
      }
      await Promise.race([new Promise<void>((resolve) => stream.end(() => resolve())), failed]);
      if (writeError) throw writeError;
      this.update(id, { state: "complete", endTime: Date.now(), totalBytes: received, receivedBytes: received });
    } catch (error) {
      file?.destroy();
      const reason = abort.signal.aborted
        ? "USER_CANCELED"
        : writeError
          ? "FILE_FAILED"
          : error instanceof Error && error.message === "SERVER_BAD_CONTENT"
            ? "SERVER_BAD_CONTENT"
            : "NETWORK_FAILED";
      this.update(id, { state: "interrupted", error: reason, endTime: Date.now() });
    }
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
    this.changed.emit(next);
    this.progressed.emit();
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { quarantined, renameBeneath } from "@zenbu-labs/pixel/native";
import { app, session as electronSession, shell } from "electron";
import type { DownloadItem, Session, WebContents } from "electron";

import {
  createDownload,
  deleteDownload,
  firstVisitToOrigin,
  getDownload,
  interruptStaleDownloads,
  listDownloads,
  updateDownload,
} from "shared";
import type { DownloadRecord } from "shared";

import { downloadDangerLevel, opensOnlyAfterPrompt, visitedBeforeToday } from "./download-danger";
import { Listeners } from "./listeners";
import { mimeForFile } from "./mime";
import { downloadReferrer, quarantineDownload } from "./quarantine";
import type { DownloadSource } from "./quarantine";

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
  allowFileAccess: boolean;
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

// How a download started, which decides whether its file type is a danger.
interface Origin extends DownloadSource {
  hasUserGesture: boolean;
  fromAddressBar: boolean;
  contentsId: number | null;
}

interface Live {
  record: DownloadRecord;
  control: Control;
  writtenAt: number;
  determined: Promise<void>;
  origin: Origin;
  // A dangerous download's finished bytes, kept under their unconfirmed name
  // until the user keeps or discards them.
  held: string | null;
  // Written by our own POST request rather than by Chromium.
  fetched: boolean;
  // The chosen name was given up while the user decides; keeping the file
  // picks a free name again.
  nameReleased?: boolean;
}

const PROGRESS_WRITE_MS = 1000;
const EXCLUSIVE_CREATE = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
const START_TIMEOUT_MS = 30_000;

export function downloadsFolder(): string {
  return app.getPath("downloads");
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? filename : `${base} (${i})${ext}`);
    if (!exists(candidate)) return candidate;
  }
}

export function safeRelativeFilename(filename: string): string | null {
  const unified = filename.replace(/\\/g, "/");
  if (unified.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return unified;
}

// A directory under the downloads folder that a relative name leads to. A
// symlink or file anywhere on the way is refused, so no name can lead a
// download out of the folder.
function downloadsDirectory(relativeDir = ""): string {
  let dir = downloadsFolder();
  fs.mkdirSync(dir, { recursive: true });
  for (const part of relativeDir.split("/").filter((piece) => piece && piece !== ".")) {
    if (part === "..") throw new Error("Invalid filename");
    dir = path.join(dir, part);
    if (!exists(dir)) fs.mkdirSync(dir);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid filename");
  }
  return dir;
}

function underDownloads(file: string): string {
  const relative = path.relative(downloadsFolder(), file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid filename");
  return relative.split(path.sep).join("/");
}

// Bytes are written to a file we just created ourselves, and only renamed onto
// the chosen name at the end; a rename replaces a symlink instead of following it.
function reserveIntermediate(): { file: string; fd: number } {
  const dir = downloadsDirectory();
  for (;;) {
    const file = path.join(dir, `Unconfirmed ${crypto.randomInt(1_000_000)}.crdownload`);
    try {
      const fd = fs.openSync(file, EXCLUSIVE_CREATE, 0o600);
      return { file, fd };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

// The rename walks the folders below the downloads folder by handle, so a
// folder swapped for a symlink after the checks can't lead it elsewhere.
function placeFile(written: string, target: string) {
  const relative = underDownloads(target);
  downloadsDirectory(path.posix.dirname(relative));
  renameBeneath(downloadsFolder(), underDownloads(written), relative);
  placeholders.delete(target);
}

const placeholders = new Set<string>();

// Holds a free name with an empty file until the download is renamed onto it,
// so two downloads can't pick the same name.
function reserveUnique(dir: string, filename: string): string {
  for (;;) {
    const candidate = uniquePath(dir, filename);
    try {
      fs.closeSync(fs.openSync(candidate, EXCLUSIVE_CREATE, 0o600));
      placeholders.add(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function removePlaceholder(file: string) {
  if (!placeholders.delete(file)) return;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.size === 0) fs.unlinkSync(file);
  } catch {}
}

function targetPath(suggestion: FilenameSuggestion): string {
  const relative = safeRelativeFilename(suggestion.filename);
  if (!relative) throw new Error("Invalid filename");
  const dir = downloadsDirectory(path.posix.dirname(relative));
  const name = path.posix.basename(relative);
  return suggestion.conflictAction === "overwrite" ? path.join(dir, name) : reserveUnique(dir, name);
}

function tryTargetPath(suggestion: FilenameSuggestion): string | null {
  try {
    return targetPath(suggestion);
  } catch {
    return null;
  }
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

function visitedReferrer(referrer: string): boolean {
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return visitedBeforeToday(firstVisitToOrigin(url.origin));
}

// Chrome checks the download's own referrer, which the frame that started it sent. Electron only reports that
// frame's origin, so the tab's address stands in for it only when the two share an origin.
function initiatorReferrer(page: string, initiator: string, url: string): string {
  if (!initiator) return "";
  let pageOrigin = "";
  try {
    pageOrigin = new URL(page).origin;
  } catch {}
  return downloadReferrer(pageOrigin === initiator ? page : `${initiator}/`, url);
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

  // Whether a download starting at `url` is the navigation the user typed into the address bar of `contents`.
  constructor(private readonly typed: (contents: WebContents, url: string) => boolean = () => false) {}

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
    session.prependListener("will-download", (event, item, contents) => {
      if (event.defaultPrevented) return;
      try {
        this.track(item, contents);
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
    if (parsed.protocol === "file:" && !request.allowFileAccess) return this.refuseDownload(request);
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
    if (entry.held) return;
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
    const entry = this.live.get(id);
    if (!entry?.held) {
      entry?.control.cancel();
      return;
    }
    this.dropHeld(entry);
    this.update(id, { state: "interrupted", error: "USER_CANCELED", endTime: Date.now() });
    this.live.delete(id);
  }

  open(id: number) {
    const record = this.get(id);
    if (!record || record.state !== "complete") throw new Error("Download must be complete");
    void shell.openPath(record.filename);
  }

  // Opening it for an extension needs the user's confirmation every time,
  // even right after a click: a risky type, a file whose danger the user
  // overrode, or a file macOS no longer has quarantined.
  opensOnlyAfterPrompt(id: number): boolean {
    const record = this.get(id);
    if (!record) return true;
    return opensOnlyAfterPrompt(record.filename, record.danger) || quarantined(record.filename) === false;
  }

  // The tab a download started in, while it is running.
  startedIn(id: number): number | null {
    return this.live.get(id)?.origin.contentsId ?? null;
  }

  // DownloadItem::ValidateDangerousDownload: the user keeps a dangerous file,
  // so it gets its real name once all of it is written.
  accept(id: number) {
    const entry = this.live.get(id);
    if (!entry || entry.record.state !== "in_progress") throw new Error("Download must be in progress");
    if (entry.record.danger !== "file") throw new Error("Download must be dangerous");
    this.update(id, { danger: "accepted" });
    if (entry.held) this.complete(id, entry.held);
  }

  // DownloadItem::Remove for a dangerous download: its bytes are deleted and
  // it leaves the list.
  discard(id: number) {
    const entry = this.live.get(id);
    if (!entry || entry.record.state !== "in_progress") throw new Error("Download must be in progress");
    if (entry.record.danger !== "file") throw new Error("Download must be dangerous");
    this.erase(id);
  }

  show(id: number) {
    const record = this.get(id);
    if (!record) throw new Error("Invalid downloadId");
    shell.showItemInFolder(fs.existsSync(record.filename) ? record.filename : path.dirname(record.filename));
  }

  // Only ever reveals: opening a folder launches it when it is an app bundle.
  showDefaultFolder() {
    shell.showItemInFolder(downloadsFolder());
  }

  erase(id: number) {
    const entry = this.live.get(id);
    if (entry) {
      this.live.delete(id);
      if (entry.held) this.dropHeld(entry);
      else entry.control.cancel();
      if (entry.record.state === "in_progress") removePlaceholder(entry.record.filename);
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

  private track(item: DownloadItem, contents: WebContents | undefined) {
    const url = item.getURLChain()[0] ?? item.getURL();
    const at = this.pending.findIndex((entry) => entry.url === url);
    const request = at >= 0 ? this.pending.splice(at, 1)[0] : null;
    const tab = request || !contents || contents.isDestroyed() ? null : contents;
    const initiator = request ? "" : item.getInitiatorOrigin();
    const origin: Origin = request
      ? {
          url: item.getURL(),
          referrer: "",
          initiator: request.extensionId ? `chrome-extension://${request.extensionId}/` : "",
          hasUserGesture: false,
          fromAddressBar: false,
          contentsId: null,
        }
      : {
          url: item.getURL(),
          referrer: initiatorReferrer(tab?.getURL() ?? "", initiator, url),
          initiator,
          hasUserGesture: item.hasUserGesture(),
          fromAddressBar: !!tab && !initiator && this.typed(tab, url),
          contentsId: tab?.id ?? null,
        };
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
      danger: "safe",
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
    const entry: Live = { record, control, writtenAt: Date.now(), determined: Promise.resolve(), origin, held: null, fetched: false };
    this.live.set(record.id, entry);
    this.created.emit(record);
    this.progressed.emit();
    request?.resolve(record.id);

    const intermediate = reserveIntermediate();
    fs.closeSync(intermediate.fd);
    item.setSavePath(intermediate.file);
    const choose = (suggestion: FilenameSuggestion | null) =>
      (suggestion && tryTargetPath(suggestion)) || reserveUnique(downloadsDirectory(), item.getFilename());
    const determination = this.determiner?.({ ...entry.record }, path.join(downloadsFolder(), item.getFilename())) ?? null;
    if (determination) {
      entry.determined = determination
        .catch(() => null)
        .then((suggestion) => this.setTarget(record.id, choose(suggestion ?? request?.creator ?? null)));
    } else {
      this.setTarget(record.id, choose(request?.creator ?? null));
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

  // The target name decides the file type, and with it whether the download
  // is dangerous (DownloadTargetDeterminer::DoCheckVisitedReferrerBefore).
  private setTarget(id: number, target: string) {
    const entry = this.live.get(id);
    const record = this.get(id);
    if (!record) return;
    const dangerous =
      !!entry &&
      record.danger === "safe" &&
      downloadDangerLevel({
        filename: target,
        hasUserGesture: entry.origin.hasUserGesture,
        fromAddressBar: entry.origin.fromAddressBar,
        visitedReferrer: () => visitedReferrer(entry.origin.referrer),
      }) !== "safe";
    this.update(id, { filename: target, mime: mimeForFile(target) ?? record.mime, ...(dangerous ? { danger: "file" as const } : {}) });
    // Like Chrome, nothing carries a dangerous file's name until the user
    // keeps it, not even the empty file that holds the name.
    if (entry && dangerous && placeholders.has(target)) {
      removePlaceholder(target);
      entry.nameReleased = true;
    }
  }

  private async finish(id: number, item: DownloadItem, state: "completed" | "cancelled" | "interrupted") {
    const entry = this.live.get(id);
    if (state === "completed" && entry) await entry.determined;
    const written = item.getSavePath();
    if (state === "completed" && entry) {
      if (!this.annotate(id, entry, written)) return;
      const received = item.getReceivedBytes();
      this.update(id, { receivedBytes: received, totalBytes: Math.max(received, item.getTotalBytes()) });
      if (entry.record.danger === "file") {
        entry.held = written;
        return;
      }
      this.complete(id, written);
      return;
    }
    const filename = this.get(id)?.filename || written;
    if (state === "cancelled") removePlaceholder(filename);
    this.update(id, {
      state: "interrupted",
      error: state === "cancelled" ? "USER_CANCELED" : "NETWORK_FAILED",
      paused: false,
      endTime: Date.now(),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
    });
    this.live.delete(id);
  }

  // Marks the finished bytes with where they came from before they get a name
  // anything can open. On macOS a file that can't be quarantined is not kept:
  // Chrome's files are quarantined by macOS as they are created, so its own
  // failure to add details still leaves them quarantined; ours would not be.
  private annotate(id: number, entry: Live, written: string): boolean {
    try {
      quarantineDownload(written, entry.origin);
      return true;
    } catch (error) {
      process.stderr.write(`download quarantine failed: ${error instanceof Error ? error.message : String(error)}\n`);
      if (process.platform !== "darwin") return true;
    }
    fs.rmSync(written, { force: true });
    removePlaceholder(entry.record.filename);
    this.update(id, { state: "interrupted", error: "FILE_SECURITY_CHECK_FAILED", paused: false, endTime: Date.now() });
    this.live.delete(id);
    return false;
  }

  // Gives the written bytes their chosen name and finishes the download. If the
  // name can't be taken, a page download keeps the name it was written under
  // and a POST download fails.
  private complete(id: number, written: string) {
    const entry = this.live.get(id);
    let filename = entry?.record.filename || written;
    if (entry?.nameReleased && filename !== written) {
      try {
        filename = reserveUnique(path.dirname(filename), path.basename(filename));
      } catch {
        filename = written;
      }
    }
    if (filename !== written) {
      try {
        placeFile(written, filename);
      } catch {
        if (entry?.fetched) {
          fs.rmSync(written, { force: true });
          removePlaceholder(filename);
          this.update(id, { state: "interrupted", error: "FILE_FAILED", endTime: Date.now() });
          this.live.delete(id);
          return;
        }
        filename = written;
      }
    }
    this.update(id, { state: "complete", error: null, paused: false, endTime: Date.now(), filename });
    this.live.delete(id);
  }

  private dropHeld(entry: Live) {
    if (entry.held) fs.rmSync(entry.held, { force: true });
    entry.held = null;
    removePlaceholder(entry.record.filename);
  }

  // Chrome starts the download and interrupts it at once when the caller may
  // not request the URL, without reading anything.
  private refuseDownload(request: DownloadRequest): number {
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
      danger: "safe",
    });
    this.created.emit(record);
    this.progressed.emit();
    setImmediate(() => this.update(record.id, { state: "interrupted", error: "NETWORK_INVALID_REQUEST", endTime: Date.now() }));
    return record.id;
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
      danger: "safe",
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
    const origin: Origin = {
      url: request.url,
      referrer: "",
      initiator: request.extensionId ? `chrome-extension://${request.extensionId}/` : "",
      hasUserGesture: false,
      fromAddressBar: false,
      contentsId: null,
    };
    this.live.set(record.id, { record, control, writtenAt: Date.now(), determined: Promise.resolve(), origin, held: null, fetched: true });
    this.created.emit(record);
    this.progressed.emit();
    void this.runFetch(record.id, request, url, creator, abort)
      .catch((error) => process.stderr.write(`download failed: ${error instanceof Error ? error.stack : String(error)}\n`))
      .finally(() => {
        if (!this.live.get(record.id)?.held) this.live.delete(record.id);
      });
    return record.id;
  }

  private async runFetch(id: number, request: DownloadRequest, url: URL, creator: FilenameSuggestion | null, abort: AbortController) {
    let file: fs.WriteStream | null = null;
    let target: string | null = null;
    let intermediate: string | null = null;
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
      let reserved: { file: string; fd: number };
      try {
        target = (chosen && tryTargetPath(chosen)) || reserveUnique(downloadsDirectory(), name);
        reserved = reserveIntermediate();
      } catch (error) {
        writeError = error as Error;
        throw error;
      }
      this.setTarget(id, target);
      intermediate = reserved.file;
      const stream = fs.createWriteStream("", { fd: reserved.fd });
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
      const entry = this.live.get(id);
      if (!entry) throw new Error("USER_CANCELED");
      entry.origin.url = response.url || request.url;
      const written = intermediate;
      intermediate = null;
      target = null;
      if (!this.annotate(id, entry, written)) return;
      this.update(id, { totalBytes: received, receivedBytes: received });
      if (entry.record.danger === "file") {
        entry.held = written;
        return;
      }
      this.complete(id, written);
    } catch (error) {
      file?.destroy();
      if (intermediate) fs.rmSync(intermediate, { force: true });
      if (target) removePlaceholder(target);
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

import fs from "node:fs";
import path from "node:path";

import { app, session as electronSession, shell } from "electron";
import type { DownloadItem, Session } from "electron";

import { createDownload, deleteDownload, getDownload, interruptStaleDownloads, listDownloads, updateDownload } from "shared";
import type { DownloadRecord } from "shared";

import { Listeners } from "./listeners";

interface Control {
  pause(): void;
  resume(): void;
  cancel(): void;
  canResume(): boolean;
}

const PROGRESS_WRITE_MS = 1000;

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

export class DownloadManager {
  readonly progressed = new Listeners<[]>();
  private readonly live = new Map<number, { record: DownloadRecord; control: Control; writtenAt: number }>();
  private readonly attached = new WeakSet<Session>();

  start() {
    interruptStaleDownloads();
    this.attach(electronSession.defaultSession);
    app.on("session-created", (session) => this.attach(session));
  }

  // Runs before the page download toast, so the toast shows the path we chose.
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

  erase(id: number) {
    const entry = this.live.get(id);
    if (entry) {
      this.live.delete(id);
      entry.control.cancel();
    }
    deleteDownload(id);
    this.progressed.emit();
  }

  private track(item: DownloadItem) {
    const url = item.getURLChain()[0] ?? item.getURL();
    if (!item.getSavePath()) item.setSavePath(uniquePath(downloadsFolder(), item.getFilename()));
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
    });
    const control: Control = {
      pause: () => item.pause(),
      resume: () => item.resume(),
      cancel: () => item.cancel(),
      canResume: () => item.canResume() && (item.isPaused() || item.getState() === "interrupted"),
    };
    this.live.set(record.id, { record, control, writtenAt: Date.now() });
    this.progressed.emit();
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
    this.progressed.emit();
  }
}

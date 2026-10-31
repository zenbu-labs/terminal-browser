import fs from "node:fs";
import path from "node:path";

import { app } from "electron";
import type { WebContents } from "electron";

import { listExtensions } from "shared";

import { extensionIdFromUrl } from "./ids";
import type { ExtensionService } from "./service";

const RELOAD_DEBOUNCE_MS = 300;
const MAX_ERRORS = 50;

interface Watch {
  dir: string;
  watcher: fs.FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

function ignored(file: string | null): boolean {
  if (!file) return false;
  // Chromium itself writes indexed rulesets into _metadata on every load
  return file.split(/[\\/]/).some((part) => part.startsWith(".") || part === "node_modules" || part === "_metadata");
}

// Makes working on an unpacked extension quick: it reloads when its files
// change, and errors from its pages and service worker are kept for
// terminal-browser://extensions and `terminal-browser extensions list`.
export class DevReloader {
  private readonly watches = new Map<string, Watch>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly service: ExtensionService) {
    service.onChange(() => this.sync());
    this.sync();
    service.session.serviceWorkers.on("console-message", (_event, details) => {
      if (details.level < 3) return;
      const id = extensionIdFromUrl(details.sourceUrl) ?? this.workerExtension(details.versionId);
      if (id) this.addError(id, `${details.message} (${details.sourceUrl}:${details.lineNumber})`);
    });
    app.on("web-contents-created", (_event, contents) => this.watchContents(contents));
  }

  private workerExtension(versionId: number): string | null {
    try {
      return extensionIdFromUrl(this.service.session.serviceWorkers.getInfoFromVersionID(versionId).scope);
    } catch {
      return null;
    }
  }

  private watchContents(contents: WebContents) {
    if (contents.session !== this.service.session) return;
    contents.on("console-message", (event) => {
      if (event.level !== "error") return;
      const id = extensionIdFromUrl(event.frame?.url ?? contents.getURL());
      if (id) this.addError(id, `${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
  }

  addError(id: string, message: string) {
    if (!this.service.loaded.has(id) && !this.service.errors.has(id)) return;
    const errors = this.service.errors.get(id) ?? [];
    if (errors[errors.length - 1] === message) return;
    errors.push(message);
    this.service.errors.set(id, errors.slice(-MAX_ERRORS));
    this.changeSoon();
  }

  private changeSoon() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.service.changed();
    }, 200);
  }

  private sync() {
    const wanted = new Map(
      listExtensions()
        .filter((record) => record.source === "unpacked" && record.enabled)
        .map((record) => [record.id, record.path]),
    );
    for (const [id, watch] of [...this.watches]) {
      if (wanted.get(id) === watch.dir) continue;
      this.stop(id);
    }
    for (const [id, dir] of wanted) {
      if (!this.watches.has(id)) this.start(id, dir);
    }
  }

  private start(id: string, dir: string) {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { recursive: true, persistent: false }, (_kind, file) => {
        if (ignored(file ? String(file) : null)) return;
        this.schedule(id);
      });
    } catch {
      return;
    }
    watcher.on("error", () => this.stop(id));
    this.watches.set(id, { dir: path.resolve(dir), watcher, timer: null });
  }

  private stop(id: string) {
    const watch = this.watches.get(id);
    if (!watch) return;
    if (watch.timer) clearTimeout(watch.timer);
    watch.watcher.close();
    this.watches.delete(id);
  }

  private schedule(id: string) {
    const watch = this.watches.get(id);
    if (!watch) return;
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      watch.timer = null;
      void this.service.manager.reload(id).catch(() => this.changeSoon());
    }, RELOAD_DEBOUNCE_MS);
  }
}

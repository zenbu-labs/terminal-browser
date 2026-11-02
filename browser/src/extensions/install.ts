import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  downloadStoreUpdates,
  fetchStorePackage,
  getExtension,
  installWarnings,
  isExtensionId,
  listExtensions,
  pickIcon,
  readCrxFile,
  readZipFile,
  recordForPackage,
  removeOtherVersions,
  restoreExtension,
  saveExtension,
  unpackPackage,
  updateExtension,
} from "shared";
import type { DisabledReason, ExtensionPackage, ExtensionRecord, Manifest, UpdateResult } from "shared";

import type { ExtensionService } from "./service";
import type { ExtensionWindow } from "./window";

export interface InstallResult {
  id: string;
  name: string;
  version: string;
}

export class AlreadyInstalledError extends Error {
  constructor(readonly id: string) {
    super(`${id} is already installed`);
  }
}

export class InstallInProgressError extends Error {
  constructor(readonly id: string) {
    super(`${id} is already being installed`);
  }
}

const UPDATE_INTERVAL_MS = 5 * 60 * 60 * 1000;
const FIRST_UPDATE_DELAY_MS = 60 * 1000;

// Installs and updates extensions from the Chrome Web Store and from .crx files.
// Nothing is unpacked or loaded until the user accepts our install prompt.
export class Installer {
  private readonly installing = new Set<string>();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly service: ExtensionService) {}

  async installFromStore(id: string, window: ExtensionWindow | null): Promise<InstallResult | null> {
    const pkg = await this.prepareFromStore(id, window);
    return pkg ? this.commit(pkg) : null;
  }

  // Downloads, verifies and asks; returns the package only if the user accepted.
  async prepareFromStore(id: string, window: ExtensionWindow | null): Promise<ExtensionPackage | null> {
    if (!isExtensionId(id)) throw new Error(`${id} is not an extension id`);
    if (getExtension(id)) throw new AlreadyInstalledError(id);
    return this.guard(id, async () => {
      const pkg = await fetchStorePackage(id, process.versions.chrome);
      return (await this.ask(pkg, window)) ? pkg : null;
    });
  }

  async installCrxFile(file: string, window: ExtensionWindow | null): Promise<InstallResult | null> {
    const pkg = readCrxFile(file);
    return this.guard(pkg.id, async () => ((await this.ask(pkg, window)) ? this.commit(pkg) : null));
  }

  async commit(pkg: ExtensionPackage, disabledReason: DisabledReason | null = null): Promise<InstallResult> {
    const previous = getExtension(pkg.id);
    const dir = unpackPackage(pkg);
    const record = recordForPackage(pkg, dir, disabledReason ? { enabled: false, disabledReason } : {});
    saveExtension(record);
    if (!disabledReason) {
      try {
        await this.service.manager.start(record, previous ? "update" : "install", previous?.version);
      } catch (error) {
        await this.restore(pkg.id, previous, dir);
        throw error;
      }
    } else {
      this.service.changed();
    }
    removeOtherVersions(pkg.id, dir);
    return { id: pkg.id, name: pkg.name, version: pkg.version };
  }

  // Installs without asking, for packages the user already accepted somewhere else.
  async installPrepared(pkg: ExtensionPackage, disabledReason: DisabledReason | null): Promise<InstallResult> {
    if (getExtension(pkg.id)) throw new AlreadyInstalledError(pkg.id);
    return this.guard(pkg.id, () => this.commit(pkg, disabledReason));
  }

  // Asks before turning on an extension that wants more than the user accepted.
  async approveNewPermissions(id: string, window: ExtensionWindow | null): Promise<boolean> {
    const record = getExtension(id);
    const target = window ?? this.service.lastFocusedWindow();
    if (!record || record.disabledReason !== "permissions_increase" || !target) return false;
    const manifest = readManifest(record.path);
    const accepted = await target.host.prompt({
      kind: "update",
      extensionId: record.id,
      name: record.name,
      icon: manifest ? iconFile(record.path, manifest) : null,
      warnings: manifest ? installWarnings(manifest) : [],
    });
    if (!accepted || getExtension(id)?.disabledReason !== "permissions_increase") return false;
    await this.acceptNewPermissions(id);
    return true;
  }

  private async guard<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.installing.has(id)) throw new InstallInProgressError(id);
    this.installing.add(id);
    try {
      return await run();
    } finally {
      this.installing.delete(id);
    }
  }

  isInstalling(id: string): boolean {
    return this.installing.has(id);
  }

  private async ask(pkg: ExtensionPackage, window: ExtensionWindow | null): Promise<boolean> {
    const target = window ?? this.service.lastFocusedWindow();
    if (!target) return false;
    const icon = packageIcon(pkg);
    try {
      return await target.host.prompt({
        kind: "install",
        extensionId: pkg.id,
        name: pkg.name,
        icon: icon?.file ?? null,
        warnings: installWarnings(pkg.manifest),
      });
    } finally {
      icon?.dispose();
    }
  }

  async checkForUpdates(id?: string): Promise<InstallResult[]> {
    const results = await this.update(id);
    return results
      .filter((result) => result.status === "updated")
      .map((result) => ({ id: result.id, name: result.name, version: result.version }));
  }

  async update(id?: string, prompt = true): Promise<UpdateResult[]> {
    const records = listExtensions().filter((record) => id === undefined || record.id === id);
    const results = await downloadStoreUpdates(records, process.versions.chrome);
    for (const result of results) {
      const previous = records.find((record) => record.id === result.id) ?? null;
      if (result.status === "updated" && result.record) {
        const error = await this.applyUpdate(result.record, previous);
        if (error) Object.assign(result, { status: "failed", record: null, error });
      } else if (result.status === "needs_permission" && result.record) {
        await this.service.unload(result.id);
        this.service.changed();
        if (prompt && previous?.enabled) void this.askForNewPermissions(result, previous);
      }
    }
    return results;
  }

  // Re-enables an extension that an update left disabled for asking for more.
  async acceptNewPermissions(id: string) {
    await this.service.manager.setEnabled(id, true);
    const record = getExtension(id);
    if (record) removeOtherVersions(id, record.path);
  }

  // Returns why the new version failed to load, after putting the previous one back.
  private async applyUpdate(record: ExtensionRecord, previous: ExtensionRecord | null): Promise<string | null> {
    if (record.enabled) {
      try {
        await this.service.manager.start(record, "update", previous?.version);
      } catch (error) {
        await this.restore(record.id, previous, record.path);
        return error instanceof Error ? error.message : String(error);
      }
    }
    removeOtherVersions(record.id, record.path);
    return null;
  }

  private async restore(id: string, previous: ExtensionRecord | null, failedDir: string) {
    restoreExtension(id, previous, failedDir);
    if (previous?.enabled) await this.service.load(previous).catch(() => null);
    this.service.changed();
  }

  private async askForNewPermissions(result: UpdateResult, previous: ExtensionRecord) {
    const record = result.record!;
    const window = this.service.lastFocusedWindow();
    if (!window) return;
    const manifest = readManifest(record.path);
    const accepted = await window.host.prompt({
      kind: "update",
      extensionId: record.id,
      name: record.name,
      icon: manifest ? iconFile(record.path, manifest) : null,
      warnings: manifest ? installWarnings(manifest) : [],
    });
    if (!accepted || getExtension(record.id)?.disabledReason !== "permissions_increase") return;
    const enabled = updateExtension(record.id, { enabled: true, disabledReason: null });
    if (enabled) await this.applyUpdate(enabled, previous);
  }

  // Checks at startup (once the last check is old enough) and then every 5 hours.
  startPeriodicChecks() {
    if (this.updateTimer) return;
    const lastCheck = Math.min(
      ...listExtensions()
        .filter((record) => record.source === "webstore")
        .map((record) => record.lastUpdateCheck ?? 0),
    );
    const due = Number.isFinite(lastCheck) ? lastCheck + UPDATE_INTERVAL_MS - Date.now() : UPDATE_INTERVAL_MS;
    const schedule = (delay: number) => {
      this.updateTimer = setTimeout(() => {
        void this.checkForUpdates()
          .catch(() => [])
          .finally(() => schedule(UPDATE_INTERVAL_MS));
      }, delay);
      this.updateTimer.unref?.();
    };
    schedule(Math.max(FIRST_UPDATE_DELAY_MS, due));
  }
}

function readManifest(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function manifestIcon(manifest: Record<string, unknown>): string | null {
  return pickIcon((manifest as unknown as Manifest).icons, 128)?.replace(/^\//, "") ?? null;
}

function iconFile(dir: string, manifest: Record<string, unknown>): string | null {
  const relative = manifestIcon(manifest);
  if (!relative) return null;
  const file = path.resolve(dir, relative);
  return file.startsWith(`${dir}${path.sep}`) && fs.existsSync(file) ? file : null;
}

// The prompt shows before anything is unpacked, so the icon goes to a fresh
// directory only this user can open, removed once the prompt is answered.
function packageIcon(pkg: ExtensionPackage): { file: string; dispose(): void } | null {
  const relative = manifestIcon(pkg.manifest);
  if (!relative) return null;
  let dir: string | null = null;
  try {
    const bytes = readZipFile(pkg.archive, relative);
    if (!bytes) return null;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-icon-"));
    const ext = path.extname(relative).toLowerCase();
    const file = path.join(dir, `icon${/^\.[a-z0-9]+$/.test(ext) ? ext : ".png"}`);
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    const created = dir;
    return { file, dispose: () => fs.rmSync(created, { recursive: true, force: true }) };
  } catch {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

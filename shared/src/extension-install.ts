import fs from "node:fs";
import path from "node:path";

import { CrxError, checkStoreUpdates, downloadStoreCrx, downloadUpdate, readZipFile, unzipTo, verifyCrx } from "./crx";
import type { VerifyOptions } from "./crx";
import { EXTENSIONS_DIR, getExtension, saveExtension, updateExtension } from "./extensions";
import type { ExtensionRecord, ExtensionSource } from "./extensions";
import { asManifest, permissionWarnings, requiredPermissions } from "./manifest";

// A verified CRX that hasn't been unpacked yet: enough to show the install
// prompt before anything touches the profile.
export interface ExtensionPackage {
  id: string;
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  publicKey: Buffer;
  fromWebStore: boolean;
  archive: Buffer;
}

export class ManifestError extends Error {}

function parseJson(bytes: Buffer, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""));
  } catch (error) {
    throw new ManifestError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManifestError(`${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// Chrome stopped running Manifest V2 extensions, so packaged installs refuse them.
export function checkManifest(manifest: Record<string, unknown>, file = "manifest.json", allowV2 = false): void {
  const version = manifest.manifest_version;
  if (typeof manifest.name !== "string" || !manifest.name) throw new ManifestError(`${file} has no "name"`);
  if (typeof manifest.version !== "string" || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    throw new ManifestError(`${file} has an invalid "version"`);
  }
  if (version === 2 && !allowV2) {
    throw new ManifestError("This extension uses Manifest V2, which Chrome no longer supports");
  }
  if (version !== 3 && version !== 2) {
    throw new ManifestError(`${file} has an unsupported "manifest_version"`);
  }
}

function localized(name: string, manifest: Record<string, unknown>, read: (file: string) => Buffer | null): string {
  const match = /^__MSG_(\w+)__$/.exec(name);
  const locale = typeof manifest.default_locale === "string" ? manifest.default_locale : null;
  if (!match || !locale) return name;
  const bytes = read(`_locales/${locale}/messages.json`);
  if (!bytes) return name;
  try {
    const messages = JSON.parse(bytes.toString("utf8").replace(/^﻿/, "")) as Record<string, { message?: string }>;
    const key = Object.keys(messages).find((candidate) => candidate.toLowerCase() === match[1].toLowerCase());
    return (key && messages[key]?.message) || name;
  } catch {
    return name;
  }
}

export function displayName(manifest: Record<string, unknown>, read: (file: string) => Buffer | null): string {
  return localized(String(manifest.name ?? ""), manifest, read);
}

export function directoryDisplayName(dir: string, manifest: Record<string, unknown>): string {
  return displayName(manifest, (file) => {
    try {
      return fs.readFileSync(path.join(dir, file));
    } catch {
      return null;
    }
  });
}

export function packageFromCrx(bytes: Buffer, options: VerifyOptions = {}): ExtensionPackage {
  const verified = verifyCrx(bytes, options);
  const manifestBytes = readZipFile(verified.archive, "manifest.json");
  if (!manifestBytes) throw new ManifestError("The package has no manifest.json");
  const manifest = parseJson(manifestBytes, "manifest.json");
  checkManifest(manifest);
  return {
    id: verified.id,
    name: displayName(manifest, (file) => readZipFile(verified.archive, file)),
    version: String(manifest.version),
    manifest,
    publicKey: verified.publicKey,
    fromWebStore: verified.fromWebStore,
    archive: verified.archive,
  };
}

export async function fetchStorePackage(id: string, prodversion?: string): Promise<ExtensionPackage> {
  const bytes = await downloadStoreCrx(id, prodversion);
  return packageFromCrx(bytes, { expectedId: id, requireWebStore: true });
}

export function readCrxFile(file: string): ExtensionPackage {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new CrxError("not_found", `Cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  return packageFromCrx(bytes);
}

export function installWarnings(manifest: Record<string, unknown>): string[] {
  return permissionWarnings(requiredPermissions(asManifest(manifest)));
}

// An update needs the user's OK again when it asks for anything new, like Chrome.
export function permissionsIncreased(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const old = requiredPermissions(asManifest(before));
  const next = requiredPermissions(asManifest(after));
  const oldWarnings = new Set(permissionWarnings(old));
  if (permissionWarnings(next).some((warning) => !oldWarnings.has(warning))) return true;
  const oldApis = new Set(old.api);
  const oldHosts = new Set(old.hosts);
  return next.api.some((api) => !oldApis.has(api)) || next.hosts.some((host) => !oldHosts.has(host));
}

export function sourceFor(pkg: ExtensionPackage): ExtensionSource {
  return pkg.fromWebStore ? "webstore" : "crx";
}

// Unpacks into EXTENSIONS_DIR/<id>/<version>_0 like Chrome, and writes the
// developer key into manifest.json so the id stays the same when loaded.
export function unpackPackage(pkg: ExtensionPackage): string {
  const dir = path.join(EXTENSIONS_DIR, pkg.id, `${pkg.version}_0`);
  unzipTo(pkg.archive, dir);
  const file = path.join(dir, "manifest.json");
  const manifest = parseJson(fs.readFileSync(file), "manifest.json");
  manifest.key = pkg.publicKey.toString("base64");
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

export function removeOtherVersions(id: string, keep: string): void {
  const root = path.join(EXTENSIONS_DIR, id);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = path.join(root, entry);
    if (dir !== keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function recordForPackage(pkg: ExtensionPackage, dir: string, change: Partial<ExtensionRecord> = {}): ExtensionRecord {
  const existing = getExtension(pkg.id);
  const now = Date.now();
  return {
    id: pkg.id,
    path: dir,
    version: pkg.version,
    name: pkg.name,
    source: sourceFor(pkg),
    enabled: true,
    disabledReason: null,
    pinned: existing?.pinned ?? true,
    grantedPermissions: existing?.grantedPermissions ?? [],
    grantedOrigins: existing?.grantedOrigins ?? [],
    shortcuts: existing?.shortcuts ?? {},
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    lastUpdateCheck: existing?.lastUpdateCheck ?? null,
    userScriptsAllowed: existing?.userScriptsAllowed ?? false,
    ...change,
  };
}

export function readInstalledManifest(record: Pick<ExtensionRecord, "path">): Record<string, unknown> | null {
  try {
    return parseJson(fs.readFileSync(path.join(record.path, "manifest.json")), "manifest.json");
  } catch {
    return null;
  }
}

export interface UpdateResult {
  id: string;
  name: string;
  previousVersion: string;
  version: string;
  record: ExtensionRecord | null;
  status: "updated" | "needs_permission" | "failed";
  error?: string;
}

// Checks the Web Store for newer versions of the given store extensions and
// unpacks them. The caller loads the new version and removes the old one.
export async function downloadStoreUpdates(records: ExtensionRecord[], prodversion?: string): Promise<UpdateResult[]> {
  const store = records.filter((record) => record.source === "webstore");
  if (store.length === 0) return [];
  const now = Date.now();
  const available = await checkStoreUpdates(
    store.map((record) => ({ id: record.id, version: record.version })),
    prodversion,
  );
  for (const record of store) updateExtension(record.id, { lastUpdateCheck: now, updatedAt: record.updatedAt });
  const results: UpdateResult[] = [];
  for (const update of available) {
    const current = store.find((record) => record.id === update.id)!;
    const base = { id: current.id, name: current.name, previousVersion: current.version, version: update.version };
    try {
      const pkg = packageFromCrx(await downloadUpdate(update), { expectedId: current.id, requireWebStore: true });
      const before = readInstalledManifest(current) ?? {};
      const dir = unpackPackage(pkg);
      const increased = permissionsIncreased(before, pkg.manifest);
      const record = recordForPackage(pkg, dir, {
        enabled: current.enabled && !increased,
        disabledReason: increased ? "permissions_increase" : current.disabledReason,
        lastUpdateCheck: now,
      });
      saveExtension(record);
      results.push({ ...base, version: pkg.version, record, status: increased ? "needs_permission" : "updated" });
    } catch (error) {
      results.push({ ...base, record: null, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

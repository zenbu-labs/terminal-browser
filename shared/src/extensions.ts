import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { store } from "./client";
import { DATA_DIR } from "./paths";

export const EXTENSIONS_DIR = path.join(DATA_DIR, "extensions");

export type ExtensionSource = "webstore" | "unpacked" | "crx";
export type DisabledReason = "user" | "permissions_increase" | "load_error";

export interface ExtensionRecord {
  id: string;
  path: string;
  version: string;
  name: string;
  source: ExtensionSource;
  enabled: boolean;
  disabledReason: DisabledReason | null;
  pinned: boolean;
  grantedPermissions: string[];
  grantedOrigins: string[];
  shortcuts: Record<string, string>;
  installedAt: number;
  updatedAt: number;
  lastUpdateCheck: number | null;
  userScriptsAllowed: boolean;
}

interface ExtensionSqlRow {
  id: string;
  path: string;
  version: string;
  name: string;
  source: ExtensionSource;
  enabled: number;
  disabled_reason: DisabledReason | null;
  pinned: number;
  granted_permissions: string;
  granted_origins: string;
  shortcuts: string;
  installed_at: number;
  updated_at: number;
  last_update_check: number | null;
  user_scripts_allowed: number;
}

function fromRow(row: ExtensionSqlRow): ExtensionRecord {
  return {
    id: row.id,
    path: row.path,
    version: row.version,
    name: row.name,
    source: row.source,
    enabled: row.enabled === 1,
    disabledReason: row.disabled_reason,
    pinned: row.pinned === 1,
    grantedPermissions: JSON.parse(row.granted_permissions) as string[],
    grantedOrigins: JSON.parse(row.granted_origins) as string[],
    shortcuts: JSON.parse(row.shortcuts) as Record<string, string>,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    lastUpdateCheck: row.last_update_check,
    userScriptsAllowed: row.user_scripts_allowed === 1,
  };
}

export function listExtensions(): ExtensionRecord[] {
  const rows = store().sqlite.prepare("SELECT * FROM extensions ORDER BY installed_at").all() as unknown as ExtensionSqlRow[];
  return rows.map(fromRow);
}

export function getExtension(id: string): ExtensionRecord | null {
  const row = store().sqlite.prepare("SELECT * FROM extensions WHERE id = ?").get(id) as unknown as
    | ExtensionSqlRow
    | undefined;
  return row ? fromRow(row) : null;
}

export function saveExtension(record: ExtensionRecord): void {
  store()
    .sqlite.prepare(
      `INSERT INTO extensions (id, path, version, name, source, enabled, disabled_reason, pinned, granted_permissions,
         granted_origins, shortcuts, installed_at, updated_at, last_update_check, user_scripts_allowed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, version = excluded.version, name = excluded.name,
         source = excluded.source, enabled = excluded.enabled, disabled_reason = excluded.disabled_reason,
         pinned = excluded.pinned, granted_permissions = excluded.granted_permissions,
         granted_origins = excluded.granted_origins, shortcuts = excluded.shortcuts,
         updated_at = excluded.updated_at, last_update_check = excluded.last_update_check,
         user_scripts_allowed = excluded.user_scripts_allowed`,
    )
    .run(
      record.id,
      record.path,
      record.version,
      record.name,
      record.source,
      record.enabled ? 1 : 0,
      record.disabledReason,
      record.pinned ? 1 : 0,
      JSON.stringify(record.grantedPermissions),
      JSON.stringify(record.grantedOrigins),
      JSON.stringify(record.shortcuts),
      record.installedAt,
      record.updatedAt,
      record.lastUpdateCheck,
      record.userScriptsAllowed ? 1 : 0,
    );
}

export function updateExtension(id: string, change: Partial<Omit<ExtensionRecord, "id">>): ExtensionRecord | null {
  const current = getExtension(id);
  if (!current) return null;
  const next = { ...current, ...change, id, updatedAt: change.updatedAt ?? Date.now() };
  saveExtension(next);
  return next;
}

export function deleteExtension(id: string): void {
  const { sqlite } = store();
  sqlite.prepare("DELETE FROM extensions WHERE id = ?").run(id);
  sqlite.prepare("DELETE FROM extension_events WHERE extension_id = ?").run(id);
}

export function lazyEvents(id: string): string[] {
  const rows = store().sqlite.prepare("SELECT event FROM extension_events WHERE extension_id = ?").all(id) as {
    event: string;
  }[];
  return rows.map((row) => row.event);
}

export function addLazyEvent(id: string, event: string): void {
  store().sqlite.prepare("INSERT OR IGNORE INTO extension_events (extension_id, event) VALUES (?, ?)").run(id, event);
}

export function removeLazyEvent(id: string, event: string): void {
  store().sqlite.prepare("DELETE FROM extension_events WHERE extension_id = ? AND event = ?").run(id, event);
}

export function clearLazyEvents(id: string): void {
  store().sqlite.prepare("DELETE FROM extension_events WHERE extension_id = ?").run(id);
}

export function opensSidePanelOnActionClick(id: string): boolean {
  const row = store().sqlite.prepare("SELECT open_panel_on_action_click AS value FROM extensions WHERE id = ?").get(id) as
    | { value: number }
    | undefined;
  return row?.value === 1;
}

export function setOpensSidePanelOnActionClick(id: string, open: boolean): void {
  store().sqlite.prepare("UPDATE extensions SET open_panel_on_action_click = ? WHERE id = ?").run(open ? 1 : 0, id);
}

// Chrome derives an extension id from a public key (or, for unpacked
// extensions without a "key", from the absolute path): the first 128 bits of
// the SHA-256 written with the letters a-p instead of hex digits.
export function extensionIdFromBytes(bytes: Buffer | string): string {
  const hex = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

export function extensionIdForDirectory(dir: string, manifest: { key?: unknown }): string {
  if (typeof manifest.key === "string") return extensionIdFromBytes(Buffer.from(manifest.key, "base64"));
  return extensionIdFromBytes(path.resolve(dir));
}

export function readManifestFile(dir: string): Record<string, unknown> {
  const file = path.join(dir, "manifest.json");
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

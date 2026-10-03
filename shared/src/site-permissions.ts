import { store } from "./client";

export interface SitePermission {
  origin: string;
  embedder: string;
  kind: string;
  allowed: boolean;
}

export function listSitePermissions(): SitePermission[] {
  const rows = store()
    .sqlite.prepare("SELECT origin, embedder, kind, allowed FROM site_permissions")
    .all() as { origin: string; embedder: string; kind: string; allowed: number }[];
  return rows.map((row) => ({ ...row, allowed: row.allowed === 1 }));
}

export function setSitePermission(permission: SitePermission): void {
  store()
    .sqlite.prepare(
      "INSERT INTO site_permissions (origin, embedder, kind, allowed, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(origin, embedder, kind) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at",
    )
    .run(permission.origin, permission.embedder, permission.kind, permission.allowed ? 1 : 0, Date.now());
}

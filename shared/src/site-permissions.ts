import { store } from "./client";

export interface SitePermission {
  origin: string;
  embedder: string;
  kind: string;
  allowed: boolean;
}

export function sitePermission(origin: string, embedder: string, kind: string): boolean | null {
  const row = store()
    .sqlite.prepare("SELECT allowed FROM site_permissions WHERE origin = ? AND embedder = ? AND kind = ?")
    .get(origin, embedder, kind) as { allowed: number } | undefined;
  return row ? row.allowed === 1 : null;
}

export function setSitePermission(permission: SitePermission): void {
  store()
    .sqlite.prepare(
      "INSERT INTO site_permissions (origin, embedder, kind, allowed, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(origin, embedder, kind) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at",
    )
    .run(permission.origin, permission.embedder, permission.kind, permission.allowed ? 1 : 0, Date.now());
}

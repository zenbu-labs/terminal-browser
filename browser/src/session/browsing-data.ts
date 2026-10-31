import { clearFavicons } from "@zenbu-labs/pixel";
import { session as electronSession } from "electron";
import type { Session } from "electron";

export const BROWSING_DATA_KINDS = ["siteData", "cache"] as const;

export type BrowsingDataKind = (typeof BROWSING_DATA_KINDS)[number];

export function isBrowsingDataKind(value: unknown): value is BrowsingDataKind {
  return BROWSING_DATA_KINDS.includes(value as BrowsingDataKind);
}

export function browsingSession(partition: string | null): Session {
  if (!partition) return electronSession.defaultSession;
  return electronSession.fromPartition(partition.startsWith("persist:") ? partition : `persist:${partition}`);
}

// one site at a time goes through clearData, the only call that filters by origin
export async function clearBrowsingData(
  session: Session,
  kinds: readonly BrowsingDataKind[],
  origin?: string,
): Promise<void> {
  if (origin) {
    const dataTypes: NonNullable<Electron.ClearDataOptions["dataTypes"]> = [];
    if (kinds.includes("siteData")) {
      dataTypes.push(
        "backgroundFetch",
        "cookies",
        "fileSystems",
        "indexedDB",
        "localStorage",
        "serviceWorkers",
        "webSQL",
      );
    }
    if (kinds.includes("cache")) dataTypes.push("cache");
    await session.clearData({ origins: [origin], dataTypes });
    return;
  }
  if (kinds.includes("siteData")) {
    await session.clearStorageData();
    await session.clearAuthCache();
    await session.cookies.flushStore();
  }
  if (kinds.includes("cache")) {
    await session.clearCache();
    await clearFavicons();
    await session.clearCodeCaches({});
  }
}

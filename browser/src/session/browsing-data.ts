import { clearFavicons } from "@zenbu-labs/pixel";
import { session as electronSession } from "electron";
import type { ClearDataOptions, Session } from "electron";

import { browsing } from "../browsing";
import { clearSessionData } from "../extensions/native";

export const BROWSING_DATA_KINDS = ["history", "siteData", "cache"] as const;

export type BrowsingDataKind = (typeof BROWSING_DATA_KINDS)[number];

export const DEFAULT_CLEAR_KINDS: readonly BrowsingDataKind[] = ["siteData", "cache"];

export function isBrowsingDataKind(value: unknown): value is BrowsingDataKind {
  return BROWSING_DATA_KINDS.includes(value as BrowsingDataKind);
}

export function browsingSession(partition: string | null): Session {
  if (!partition) return electronSession.defaultSession;
  return electronSession.fromPartition(partition.startsWith("persist:") ? partition : `persist:${partition}`);
}

type ElectronDataType = NonNullable<ClearDataOptions["dataTypes"]>[number];

const SITE_DATA_TYPES: ElectronDataType[] = ["cookies", "localStorage", "indexedDB", "serviceWorkers", "fileSystems", "backgroundFetch"];

export async function clearBrowsingData(session: Session, kinds: readonly BrowsingDataKind[], since = 0): Promise<void> {
  if (kinds.includes("history")) {
    if (since > 0) browsing().history.deleteRange(since, Number.MAX_SAFE_INTEGER);
    else browsing().history.deleteAll();
  }
  if (since > 0) {
    const dataTypes: ElectronDataType[] = [
      ...(kinds.includes("siteData") ? SITE_DATA_TYPES : []),
      ...(kinds.includes("cache") ? (["cache"] as const) : []),
    ];
    if (dataTypes.length) await clearSessionData(session, { dataTypes }, since);
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

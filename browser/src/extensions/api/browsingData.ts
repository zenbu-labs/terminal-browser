import type { ClearDataOptions } from "electron";

import { listExtensions } from "shared";

import { browsing } from "../../browsing";
import { clearBrowsingData } from "../../session/browsing-data";
import type { ExtensionService } from "../service";

type DataType = keyof chrome.browsingData.DataTypeSet;
type RemovalOptions = chrome.browsingData.RemovalOptions;

const ELECTRON_TYPES: Partial<Record<DataType, NonNullable<ClearDataOptions["dataTypes"]>[number]>> = {
  cookies: "cookies",
  localStorage: "localStorage",
  indexedDB: "indexedDB",
  serviceWorkers: "serviceWorkers",
  fileSystems: "fileSystems",
  webSQL: "webSQL",
};

const ORIGIN_FILTERABLE = new Set<DataType>(["cache", "cacheStorage", "cookies", "fileSystems", "indexedDB", "localStorage", "serviceWorkers", "webSQL"]);

const SUPPORTED: DataType[] = [
  "cache",
  "cacheStorage",
  "cookies",
  "downloads",
  "fileSystems",
  "history",
  "indexedDB",
  "localStorage",
  "serviceWorkers",
  "webSQL",
];

const SINGLE: Record<string, DataType> = {
  removeAppcache: "appcache",
  removeCache: "cache",
  removeCacheStorage: "cacheStorage",
  removeCookies: "cookies",
  removeDownloads: "downloads",
  removeFileSystems: "fileSystems",
  removeFormData: "formData",
  removeHistory: "history",
  removeIndexedDB: "indexedDB",
  removeLocalStorage: "localStorage",
  removePasswords: "passwords",
  removeServiceWorkers: "serviceWorkers",
  removeWebSQL: "webSQL",
};

export function installBrowsingData(service: ExtensionService) {
  const { router } = service;
  const options = { permission: "browsingData" };

  const remove = async (raw: unknown, dataToRemove: chrome.browsingData.DataTypeSet) => {
    const removal = (raw ?? {}) as RemovalOptions;
    const types = (Object.keys(dataToRemove) as DataType[]).filter((type) => dataToRemove[type]);
    if (removal.origins && removal.excludeOrigins) throw new Error("Origins and excludeOrigins can't be used together.");
    const filtered = removal.origins ?? removal.excludeOrigins;
    if (filtered && types.some((type) => !ORIGIN_FILTERABLE.has(type))) {
      throw new Error("At least one data type doesn't support filtering by origin.");
    }
    const since = removal.since ?? 0;
    const { history, downloads } = browsing();
    if (types.includes("history")) {
      if (since <= 0) history.deleteAll();
      else history.deleteRange(since, Number.MAX_SAFE_INTEGER);
    }
    if (types.includes("downloads")) {
      for (const record of downloads.list()) {
        if (record.state !== "in_progress" && record.startTime >= since) downloads.erase(record.id);
      }
    }
    const session = service.session;
    const dataTypes = types.map((type) => ELECTRON_TYPES[type]).filter((type) => type !== undefined);
    const keepExtensions = !removal.originTypes?.extension;
    const excludeOrigins = [
      ...(removal.excludeOrigins ?? []),
      ...(keepExtensions && !removal.origins ? listExtensions().map((record) => `chrome-extension://${record.id}`) : []),
    ];
    const scope: ClearDataOptions = removal.origins ? { origins: removal.origins } : excludeOrigins.length ? { excludeOrigins } : {};
    if (dataTypes.length) await session.clearData({ ...scope, dataTypes });
    if (types.includes("cacheStorage")) {
      if (removal.origins) {
        for (const origin of removal.origins) await session.clearStorageData({ origin, storages: ["cachestorage"] });
      } else {
        await session.clearStorageData({ storages: ["cachestorage"] });
      }
    }
    if (types.includes("cache")) {
      if (filtered) await session.clearData({ ...scope, dataTypes: ["cache"] });
      else await clearBrowsingData(session, ["cache"]);
    }
  };

  router.handle(
    "browsingData.remove",
    (_caller, removal, dataToRemove) => remove(removal, (dataToRemove ?? {}) as chrome.browsingData.DataTypeSet),
    options,
  );
  for (const [method, type] of Object.entries(SINGLE)) {
    router.handle(`browsingData.${method}`, (_caller, removal) => remove(removal, { [type]: true }), options);
  }

  router.handle(
    "browsingData.settings",
    () => {
      const all = Object.fromEntries(SUPPORTED.map((type) => [type, true]));
      return {
        options: { since: 0, originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false } },
        dataToRemove: all,
        dataRemovalPermitted: all,
      };
    },
    options,
  );
}

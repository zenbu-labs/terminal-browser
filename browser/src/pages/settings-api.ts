import { session as electronSession } from "electron";

import { ConfigStore, isSettingKey, SETTING_KEYS, SETTINGS, SETTINGS_FILE, SHORTCUTS_FILE } from "shared";
import type { SettingKey, Settings } from "shared";

import { browsing } from "../browsing";
import { clearBrowsingData } from "../session/browsing-data";
import type { BrowsingDataKind } from "../session/browsing-data";
import type { InternalHandlers } from "./internal";
import { notifyPages } from "./internal";

const PAGE_DATA_KINDS = ["history", "downloads", "siteData", "cache"] as const;

function store(): ConfigStore {
  return new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE });
}

function settingRows() {
  const loaded = store().load();
  return SETTING_KEYS.map((key) => {
    const def = SETTINGS[key];
    const value = String(loaded.settings?.[key] ?? def.default);
    const choices = def.choices?.map(({ value: choice, name }) => ({ value: choice, name })) ?? [];
    const values = choices.map((choice) => choice.value);
    const toggle = values.length === 2 && values.includes("on") && values.includes("off");
    return {
      key,
      group: def.group,
      label: def.label,
      value,
      kind: toggle ? "toggle" : choices.length ? "choice" : "string",
      inverted: "inverted" in def ? def.inverted === true : false,
      choices,
    };
  });
}

export function watchSettingsForPages(): void {
  store().watch(() => notifyPages("settings"));
}

export function settingsHandlers(): InternalHandlers["settings"] {
  return {
    get: () => settingRows(),
    set: (_sender, key, value) => {
      if (typeof key !== "string" || !isSettingKey(key) || typeof value !== "string") throw new Error("Invalid setting");
      if (!SETTINGS[key].schema.safeParse(value).success) throw new Error("Invalid setting");
      store().setSetting(key, value as Settings[SettingKey]);
      return settingRows();
    },
    reset: (_sender, key) => {
      if (typeof key !== "string" || !isSettingKey(key)) throw new Error("Invalid setting");
      store().setSetting(key, undefined);
      return settingRows();
    },
    clearData: async (_sender, request) => {
      const { kinds, since } = (request ?? {}) as { kinds?: unknown; since?: unknown };
      const chosen = (Array.isArray(kinds) ? kinds : []).filter((kind): kind is (typeof PAGE_DATA_KINDS)[number] =>
        PAGE_DATA_KINDS.includes(kind),
      );
      const start = typeof since === "number" && since > 0 ? since : 0;
      const { history, downloads } = browsing();
      if (chosen.includes("history")) {
        if (start === 0) history.deleteAll();
        else history.deleteRange(start, Number.MAX_SAFE_INTEGER);
      }
      if (chosen.includes("downloads")) {
        for (const record of downloads.list()) {
          if (record.state !== "in_progress" && record.startTime >= start) downloads.erase(record.id);
        }
      }
      const siteKinds = chosen.filter((kind): kind is BrowsingDataKind => kind === "siteData" || kind === "cache");
      if (siteKinds.length) await clearBrowsingData(electronSession.defaultSession, siteKinds);
    },
  };
}

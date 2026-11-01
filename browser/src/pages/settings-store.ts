import { ConfigStore, SETTINGS_FILE, SHORTCUTS_FILE } from "shared";

// The store terminal-browser://settings writes through.
export const pageSettingsStore = new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE });

// True while the settings file holds exactly what the settings page last wrote.
export function settingsWrittenByPage(): boolean {
  return pageSettingsStore.ownContent("settings");
}

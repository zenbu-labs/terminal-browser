export {
  APP_DIR_NAME,
  DATA_DIR,
  LOGS_DIR,
  FAVICONS_DIR,
  INSTANCES_DIR,
  AGENT_SOCKETS_DIR,
  DAEMON_SOCKET,
  DB_FILE,
  KEYBINDINGS_FILE,
  PROFILES_FILE,
  ensureDataDir,
} from "./paths";
export { openStore, store } from "./client";
export type { Store } from "./client";
export { appState, instances, settings } from "./schema";
export type { DevtoolsDock, InstanceRow, NewInstanceRow, SettingsRow } from "./schema";
export { listInstances, removeInstance, upsertInstance } from "./instances";
export { lastUrl, setLastUrl } from "./app-state";
export {
  findProfile,
  effectiveSearchEngine,
  listProfiles,
  profilePreferences,
  profileSettings,
  removeProfile,
  saveProfile,
  setDefaultProfile,
  setDefaultSource,
  setProfileSearchEngine,
} from "./profiles";
export type {
  EffectiveSearchEngine,
  ProfilePreferences,
  ProfileRecord,
  ProfileSettings,
  ProfileSource,
} from "./profiles";
export {
  listSearchEngines,
  renderSearchTemplate,
  searchEngine,
  searchEngineFromTemplate,
} from "./search-engines";
export type { SearchEngineDefinition } from "./search-engines";
export {
  keybindingConflicts,
  keybindingSetting,
  listKeybindings,
  normalizeKeybinding,
  resetKeybinding,
  setKeybinding,
} from "./keybindings";
export type { KeybindingActionId, KeybindingSetting } from "./keybindings";

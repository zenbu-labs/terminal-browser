export {
  APP_DIR_NAME,
  DATA_DIR,
  LOGS_DIR,
  FAVICONS_DIR,
  INSTANCES_DIR,
  AGENT_SOCKETS_DIR,
  DAEMON_SOCKET,
  DB_FILE,
  ensureDataDir,
} from "./paths";
export { openStore, store } from "./client";
export type { Store } from "./client";
export { appState, instances, settings } from "./schema";
export type { DevtoolsDock, InstanceRow, NewInstanceRow, SettingsRow } from "./schema";
export { listInstances, removeInstance, upsertInstance } from "./instances";
export {
  displayPointSize,
  lastUrl,
  setDisplayPointSize,
  setLastUrl,
} from "./app-state";

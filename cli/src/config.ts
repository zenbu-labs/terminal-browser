import {
  COMMAND_IDS,
  ConfigStore,
  SETTINGS,
  SETTINGS_FILE,
  SETTING_KEYS,
  SHORTCUTS_FILE,
  defaultKeys,
  isCommandId,
  isSettingKey,
  parseChord,
} from "shared";
import type { CommandId, LoadedConfig, SettingKey, Settings } from "shared";

const SHORTCUT_PREFIX = "shortcuts.";
const UNBOUND = "none";

type Target = { kind: "setting"; key: SettingKey } | { kind: "shortcut"; id: CommandId };

const USAGE = "usage: terminal-browser config <list|get|set|unset|path> [key] [value]";

function complain(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

function resolve(key: string): Target | null {
  if (key.startsWith(SHORTCUT_PREFIX)) {
    const id = key.slice(SHORTCUT_PREFIX.length);
    return isCommandId(id) ? { kind: "shortcut", id } : null;
  }
  return isSettingKey(key) ? { kind: "setting", key } : null;
}

function unknownKey(key: string): number {
  return complain(`invalid key: ${key}`);
}

function shortcutValue(loaded: LoadedConfig, id: CommandId): string {
  const override = loaded.shortcuts?.[id];
  if (override === null) return UNBOUND;
  return (override ?? defaultKeys(id)).join(",");
}

function load(store: ConfigStore): LoadedConfig | null {
  const loaded = store.load();
  if (loaded.errors.length === 0) return loaded;
  for (const error of loaded.errors) process.stderr.write(`terminal-browser:${error}\n`);
  return null;
}

function list(store: ConfigStore): number {
  const loaded = load(store);
  if (!loaded) return 1;
  for (const key of SETTING_KEYS) process.stdout.write(`${key}=${loaded.settings?.[key] ?? SETTINGS[key].default}\n`);
  for (const id of COMMAND_IDS) process.stdout.write(`${SHORTCUT_PREFIX}${id}=${shortcutValue(loaded, id)}\n`);
  return 0;
}

function get(store: ConfigStore, key: string): number {
  const target = resolve(key);
  if (!target) return unknownKey(key);
  const loaded = load(store);
  if (!loaded) return 1;
  const value =
    target.kind === "setting"
      ? String(loaded.settings?.[target.key] ?? SETTINGS[target.key].default)
      : shortcutValue(loaded, target.id);
  process.stdout.write(`${value}\n`);
  return 0;
}

function set(store: ConfigStore, key: string, value: string): number {
  const target = resolve(key);
  if (!target) return unknownKey(key);
  if (target.kind === "setting") {
    const parsed = SETTINGS[target.key].schema.safeParse(value);
    if (!parsed.success) return complain(`${key}: ${parsed.error.issues[0].message}`);
    store.setSetting(target.key, parsed.data as Settings[SettingKey]);
    return 0;
  }
  if (value === UNBOUND) {
    store.setShortcut(target.id, null);
    return 0;
  }
  const chords = value.split(",").map((chord) => chord.trim()).filter(Boolean);
  const invalid = chords.find((chord) => parseChord(chord) === null);
  if (invalid !== undefined || chords.length === 0) {
    return complain(`${invalid ?? value} is not a key chord. Example: cmd+shift+f, or ${UNBOUND} to unbind`);
  }
  store.setShortcut(target.id, chords);
  return 0;
}

function unset(store: ConfigStore, key: string): number {
  const target = resolve(key);
  if (!target) return unknownKey(key);
  if (target.kind === "setting") store.setSetting(target.key, undefined);
  else store.setShortcut(target.id, undefined);
  return 0;
}

export function configCommand(args: string[]): number {
  try {
    return run(args);
  } catch (error) {
    return complain(error instanceof Error ? error.message : String(error));
  }
}

function run(args: string[]): number {
  const store = new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE });
  const [action, key, ...rest] = args;
  switch (action) {
    case "list":
      return list(store);
    case "path":
      process.stdout.write(`${SETTINGS_FILE}\n${SHORTCUTS_FILE}\n`);
      return 0;
    case "get":
      if (!key) return complain("wrong number of arguments, should be 1");
      return get(store, key);
    case "set":
      if (!key || rest.length === 0) return complain("wrong number of arguments, should be 2");
      return set(store, key, rest.join(" "));
    case "unset":
      if (!key) return complain("wrong number of arguments, should be 1");
      return unset(store, key);
    default:
      process.stderr.write(`${USAGE}\n`);
      return complain(action ? `unknown subcommand: ${action}` : "wrong number of arguments, should be at least 1");
  }
}

import fs from "node:fs";
import path from "node:path";

import { KEYBINDINGS_FILE } from "./paths";

export type KeybindingActionId =
  | "palette"
  | "location"
  | "find"
  | "new-tab"
  | "close-tab"
  | "reopen-tab"
  | "next-tab"
  | "previous-tab"
  | "duplicate-tab"
  | "reload"
  | "hard-reload"
  | "back"
  | "forward"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "devtools"
  | "console"
  | "copy-url"
  | "record"
  | "quit";

export interface KeybindingSetting {
  id: KeybindingActionId;
  label: string;
  defaultBinding: string;
  binding: string;
  overridden: boolean;
}

interface KeybindingRegistry {
  overrides: Partial<Record<KeybindingActionId, string>>;
  version: 1;
}

const mac = process.platform === "darwin";

const DEFINITIONS: Array<Omit<KeybindingSetting, "binding" | "overridden">> = [
  {
    id: "palette",
    label: "command palette",
    defaultBinding: mac ? "super+p" : "ctrl+k alt+k",
  },
  {
    id: "location",
    label: "focus address bar",
    defaultBinding: mac ? "super+l" : "ctrl+l super+l",
  },
  {
    id: "find",
    label: "find in page",
    defaultBinding: mac ? "super+f super+shift+f" : "ctrl+f ctrl+shift+f",
  },
  {
    id: "new-tab",
    label: "new tab",
    defaultBinding: mac ? "super+t" : "ctrl+t super+t",
  },
  {
    id: "close-tab",
    label: "close tab",
    defaultBinding: mac ? "super+w" : "ctrl+w",
  },
  {
    id: "reopen-tab",
    label: "reopen closed tab",
    defaultBinding: mac ? "super+shift+t" : "alt+shift+t ctrl+shift+t",
  },
  {
    id: "next-tab",
    label: "next tab",
    defaultBinding: mac ? "ctrl+tab" : "alt+shift+right ctrl+tab",
  },
  {
    id: "previous-tab",
    label: "previous tab",
    defaultBinding: mac ? "ctrl+shift+tab" : "alt+shift+left ctrl+shift+tab",
  },
  { id: "duplicate-tab", label: "duplicate tab", defaultBinding: "none" },
  {
    id: "reload",
    label: "reload page",
    defaultBinding: mac ? "super+r" : "ctrl+r super+r",
  },
  {
    id: "hard-reload",
    label: "reload page without cache",
    defaultBinding: mac ? "super+shift+r" : "none",
  },
  {
    id: "back",
    label: "go back",
    defaultBinding: mac ? "super+[" : "alt+left ctrl+[ super+[",
  },
  {
    id: "forward",
    label: "go forward",
    defaultBinding: mac ? "super+]" : "alt+right ctrl+] super+]",
  },
  {
    id: "zoom-in",
    label: "zoom in",
    defaultBinding: mac ? "super+=" : "ctrl+= super+=",
  },
  {
    id: "zoom-out",
    label: "zoom out",
    defaultBinding: mac ? "super+-" : "ctrl+- super+-",
  },
  {
    id: "zoom-reset",
    label: "reset zoom",
    defaultBinding: mac ? "super+0" : "ctrl+0 super+0",
  },
  {
    id: "devtools",
    label: "toggle developer tools",
    defaultBinding: mac ? "super+shift+i f12" : "f12 ctrl+shift+i",
  },
  {
    id: "console",
    label: "open developer console",
    defaultBinding: mac ? "super+alt+j" : "ctrl+alt+j",
  },
  { id: "copy-url", label: "copy page URL", defaultBinding: "none" },
  {
    id: "record",
    label: "record page",
    defaultBinding: mac ? "ctrl+r" : "ctrl+shift+r",
  },
  {
    id: "quit",
    label: "quit browser",
    defaultBinding: mac ? "ctrl+q ctrl+c" : "ctrl+q",
  },
];

export function listKeybindings(
  file: string = KEYBINDINGS_FILE,
): KeybindingSetting[] {
  const overrides = readRegistry(file).overrides;
  return DEFINITIONS.map((definition) => ({
    ...definition,
    binding: overrides[definition.id] ?? definition.defaultBinding,
    overridden: overrides[definition.id] !== undefined,
  }));
}

export function keybindingSetting(
  id: string,
  file: string = KEYBINDINGS_FILE,
): KeybindingSetting | null {
  return listKeybindings(file).find((setting) => setting.id === id) ?? null;
}

export function setKeybinding(
  id: string,
  binding: string,
  file: string = KEYBINDINGS_FILE,
): KeybindingSetting {
  if (!DEFINITIONS.some((definition) => definition.id === id)) {
    throw new Error(`unknown keybinding action ${id}`);
  }
  const registry = readRegistry(file);
  registry.overrides[id as KeybindingActionId] = normalizeKeybinding(binding);
  writeRegistry(file, registry);
  return keybindingSetting(id, file)!;
}

export function resetKeybinding(
  id: string | null,
  file: string = KEYBINDINGS_FILE,
): void {
  const registry = readRegistry(file);
  if (id === null) registry.overrides = {};
  else {
    if (!DEFINITIONS.some((definition) => definition.id === id)) {
      throw new Error(`unknown keybinding action ${id}`);
    }
    delete registry.overrides[id as KeybindingActionId];
  }
  writeRegistry(file, registry);
}

export function keybindingConflicts(
  settings: KeybindingSetting[],
): Array<{ binding: string; actions: KeybindingActionId[] }> {
  const owners = new Map<string, KeybindingActionId[]>();
  for (const setting of settings) {
    if (setting.binding === "none") continue;
    for (const chord of setting.binding.split(" ")) {
      const actions = owners.get(chord) ?? [];
      actions.push(setting.id);
      owners.set(chord, actions);
    }
  }
  return [...owners]
    .filter(([, actions]) => actions.length > 1)
    .map(([binding, actions]) => ({ binding, actions }));
}

export function normalizeKeybinding(spec: string): string {
  const trimmed = spec.trim().toLowerCase();
  if (trimmed === "none") return "none";
  if (!trimmed)
    throw new Error("keybinding cannot be empty (use none to disable it)");
  if (trimmed.split(/\s+/).includes("none")) {
    throw new Error("none cannot be combined with another binding");
  }
  const chords = trimmed.split(/\s+/).map(normalizeChord);
  return [...new Set(chords)].join(" ");
}

function normalizeChord(chord: string): string {
  const parts = chord.split("+");
  const key = parts.pop();
  if (!key) throw new Error(`invalid keybinding ${chord}`);
  const modifiers: string[] = [];
  for (const raw of parts) {
    const modifier = raw === "cmd" ? "super" : raw === "option" ? "alt" : raw;
    if (!["super", "ctrl", "alt", "shift"].includes(modifier)) {
      throw new Error(`unknown keybinding modifier ${raw}`);
    }
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const order = ["super", "ctrl", "alt", "shift"];
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...modifiers, key].join("+");
}

function readRegistry(file: string): KeybindingRegistry {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as Partial<KeybindingRegistry>;
    if (
      parsed.version !== 1 ||
      typeof parsed.overrides !== "object" ||
      !parsed.overrides
    ) {
      throw new Error(`unsupported keybinding registry format in ${file}`);
    }
    const overrides: Partial<Record<KeybindingActionId, string>> = {};
    for (const [id, binding] of Object.entries(parsed.overrides)) {
      if (
        !DEFINITIONS.some((definition) => definition.id === id) ||
        typeof binding !== "string"
      ) {
        throw new Error(`invalid keybinding registry in ${file}`);
      }
      overrides[id as KeybindingActionId] = normalizeKeybinding(binding);
    }
    return { version: 1, overrides };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, overrides: {} };
    if (error instanceof SyntaxError) {
      throw new Error(
        `invalid keybinding registry in ${file}: ${error.message}`,
      );
    }
    throw error;
  }
}

function writeRegistry(file: string, registry: KeybindingRegistry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

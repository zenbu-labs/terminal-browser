import type { EngineKeyEvent } from "@zenbu-labs/pixel";

import { Keymap, chordFromEvent, formatChord, parseChord, sameChord } from "shared";
import type { Chord, ExtensionRecord } from "shared";

import type { LoadedExtension } from "./loaded";
import type { Manifest, ManifestCommand } from "./manifest";
import type { ExtensionService } from "./service";
import type { ExtensionWindow } from "./window";

export interface ExtensionCommand {
  name: string;
  description: string;
  // A terminal-browser chord like "cmd+shift+y", or "" when the command has no shortcut.
  shortcut: string;
}

const EXECUTE_ACTION = ["_execute_action", "_execute_browser_action", "_execute_page_action"];
const MAX_SUGGESTED_KEYS = 4;

const CHROME_KEYS: Record<string, string> = {
  comma: ",",
  period: ".",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  space: "space",
  insert: "insert",
  delete: "delete",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  medianexttrack: "medianexttrack",
  mediaplaypause: "mediaplaypause",
  mediaprevtrack: "mediaprevtrack",
  mediastop: "mediastop",
};

function platformKey(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "linux";
}

// Chrome's manifest shortcut syntax ("Ctrl+Shift+Y", "MacCtrl+Comma"). On a Mac
// Chrome reads Ctrl as Command, and MacCtrl is the real Control key.
export function parseChromeShortcut(spec: string, platform: NodeJS.Platform = process.platform): Chord | null {
  const parts = spec.split("+").map((part) => part.trim().toLowerCase());
  const key = parts.pop();
  if (!key) return null;
  const chord: Chord = { key: "", super: false, ctrl: false, alt: false, shift: false };
  const mac = platform === "darwin";
  for (const part of parts) {
    if (part === "ctrl") chord[mac ? "super" : "ctrl"] = true;
    else if (part === "command" && mac) chord.super = true;
    else if (part === "macctrl" && mac) chord.ctrl = true;
    else if (part === "alt") chord.alt = true;
    else if (part === "shift") chord.shift = true;
    else return null;
  }
  if (!chord.ctrl && !chord.alt && !chord.super && !key.startsWith("media")) return null;
  if (chord.ctrl && chord.alt && !mac) return null;
  if (/^[a-z0-9]$/.test(key)) chord.key = key;
  else if (CHROME_KEYS[key]) chord.key = CHROME_KEYS[key];
  else return null;
  return chord;
}

function suggestedKey(command: ManifestCommand, platform: NodeJS.Platform): string | null {
  const suggested = command.suggested_key;
  if (!suggested) return null;
  if (typeof suggested === "string") return suggested;
  return suggested[platformKey(platform)] ?? suggested.default ?? null;
}

// Each manifest command with the shortcut the user gave it, or else the
// manifest's suggestion (Chrome only honours the first four suggestions).
export function commandsFor(manifest: Manifest, record: ExtensionRecord, platform: NodeJS.Platform = process.platform): ExtensionCommand[] {
  let suggestions = 0;
  return Object.entries(manifest.commands ?? {}).map(([name, command]) => {
    const override = record.shortcuts[name];
    let shortcut = "";
    if (override !== undefined) {
      const chord = parseChord(override);
      shortcut = chord ? formatChord(chord, platform) : "";
    } else {
      const raw = suggestedKey(command, platform);
      const chord = raw ? parseChromeShortcut(raw, platform) : null;
      if (chord && suggestions++ < MAX_SUGGESTED_KEYS) shortcut = formatChord(chord, platform);
    }
    return { name, description: command.description ?? "", shortcut };
  });
}

// How terminal-browser shows a command's `shortcut`, e.g. "cmd+shift+y".
export function formatShortcut(shortcut: string, platform: NodeJS.Platform = process.platform): string {
  const chord = parseChord(shortcut);
  return chord ? formatChord(chord, platform) : "";
}

const MAC_SYMBOLS: [keyof Omit<Chord, "key">, string][] = [
  ["ctrl", "⌃"],
  ["alt", "⌥"],
  ["shift", "⇧"],
  ["super", "⌘"],
];

const KEY_TEXT: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  space: "Space",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

// The text chrome.commands.getAll reports, like Chrome's accelerator text.
export function chromeShortcutText(chord: Chord, platform: NodeJS.Platform = process.platform): string {
  const key = KEY_TEXT[chord.key] ?? chord.key.toUpperCase();
  if (platform === "darwin") {
    const symbols = MAC_SYMBOLS.filter(([mod]) => chord[mod]).map(([, symbol]) => symbol).join("");
    return `${symbols}${chord.key === "," ? "," : chord.key === "." ? "." : key}`;
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  if (chord.super) parts.push("Search");
  parts.push(key);
  return parts.join("+");
}

interface ActiveCommand {
  extension: LoadedExtension;
  name: string;
  chord: Chord;
}

// chrome.commands keyboard shortcuts, matched before keys reach the page.
export class CommandStore {
  private readonly reserved: Chord[];

  constructor(private readonly service: ExtensionService) {
    this.reserved = [false, true].flatMap((noSuper) => new Keymap({}, { noSuper }).all().flatMap((binding) => binding.chords));
  }

  isReserved(chord: Chord): boolean {
    return this.reserved.some((taken) => sameChord(taken, chord));
  }

  // Shortcuts in effect: user-set ones always, suggested ones only when no
  // terminal-browser shortcut or earlier extension already uses the keys.
  active(): ActiveCommand[] {
    const taken: ActiveCommand[] = [];
    for (const extension of this.service.loaded.values()) {
      for (const command of commandsFor(extension.manifest, extension.record)) {
        const chord = command.shortcut ? parseChord(command.shortcut) : null;
        if (!chord) continue;
        const userSet = extension.record.shortcuts[command.name] !== undefined;
        if (!userSet && this.isReserved(chord)) continue;
        if (taken.some((other) => sameChord(other.chord, chord))) continue;
        taken.push({ extension, name: command.name, chord });
      }
    }
    return taken;
  }

  // An extension's commands with the shortcut each one really has right now.
  list(manifest: Manifest, record: ExtensionRecord): ExtensionCommand[] {
    const active = this.service.get(record.id) ? this.active().filter((entry) => entry.extension.id === record.id) : null;
    return commandsFor(manifest, record).map((command) => {
      const chord = command.shortcut ? parseChord(command.shortcut) : null;
      if (!chord) return command;
      const live = active
        ? active.some((entry) => entry.name === command.name)
        : record.shortcuts[command.name] !== undefined || !this.isReserved(chord);
      return live ? command : { ...command, shortcut: "" };
    });
  }

  handleKey(window: ExtensionWindow, event: EngineKeyEvent): boolean {
    if (event.kind !== "press") return false;
    const pressed = chordFromEvent(event);
    if (!pressed) return false;
    const match = this.active().find((command) => sameChord(command.chord, pressed));
    if (!match) return false;
    this.run(window, match.extension, match.name);
    return true;
  }

  run(window: ExtensionWindow, extension: LoadedExtension, name: string) {
    if (EXECUTE_ACTION.includes(name)) {
      extension.noteUserGesture();
      this.service.actions.activate(window, extension.id);
      return;
    }
    const tab = window.host.tabs.active;
    if (!tab || tab.contentsId === null) {
      extension.noteUserGesture();
      this.service.dispatch(extension.id, "commands.onCommand", [name]);
      return;
    }
    this.service.grantActiveTab(extension, tab);
    this.service.dispatch(extension.id, "commands.onCommand", [name, this.service.tabInfo(extension, { window, tab })]);
  }

  install(service: ExtensionService) {
    service.router.handle("commands.getAll", (caller) => {
      const active = this.active();
      return commandsFor(caller.extension.manifest, caller.extension.record).map((command) => {
        const live = active.find((entry) => entry.extension === caller.extension && entry.name === command.name);
        return { name: command.name, description: command.description, shortcut: live ? chromeShortcutText(live.chord) : "" };
      });
    });
  }
}

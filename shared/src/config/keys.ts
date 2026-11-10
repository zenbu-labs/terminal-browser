import type { EngineKeyEvent, KeyMods } from "@zenbu-labs/pixel";

import { COMMAND_IDS, defaultKeys } from "./commands";
import type { CommandId } from "./commands";

export interface Chord extends KeyMods {
  key: string;
}

const MOD_NAMES: Record<string, keyof KeyMods> = {
  cmd: "super",
  command: "super",
  super: "super",
  meta: "super",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

const KEY_NAMES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  " ": "space",
  spacebar: "space",
  del: "delete",
  plus: "+",
};

const SHIFTED_SYMBOLS: Record<string, string> = { "+": "=", _: "-" };

const MODIFIER_KEYS = /^(left|right)?(shift|ctrl|control|alt|option|super|meta|cmd|command)$/;

function noMods(): KeyMods {
  return { super: false, ctrl: false, alt: false, shift: false };
}

function normalizeKey(key: string, shift: boolean): { key: string; shift: boolean } {
  const named = KEY_NAMES[key] ?? key;
  const base = SHIFTED_SYMBOLS[named];
  return base ? { key: base, shift: true } : { key: named, shift };
}

export function parseChord(spec: string): Chord | null {
  const text = spec.trim().toLowerCase();
  if (!text) return null;
  const parts = text.split("+").filter(Boolean);
  const key = text === "+" || text.endsWith("++") ? "+" : parts.pop();
  if (!key || MOD_NAMES[key]) return null;
  const mods = noMods();
  for (const part of parts) {
    const mod = MOD_NAMES[part];
    if (!mod) return null;
    mods[mod] = true;
  }
  const normalized = normalizeKey(key, mods.shift);
  return { ...mods, key: normalized.key, shift: normalized.shift };
}

export function parseChords(specs: readonly string[]): Chord[] {
  return specs.map(parseChord).filter((chord): chord is Chord => chord !== null);
}

export function formatChord(chord: Chord, platform: NodeJS.Platform = process.platform): string {
  const parts: string[] = [];
  if (chord.super) parts.push(platform === "darwin" ? "cmd" : "super");
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key);
  return parts.join("+");
}

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.test(key.toLowerCase());
}

export function chordFromEvent(event: EngineKeyEvent): Chord | null {
  const key = event.key.toLowerCase();
  if (!key || key === "unknown" || isModifierKey(key)) return null;
  const normalized = normalizeKey(key, event.mods.shift);
  return { ...event.mods, key: normalized.key, shift: normalized.shift };
}

export function sameChord(a: Chord, b: Chord): boolean {
  return (
    a.key === b.key &&
    a.super === b.super &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}

export function listStep(event: EngineKeyEvent): 1 | -1 | null {
  if (event.key === "down" || (event.mods.ctrl && event.key === "n")) return 1;
  if (event.key === "up" || (event.mods.ctrl && event.key === "p")) return -1;
  return null;
}

function withoutSuper(chord: Chord): Chord {
  return chord.super ? { ...chord, super: false, alt: true } : chord;
}

export type ShortcutOverrides = Partial<Record<CommandId, string[] | null>>;

export interface ResolvedBinding {
  id: CommandId;
  chords: Chord[];
  modified: boolean;
}

export class Keymap {
  private readonly bindings = new Map<CommandId, ResolvedBinding>();

  constructor(overrides: ShortcutOverrides, options: { noSuper: boolean }) {
    for (const id of COMMAND_IDS) {
      const override = overrides[id];
      const chords =
        override === undefined
          ? parseChords(defaultKeys(id)).map((chord) =>
              options.noSuper ? withoutSuper(chord) : chord,
            )
          : parseChords(override ?? []);
      this.bindings.set(id, { id, chords, modified: override !== undefined });
    }
  }

  match(event: EngineKeyEvent): CommandId | null {
    const pressed = chordFromEvent(event);
    if (!pressed) return null;
    for (const binding of this.bindings.values()) {
      if (binding.chords.some((chord) => sameChord(chord, pressed))) return binding.id;
    }
    return null;
  }

  binding(id: CommandId): ResolvedBinding {
    return this.bindings.get(id)!;
  }

  all(): ResolvedBinding[] {
    return [...this.bindings.values()];
  }

  labels(id: CommandId): string[] {
    return this.binding(id).chords.map((chord) => formatChord(chord));
  }

  label(id: CommandId): string {
    return this.labels(id)[0] ?? "";
  }

  conflicts(id: CommandId): CommandId[] {
    const own = this.binding(id).chords;
    return this.all()
      .filter(
        (other) =>
          other.id !== id &&
          other.chords.some((chord) => own.some((mine) => sameChord(mine, chord))),
      )
      .map((other) => other.id);
  }
}

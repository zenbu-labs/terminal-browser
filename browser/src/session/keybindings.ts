import type { EngineKeyEvent, KeyMods } from "pixel-react";

export type KeyBinding = KeyMods & { key: string };

export const defaultKeys =
  process.platform === "darwin"
    ? {
        palette: "super+p",
        find: "super+shift+f",
        devtools: "super+shift+i",
        console: "super+alt+j",
        screenshot: "super+shift+s",
        profiles: "super+shift+p",
        focus: "super+shift+k",
      }
    : {
        palette: "ctrl+k alt+k",
        find: "ctrl+shift+f",
        devtools: "ctrl+shift+i",
        console: "ctrl+alt+j",
        screenshot: "ctrl+shift+s",
        profiles: "ctrl+shift+p",
        focus: "ctrl+shift+k",
      };

export const recordKeyLabel = process.platform === "darwin" ? "ctrl+r" : "ctrl+shift+r";

export function isRecordKey(event: EngineKeyEvent): boolean {
  return (
    event.key.toLowerCase() === "r" &&
    event.mods.ctrl &&
    !event.mods.super &&
    !event.mods.alt &&
    event.mods.shift === (process.platform !== "darwin")
  );
}

export function parseKeyBindings(spec: string): KeyBinding[] {
  if (spec === "none") return [];
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .map((chord) => {
      const parts = chord.toLowerCase().split("+");
      const key = parts.pop() ?? "";
      return { ...parseMods(parts), key };
    });
}

export function matchesBinding(event: EngineKeyEvent, bindings: KeyBinding[]): boolean {
  return bindings.some(
    (binding) => event.key.toLowerCase() === binding.key && matchesMods(event, binding),
  );
}

export function listStep(event: EngineKeyEvent): 1 | -1 | null {
  if (event.key === "down" || (event.mods.ctrl && event.key === "n")) return 1;
  if (event.key === "up" || (event.mods.ctrl && event.key === "p")) return -1;
  return null;
}

export function bindingLabel(bindings: KeyBinding[]): string {
  const binding = bindings[0];
  if (!binding) return "";
  const superKey = process.platform === "darwin" ? "cmd+" : "super+";
  const mods = `${binding.super ? superKey : ""}${binding.ctrl ? "ctrl+" : ""}${
    binding.alt ? "alt+" : ""
  }${binding.shift ? "shift+" : ""}`;
  return `${mods}${binding.key}`;
}

function parseMods(parts: string[]): KeyMods {
  const mods = { super: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    if (part === "cmd" || part === "super") mods.super = true;
    else if (part === "ctrl") mods.ctrl = true;
    else if (part === "alt" || part === "option") mods.alt = true;
    else if (part === "shift") mods.shift = true;
  }
  return mods;
}

function matchesMods(event: EngineKeyEvent, mods: KeyMods): boolean {
  return (
    event.mods.super === mods.super &&
    event.mods.ctrl === mods.ctrl &&
    event.mods.alt === mods.alt &&
    event.mods.shift === mods.shift
  );
}

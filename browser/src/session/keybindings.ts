import type { EngineKeyEvent, KeyMods } from "pixel-react";

export type KeyBinding = KeyMods & { key: string };

// linux window managers own the super key, so defaults move to ctrl there
export const defaultKeys =
  process.platform === "darwin"
    ? { palette: "super+p", find: "super+shift+f", devtools: "super+shift+i", console: "super+alt+j" }
    : { palette: "ctrl+shift+p", find: "ctrl+shift+f", devtools: "ctrl+shift+i", console: "ctrl+alt+j" };

export function parseKeyBinding(spec: string): KeyBinding | null {
  if (spec === "none") return null;
  const parts = spec.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  return { ...parseMods(parts), key };
}

export function matchesBinding(event: EngineKeyEvent, binding: KeyBinding | null): boolean {
  return binding !== null && event.key.toLowerCase() === binding.key && matchesMods(event, binding);
}

export function listStep(event: EngineKeyEvent): 1 | -1 | null {
  if (event.key === "down" || (event.mods.ctrl && event.key === "n")) return 1;
  if (event.key === "up" || (event.mods.ctrl && event.key === "p")) return -1;
  return null;
}

export function bindingLabel(binding: KeyBinding | null): string {
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

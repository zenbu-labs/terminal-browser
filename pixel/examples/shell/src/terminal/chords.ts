import type { KeyEvent } from "./input";

export type GuiAction = "copy" | "cut" | "undo" | "redo" | "select-line" | "ask-ai" | "newline" | "complete";

export const GUI_CHORDS: Record<string, GuiAction> = {
  "super+c": "copy",
  "super+x": "cut",
  "super+z": "undo",
  "shift+super+z": "redo",
  "super+a": "select-line",
  "shift+super+e": "ask-ai",
  "shift+enter": "newline",
  "alt+enter": "newline",
  "ctrl+space": "complete",
};

export function chordName(event: Pick<KeyEvent, "key" | "mods">): string {
  const { ctrl, alt, shift, super: cmd } = event.mods;
  return [ctrl && "ctrl", alt && "alt", shift && "shift", cmd && "super", event.key === " " ? "space" : event.key.toLowerCase()].filter(Boolean).join("+");
}

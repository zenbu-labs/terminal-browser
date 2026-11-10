import type { KeyEvent } from "./input";
import type { Vt } from "./vt";

export const KITTY_DISAMBIGUATE_FLAG = 1;

const FUNCTION_KEYS = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown", "insert", "delete"]);

const CONTROL_PUNCTUATION: Record<string, number> = { " ": 0x00, "2": 0x00, "@": 0x00, "[": 0x1b, "\\": 0x1c, "]": 0x1d, "^": 0x1e, "6": 0x1e, "_": 0x1f, "-": 0x1f, "/": 0x1f, "?": 0x7f };

function controlByte(c: string): number | null {
  const lower = c.toLowerCase();
  if (lower >= "a" && lower <= "z" && lower.length === 1) return lower.charCodeAt(0) - 0x60;
  return CONTROL_PUNCTUATION[c] ?? null;
}

export function legacyKey(event: KeyEvent, vt: Vt): Buffer {
  if (event.kind === "release") return Buffer.alloc(0);
  const { shift, alt, ctrl, super: cmd } = event.mods;
  const esc = alt ? "\x1b" : "";
  if (FUNCTION_KEYS.has(event.key) || /^f[0-9]+$/.test(event.key)) return vt.encodeKey(event);
  if (cmd) return Buffer.alloc(0);
  switch (event.key) {
    case "escape":
      return Buffer.from(esc + "\x1b");
    case "enter":
      return Buffer.from(esc + "\r");
    case "tab":
      return Buffer.from(shift && !alt && !ctrl ? "\x1b[Z" : esc + "\t");
    case "backspace":
      return Buffer.from(esc + (ctrl ? "\x08" : "\x7f"));
  }
  if ([...event.key].length !== 1) return Buffer.alloc(0);
  if (ctrl) {
    const byte = controlByte(event.key);
    return byte == null ? Buffer.from(esc + event.key) : Buffer.concat([Buffer.from(esc), Buffer.from([byte])]);
  }
  const text = event.text ?? (shift ? event.key.toUpperCase() : event.key);
  return Buffer.from(esc + text);
}

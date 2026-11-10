export interface KeyMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  super: boolean;
}

export interface KeyEvent {
  key: string;
  kind: "press" | "repeat" | "release";
  text?: string;
  mods: KeyMods;
  kitty: boolean;
}

export interface MouseReport {
  button: "left" | "middle" | "right" | "none";
  kind: "down" | "up" | "move" | "scrollup" | "scrolldown" | "scrollleft" | "scrollright";
  col: number;
  row: number;
  mods: KeyMods;
  sgr: boolean;
}

export type Unit =
  | { kind: "key"; bytes: Buffer; key: KeyEvent }
  | { kind: "mouse"; bytes: Buffer; mouse: MouseReport }
  | { kind: "paste"; bytes: Buffer; text: string }
  | { kind: "focus"; bytes: Buffer; focused: boolean }
  | { kind: "other"; bytes: Buffer };

const NO_MODS: KeyMods = { shift: false, alt: false, ctrl: false, super: false };
const PASTE_START = Buffer.from("\x1b[200~");
const PASTE_END = Buffer.from("\x1b[201~");

const FUNCTIONAL: Record<number, string> = {
  9: "tab",
  13: "enter",
  27: "escape",
  127: "backspace",
  57399: "0",
  57400: "1",
  57401: "2",
  57402: "3",
  57403: "4",
  57404: "5",
  57405: "6",
  57406: "7",
  57407: "8",
  57408: "9",
  57414: "enter",
  57417: "left",
  57418: "right",
  57419: "up",
  57420: "down",
  57421: "pageup",
  57422: "pagedown",
  57423: "home",
  57424: "end",
  57425: "insert",
  57426: "delete",
  57441: "leftshift",
  57442: "leftcontrol",
  57443: "leftalt",
  57444: "leftsuper",
  57447: "rightshift",
  57448: "rightcontrol",
  57449: "rightalt",
  57450: "rightsuper",
};

const LETTER_FINALS: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4" };

const TILDE: Record<number, string> = {
  2: "insert",
  3: "delete",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

const MODIFIER_KEYS = new Set(["leftshift", "leftcontrol", "leftalt", "leftsuper", "rightshift", "rightcontrol", "rightalt", "rightsuper"]);

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

function modsFrom(value: number): KeyMods {
  const bits = Math.max(0, value - 1);
  return { shift: !!(bits & 1), alt: !!(bits & 2), ctrl: !!(bits & 4), super: !!(bits & 8) };
}

function isUpper(c: string): boolean {
  return c !== c.toLowerCase() && c === c.toUpperCase();
}

function charKey(c: string, mods: Partial<KeyMods> = {}): KeyEvent {
  return { key: c, kind: "press", text: c, mods: { ...NO_MODS, shift: isUpper(c), ...mods }, kitty: false };
}

function named(key: string, mods: Partial<KeyMods> = {}, kitty = false): KeyEvent {
  return { key, kind: "press", mods: { ...NO_MODS, ...mods }, kitty };
}

function controlKey(byte: number): KeyEvent {
  if (byte === 0x0d) return named("enter");
  if (byte === 0x09) return named("tab");
  if (byte === 0x7f) return named("backspace");
  if (byte === 0x08) return named("backspace", { ctrl: true });
  if (byte === 0x1b) return named("escape");
  if (byte === 0x00) return named(" ", { ctrl: true });
  if (byte >= 0x01 && byte <= 0x1a) return named(String.fromCharCode(byte + 0x60), { ctrl: true });
  return named(String.fromCharCode(byte + 0x40), { ctrl: true });
}

function csiKey(body: string, final: string): KeyEvent | null {
  const fields = body.split(";");
  const [mods = 1, event = 1] = (fields[1] ?? "").split(":").map((n) => (n ? Number(n) : 1));
  const kind = event === 2 ? "repeat" : event === 3 ? "release" : "press";
  if (final === "u") {
    const [code, shifted] = (fields[0] ?? "").split(":").map(Number);
    const name = FUNCTIONAL[code];
    const m = modsFrom(mods);
    const textField = fields[2] ? String.fromCodePoint(...fields[2].split(":").map(Number)) : undefined;
    if (name) return { key: name, kind, mods: m, text: name.length === 1 ? textField ?? name : textField, kitty: true };
    if (!Number.isFinite(code) || code <= 0) return null;
    const base = String.fromCodePoint(code);
    const shown = m.shift && shifted ? String.fromCodePoint(shifted) : m.shift && base.length === 1 ? base.toUpperCase() : base;
    const text = textField ?? (m.ctrl || m.alt || m.super ? undefined : shown);
    return { key: base === " " ? " " : base, kind, mods: m, text, kitty: true };
  }
  if (final === "~") {
    const name = TILDE[Number(fields[0])];
    return name ? { key: name, kind, mods: modsFrom(mods), kitty: false } : null;
  }
  if (final === "Z") return named("tab", { shift: true });
  const name = LETTER_FINALS[final];
  if (!name || (fields[0] && fields[0] !== "1")) return null;
  return { key: name, kind, mods: modsFrom(mods), kitty: false };
}

function mouseFrom(button: number, col: number, row: number, release: boolean, sgr: boolean): MouseReport {
  const mods = { shift: !!(button & 4), alt: !!(button & 8), ctrl: !!(button & 16), super: false };
  const low = button & 3;
  let kind: MouseReport["kind"];
  let which: MouseReport["button"] = "none";
  if (button & 64) kind = (["scrollup", "scrolldown", "scrollleft", "scrollright"] as const)[low];
  else if (button & 32) {
    kind = "move";
    which = low === 3 ? "none" : (["left", "middle", "right"] as const)[low];
  } else if (release || (!sgr && low === 3)) {
    kind = "up";
    which = sgr ? (["left", "middle", "right", "none"] as const)[low] : "none";
  } else {
    kind = "down";
    which = (["left", "middle", "right", "none"] as const)[low];
  }
  return { button: which, kind, col: col - 1, row: row - 1, mods, sgr };
}

function sequenceLength(b: Buffer): number {
  if (b.length < 2) return 0;
  const kind = b[1];
  if (kind === 0x5b) {
    if (b.length >= 3 && b[2] === 0x4d && !(b.length > 3 && b[3] >= 0x30 && b[3] <= 0x3f)) return b.length >= 6 ? 6 : 0;
    for (let i = 2; i < b.length; i++) {
      const c = b[i];
      if (c >= 0x40 && c <= 0x7e) return i + 1;
      if (c < 0x20 || c > 0x3f) return i;
    }
    return 0;
  }
  if (kind === 0x5d || kind === 0x50 || kind === 0x5f || kind === 0x5e || kind === 0x58) {
    for (let i = 2; i < b.length; i++) {
      if (b[i] === 0x07) return i + 1;
      if (b[i] === 0x1b) return i + 1 < b.length ? i + 2 : 0;
    }
    return 0;
  }
  if (kind === 0x4f) return b.length >= 3 ? 3 : 0;
  if (kind >= 0xc0) return b.length >= 1 + utf8Length(kind) ? 1 + utf8Length(kind) : 0;
  return 2;
}

function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

export class InputParser {
  private held = Buffer.alloc(0);

  feed(data: Buffer): Unit[] {
    let b = this.held.length ? Buffer.concat([this.held, data]) : data;
    this.held = Buffer.alloc(0);
    const units: Unit[] = [];
    while (b.length) {
      const taken = this.take(b, units);
      if (taken === 0) {
        this.held = Buffer.from(b);
        break;
      }
      b = b.subarray(taken);
    }
    return units;
  }

  get pending(): boolean {
    return this.held.length > 0;
  }

  flush(): Unit[] {
    const b = this.held;
    this.held = Buffer.alloc(0);
    if (!b.length) return [];
    if (b.length === 1 && b[0] === 0x1b) return [{ kind: "key", bytes: b, key: named("escape") }];
    if (b.subarray(0, PASTE_START.length).equals(PASTE_START)) {
      return [{ kind: "paste", bytes: Buffer.concat([b, PASTE_END]), text: b.subarray(PASTE_START.length).toString("utf8") }];
    }
    return [{ kind: "other", bytes: b }];
  }

  private take(b: Buffer, units: Unit[]): number {
    const first = b[0];
    if (first !== 0x1b) {
      if (first < 0x20 || first === 0x7f) {
        units.push({ kind: "key", bytes: b.subarray(0, 1), key: controlKey(first) });
        return 1;
      }
      const length = utf8Length(first);
      if (b.length < length) return 0;
      const bytes = b.subarray(0, length);
      units.push({ kind: "key", bytes, key: charKey(bytes.toString("utf8")) });
      return length;
    }
    if (b.length === 1) return 0;
    if (b.subarray(0, PASTE_START.length).equals(PASTE_START)) {
      const end = b.indexOf(PASTE_END, PASTE_START.length);
      if (end < 0) return 0;
      const total = end + PASTE_END.length;
      units.push({ kind: "paste", bytes: b.subarray(0, total), text: b.subarray(PASTE_START.length, end).toString("utf8") });
      return total;
    }
    if (b.length < PASTE_START.length && PASTE_START.subarray(0, b.length).equals(b)) return 0;
    const length = sequenceLength(b);
    if (length === 0) return 0;
    const bytes = b.subarray(0, length);
    units.push(this.classify(bytes));
    return length;
  }

  private classify(bytes: Buffer): Unit {
    const s = bytes.toString("latin1");
    const other: Unit = { kind: "other", bytes };
    if (s[1] === "[") {
      if (s.length === 6 && s[2] === "M") {
        const mouse = mouseFrom(bytes[3] - 32, bytes[4] - 32, bytes[5] - 32, false, false);
        return { kind: "mouse", bytes, mouse };
      }
      const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(s);
      if (sgr) return { kind: "mouse", bytes, mouse: mouseFrom(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), sgr[4] === "m", true) };
      if (s === "\x1b[I" || s === "\x1b[O") return { kind: "focus", bytes, focused: s === "\x1b[I" };
      const csi = /^\x1b\[([0-9;:]*)([A-Za-z~])$/.exec(s);
      if (csi) {
        const key = csiKey(csi[1], csi[2]);
        if (key) return { kind: "key", bytes, key };
      }
      return other;
    }
    if (s[1] === "O" && s.length === 3) {
      const name = LETTER_FINALS[s[2]];
      return name ? { kind: "key", bytes, key: named(name) } : other;
    }
    if (s.length === 2) {
      const c = bytes[1];
      if (c < 0x20 || c === 0x7f) {
        const inner = controlKey(c);
        return { kind: "key", bytes, key: { ...inner, mods: { ...inner.mods, alt: true } } };
      }
      return { kind: "key", bytes, key: charKey(String.fromCharCode(c), { alt: true }) };
    }
    if (bytes[1] >= 0xc0) return { kind: "key", bytes, key: charKey(bytes.subarray(1).toString("utf8"), { alt: true }) };
    return other;
  }
}

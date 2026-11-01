import fs from "node:fs";
import path from "node:path";

const WASM = path.join(__dirname, "..", "..", "vendor", "ghostty-vt.wasm");

type Fn = (...args: (number | bigint)[]) => number;
type Exports = { memory: WebAssembly.Memory } & Record<string, Fn>;
type Struct = { size: number; fields: Record<string, { offset: number; size: number }> };

const SUCCESS = 0;
const OUT_OF_SPACE = -3;

const OPT_KITTY_IMAGE_STORAGE_LIMIT = 15;
const OPT_SCROLLBACK_MAX_LINES = 28;

const DATA = {
  cols: 1,
  rows: 2,
  cursorX: 3,
  cursorY: 4,
  pendingWrap: 5,
  activeScreen: 6,
  cursorVisible: 7,
  kittyFlags: 8,
  cursorStyle: 10,
  mouseTracking: 11,
  title: 12,
  pwd: 13,
  scrollbackRows: 15,
  mode: 37,
  ground: 38,
} as const;

const POINT_ACTIVE = 0;
const POINT_SCREEN = 2;

const CELL_CODEPOINT = 1;
const CELL_CONTENT_TAG = 2;
const CELL_WIDE = 3;
const CELL_HAS_STYLING = 5;
const CELL_HAS_HYPERLINK = 7;
const CELL_COLOR_PALETTE = 10;
const CELL_COLOR_RGB = 11;
const CONTENT_GRAPHEME = 1;
const CONTENT_BG_PALETTE = 2;
const CONTENT_BG_RGB = 3;
const WIDE_WIDE = 1;
const WIDE_SPACER_TAIL = 2;
const WIDE_SPACER_HEAD = 3;
const ROW_WRAP = 1;
const ROW_SEMANTIC_PROMPT = 6;
const ROW_PROMPT_START = 1;

const FORMAT_PLAIN = 0;

const KEY_ACTION = { release: 0, press: 1, repeat: 2 } as const;
const ENCODER_OPT_MACOS_OPTION_AS_ALT = 6;

const NAMED_KEYS: Record<string, number> = {
  backspace: 53,
  enter: 58,
  " ": 63,
  tab: 64,
  delete: 68,
  end: 69,
  home: 71,
  insert: 72,
  pagedown: 73,
  pageup: 74,
  down: 75,
  left: 76,
  right: 77,
  up: 78,
  escape: 120,
  "`": 1,
  "\\": 2,
  "[": 3,
  "]": 4,
  ",": 5,
  "=": 16,
  "-": 46,
  ".": 47,
  "'": 48,
  ";": 49,
  "/": 50,
};

function physicalKey(key: string): number {
  const named = NAMED_KEYS[key];
  if (named != null) return named;
  if (/^[a-z]$/i.test(key)) return 20 + key.toLowerCase().charCodeAt(0) - 97;
  if (/^[0-9]$/.test(key)) return 6 + Number(key);
  const f = /^f([0-9]+)$/.exec(key);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 25) return 120 + Number(f[1]);
  return 0;
}

const CONTROL_TEXT: Record<string, string> = { backspace: "\x7f", enter: "\r", tab: "\t", escape: "\x1b" };

interface EncodableKey {
  key: string;
  kind: "press" | "repeat" | "release";
  text?: string;
  mods: { shift: boolean; alt: boolean; ctrl: boolean; super: boolean };
}

let shared: { exports: Exports; layout: Record<string, Struct>; scratch: number } | null = null;

function engine() {
  if (shared) return shared;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(WASM)), {});
  const exports = instance.exports as unknown as Exports;
  const json = exports.ghostty_type_json();
  const bytes = new Uint8Array(exports.memory.buffer);
  let end = json;
  while (bytes[end]) end++;
  const layout = (JSON.parse(Buffer.from(bytes.subarray(json, end)).toString()) as { types: Record<string, Struct> }).types;
  shared = { exports, layout, scratch: exports.ghostty_wasm_alloc(4096) };
  return shared;
}

let keys: { encoder: number; event: number; text: number } | null = null;

function keyEncoding() {
  if (keys) return keys;
  const { exports: e } = engine();
  const slot = e.ghostty_wasm_alloc_opaque();
  e.ghostty_key_encoder_new(0, slot);
  const encoder = e.ghostty_wasm_take_opaque(slot);
  e.ghostty_key_event_new(0, slot);
  const event = e.ghostty_wasm_take_opaque(slot);
  e.ghostty_wasm_free_opaque(slot);
  keys = { encoder, event, text: e.ghostty_wasm_alloc(64) };
  return keys;
}

type Color = { palette: number } | { rgb: [number, number, number] } | null;

interface Style {
  fg: Color;
  bg: Color;
  underlineColor: Color;
  bold: boolean;
  italic: boolean;
  faint: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  underline: number;
}

interface Cell {
  text: string;
  wide: boolean;
  spacer: boolean;
  style: Style | null;
  link: string | null;
}

interface VtLine {
  cells: string[];
  wrapped: boolean;
}

interface VtInfo {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  pendingWrap: boolean;
  altScreen: boolean;
  cursorVisible: boolean;
  kittyFlags: number;
  mouseTracking: boolean;
  history: number;
  title: string;
}

const MODE = {
  insert: [4, true],
  appCursor: [1, false],
  origin: [6, false],
  wraparound: [7, false],
  cursorVisible: [25, false],
  x10Mouse: [9, false],
  normalMouse: [1000, false],
  buttonMouse: [1002, false],
  anyMouse: [1003, false],
  focusEvents: [1004, false],
  utf8Mouse: [1005, false],
  sgrMouse: [1006, false],
  urxvtMouse: [1015, false],
  sgrPixelsMouse: [1016, false],
  bracketedPaste: [2004, false],
  synchronized: [2026, false],
} as const satisfies Record<string, readonly [number, boolean]>;

type ModeName = keyof typeof MODE;

export class Vt {
  private readonly e: Exports;
  private readonly layout: Record<string, Struct>;
  private readonly scratch: number;
  private readonly handle: number;
  private input = { ptr: 0, size: 0 };

  constructor(cols: number, rows: number, options: { scrollback?: number } = {}) {
    const { exports, layout, scratch } = engine();
    this.e = exports;
    this.layout = layout;
    this.scratch = scratch;
    const slot = this.e.ghostty_wasm_alloc_opaque();
    this.check(this.e.ghostty_terminal_new(0, slot, Math.max(1, cols), Math.max(1, rows)), "create a terminal");
    this.handle = this.e.ghostty_wasm_take_opaque(slot);
    this.e.ghostty_wasm_free_opaque(slot);
    this.view().setBigUint64(this.scratch, 0n, true);
    this.e.ghostty_terminal_set(this.handle, OPT_KITTY_IMAGE_STORAGE_LIMIT, this.scratch);
    if (options.scrollback != null) {
      this.view().setUint32(this.scratch, options.scrollback, true);
      this.e.ghostty_terminal_set(this.handle, OPT_SCROLLBACK_MAX_LINES, this.scratch);
    }
  }

  write(data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (!bytes.length) return;
    if (bytes.length > this.input.size) {
      if (this.input.ptr) this.e.ghostty_wasm_free(this.input.ptr, this.input.size);
      this.input = { size: Math.max(bytes.length, 64 * 1024), ptr: 0 };
      this.input.ptr = this.e.ghostty_wasm_alloc(this.input.size);
    }
    this.bytes().set(bytes, this.input.ptr);
    this.e.ghostty_terminal_vt_write(this.handle, this.input.ptr, bytes.length);
  }

  atGround(): boolean {
    return this.getBool(DATA.ground);
  }

  resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void {
    this.e.ghostty_terminal_resize(this.handle, Math.max(1, cols), Math.max(1, rows), cellWidth, cellHeight);
  }

  info(): VtInfo {
    return {
      cols: this.getU16(DATA.cols),
      rows: this.getU16(DATA.rows),
      cursorX: this.getU16(DATA.cursorX),
      cursorY: this.getU16(DATA.cursorY),
      pendingWrap: this.getBool(DATA.pendingWrap),
      altScreen: this.getU32(DATA.activeScreen) === 1,
      cursorVisible: this.getBool(DATA.cursorVisible),
      kittyFlags: this.getU8(DATA.kittyFlags),
      mouseTracking: this.getBool(DATA.mouseTracking),
      history: this.getU32(DATA.scrollbackRows),
      title: this.getString(DATA.title),
    };
  }

  pwd(): string {
    return this.getString(DATA.pwd);
  }

  mode(name: ModeName): boolean {
    const [value, ansi] = MODE[name];
    const view = this.view();
    view.setUint16(this.scratch, (value & 0x7fff) | (ansi ? 0x8000 : 0), true);
    view.setUint8(this.scratch + 2, 0);
    if (this.e.ghostty_terminal_get(this.handle, DATA.mode, this.scratch) !== SUCCESS) return false;
    return this.view().getUint8(this.scratch + 2) !== 0;
  }

  pen(): Style {
    const style = this.layout.GhosttyStyle;
    this.view().setUint32(this.scratch, style.size, true);
    this.check(this.e.ghostty_terminal_get(this.handle, DATA.cursorStyle, this.scratch), "read the cursor style");
    return this.readStyle(this.scratch);
  }

  cell(x: number, y: number): Cell {
    const ref = this.gridRef(POINT_ACTIVE, x, y);
    if (ref == null) return { text: "", wide: false, spacer: false, style: null, link: null };
    return this.readCell(ref);
  }

  lines(first: number, count: number): VtLine[] {
    const history = this.getU32(DATA.scrollbackRows);
    const cols = this.getU16(DATA.cols);
    const out: VtLine[] = [];
    for (let line = first; line < first + count; line++) {
      const ref = this.gridRef(POINT_SCREEN, 0, history + line);
      if (ref == null) {
        out.push({ cells: [], wrapped: false });
        continue;
      }
      const cells: string[] = [];
      for (let x = 0; x < cols; x++) {
        this.view().setUint16(ref + this.field("GhosttyGridRef", "x"), x, true);
        const cell = this.readCell(ref, false);
        cells.push(cell.spacer ? "" : cell.text || " ");
      }
      out.push({ cells, wrapped: this.rowFlag(ref, ROW_WRAP) });
    }
    return out;
  }

  textRange(from: { line: number; col: number }, to: { line: number; col: number }): string {
    const rows = this.lines(from.line, to.line - from.line + 1);
    return rows
      .map((row, i) => {
        const start = i === 0 ? from.col : 0;
        const end = i === rows.length - 1 ? to.col + 1 : row.cells.length;
        const text = row.cells.slice(start, end).join("");
        return i < rows.length - 1 && !row.wrapped ? text.trimEnd() + "\n" : text;
      })
      .join("");
  }

  newestPromptLineAtOrAbove(line: number): number | null {
    const history = this.getU32(DATA.scrollbackRows);
    for (let at = line; at >= -history; at--) {
      const ref = this.gridRef(POINT_SCREEN, 0, history + at);
      if (ref != null && this.rowValue(ref, ROW_SEMANTIC_PROMPT) === ROW_PROMPT_START) return at;
    }
    return null;
  }

  text(): string {
    const size = this.layout.GhosttyFormatterTerminalOptions;
    const options = this.scratch;
    this.bytes().fill(0, options, options + size.size);
    const view = this.view();
    view.setUint32(options, size.size, true);
    view.setUint32(options + this.field("GhosttyFormatterTerminalOptions", "emit"), FORMAT_PLAIN, true);
    view.setUint8(options + this.field("GhosttyFormatterTerminalOptions", "trim"), 1);
    const extra = options + this.field("GhosttyFormatterTerminalOptions", "extra");
    view.setUint32(extra, this.layout.GhosttyFormatterTerminalExtra.size, true);
    view.setUint32(extra + this.field("GhosttyFormatterTerminalExtra", "screen"), this.layout.GhosttyFormatterScreenExtra.size, true);
    const slot = this.e.ghostty_wasm_alloc_opaque();
    this.check(this.e.ghostty_formatter_terminal_new(0, slot, this.handle, options), "create a formatter");
    const formatter = this.e.ghostty_wasm_take_opaque(slot);
    try {
      return this.allocated((ptr, len) => this.e.ghostty_formatter_format_alloc(formatter, 0, ptr, len));
    } finally {
      this.e.ghostty_formatter_free(formatter);
      this.e.ghostty_wasm_free_opaque(slot);
    }
  }

  encodeKey(event: EncodableKey): Buffer {
    const keys = keyEncoding();
    const e = this.e;
    e.ghostty_key_encoder_setopt_from_terminal(keys.encoder, this.handle);
    this.view().setUint32(this.scratch, 1, true);
    e.ghostty_key_encoder_setopt(keys.encoder, ENCODER_OPT_MACOS_OPTION_AS_ALT, this.scratch);
    const { shift, alt, ctrl, super: cmd } = event.mods;
    e.ghostty_key_event_set_action(keys.event, KEY_ACTION[event.kind]);
    e.ghostty_key_event_set_key(keys.event, physicalKey(event.key.length === 1 ? event.key.toLowerCase() : event.key));
    e.ghostty_key_event_set_mods(keys.event, (shift ? 1 : 0) | (ctrl ? 2 : 0) | (alt ? 4 : 0) | (cmd ? 8 : 0));
    const base = [...event.key].length === 1 ? event.key.toLowerCase() : "";
    const unshifted = base || CONTROL_TEXT[event.key] || "";
    e.ghostty_key_event_set_unshifted_codepoint(keys.event, unshifted ? unshifted.codePointAt(0)! : 0);
    const text = event.text ?? CONTROL_TEXT[event.key] ?? (base && !ctrl && !cmd ? (shift ? event.key.toUpperCase() : base) : "");
    const utf8 = Buffer.from(text);
    this.bytes().set(utf8, keys.text);
    e.ghostty_key_event_set_utf8(keys.event, keys.text, utf8.length);
    const out = this.scratch + 1536;
    const len = this.scratch + 1532;
    if (e.ghostty_key_encoder_encode(keys.encoder, keys.event, out, 256, len) !== SUCCESS) return Buffer.alloc(0);
    return Buffer.from(this.bytes().subarray(out, out + this.view().getUint32(len, true)));
  }

  private bytes(): Uint8Array {
    return new Uint8Array(this.e.memory.buffer);
  }

  private view(): DataView {
    return new DataView(this.e.memory.buffer);
  }

  private field(type: string, name: string): number {
    return this.layout[type].fields[name].offset;
  }

  private check(result: number, what: string): void {
    // fixme: placeholder copy
    if (result !== SUCCESS) throw new Error(`libghostty could not ${what} (${result})`);
  }

  private get(data: number): DataView {
    this.view().setBigUint64(this.scratch, 0n, true);
    this.check(this.e.ghostty_terminal_get(this.handle, data, this.scratch), `read terminal data ${data}`);
    return this.view();
  }

  private getU8(data: number): number {
    return this.get(data).getUint8(this.scratch);
  }

  private getU16(data: number): number {
    return this.get(data).getUint16(this.scratch, true);
  }

  private getU32(data: number): number {
    return this.get(data).getUint32(this.scratch, true);
  }

  private getBool(data: number): boolean {
    return this.getU8(data) !== 0;
  }

  private getString(data: number): string {
    const view = this.get(data);
    const ptr = view.getUint32(this.scratch + this.field("GhosttyString", "ptr"), true);
    const len = view.getUint32(this.scratch + this.field("GhosttyString", "len"), true);
    return ptr && len ? Buffer.from(this.bytes().subarray(ptr, ptr + len)).toString("utf8") : "";
  }

  private allocated(run: (ptrOut: number, lenOut: number) => number): string {
    const out = this.scratch + 2048;
    this.view().setUint32(out, 0, true);
    this.view().setUint32(out + 4, 0, true);
    this.check(run(out, out + 4), "write its output");
    const ptr = this.view().getUint32(out, true);
    const len = this.view().getUint32(out + 4, true);
    const text = Buffer.from(this.bytes().subarray(ptr, ptr + len)).toString("utf8");
    if (ptr) this.e.ghostty_free(0, ptr, len);
    return text;
  }

  private gridRef(tag: number, x: number, y: number): number | null {
    const point = this.scratch + 256;
    const ref = this.scratch + 512;
    const view = this.view();
    const value = point + this.field("GhosttyPoint", "value");
    this.bytes().fill(0, point, point + this.layout.GhosttyPoint.size);
    view.setUint32(point + this.field("GhosttyPoint", "tag"), tag, true);
    view.setUint16(value + this.field("GhosttyPointCoordinate", "x"), x, true);
    view.setUint32(value + this.field("GhosttyPointCoordinate", "y"), y, true);
    this.bytes().fill(0, ref, ref + this.layout.GhosttyGridRef.size);
    view.setUint32(ref, this.layout.GhosttyGridRef.size, true);
    return this.e.ghostty_terminal_grid_ref(this.handle, point, ref) === SUCCESS ? ref : null;
  }

  private rowFlag(ref: number, data: number): boolean {
    return this.rowValue(ref, data) !== 0;
  }

  private rowValue(ref: number, data: number): number {
    const out = this.scratch + 768;
    if (this.e.ghostty_grid_ref_row(ref, out) !== SUCCESS) return 0;
    const row = this.view().getBigUint64(out, true);
    this.view().setUint32(out + 8, 0, true);
    this.e.ghostty_row_get(row, data, out + 8);
    return this.view().getUint32(out + 8, true);
  }

  private readCell(ref: number, withStyle = true): Cell {
    const out = this.scratch + 768;
    const view = this.view();
    if (this.e.ghostty_grid_ref_cell(ref, out) !== SUCCESS) return { text: "", wide: false, spacer: false, style: null, link: null };
    const cell = view.getBigUint64(out, true);
    const value = (data: number) => {
      view.setUint32(out + 8, 0, true);
      this.e.ghostty_cell_get(cell, data, out + 8);
      return view.getUint32(out + 8, true);
    };
    const wide = value(CELL_WIDE);
    let text = "";
    const codepoint = value(CELL_CODEPOINT);
    const tag = value(CELL_CONTENT_TAG);
    if (tag === CONTENT_GRAPHEME) text = this.graphemes(ref);
    else if (codepoint) text = String.fromCodePoint(codepoint);
    const styled = withStyle && (value(CELL_HAS_STYLING) & 0xff) !== 0;
    const linked = withStyle && (value(CELL_HAS_HYPERLINK) & 0xff) !== 0;
    let style: Style | null = null;
    if (styled) {
      const at = this.scratch + 1024;
      view.setUint32(at, this.layout.GhosttyStyle.size, true);
      if (this.e.ghostty_grid_ref_style(ref, at) === SUCCESS) style = this.readStyle(at);
    }
    if (withStyle && !style && (tag === CONTENT_BG_PALETTE || tag === CONTENT_BG_RGB)) {
      view.setUint32(out + 8, 0, true);
      this.e.ghostty_cell_get(cell, tag === CONTENT_BG_PALETTE ? CELL_COLOR_PALETTE : CELL_COLOR_RGB, out + 8);
      const bg: Color = tag === CONTENT_BG_PALETTE ? { palette: view.getUint8(out + 8) } : { rgb: [view.getUint8(out + 8), view.getUint8(out + 9), view.getUint8(out + 10)] };
      style = { ...BLANK_STYLE, bg };
    }
    return {
      text,
      wide: wide === WIDE_WIDE,
      spacer: wide === WIDE_SPACER_TAIL || wide === WIDE_SPACER_HEAD,
      style,
      link: linked ? this.hyperlink(ref) : null,
    };
  }

  private graphemes(ref: number): string {
    const buf = this.scratch + 1280;
    const len = this.scratch + 1276;
    const result = this.e.ghostty_grid_ref_graphemes(ref, buf, 64, len);
    if (result !== SUCCESS) return "";
    const view = this.view();
    const count = view.getUint32(len, true);
    let text = "";
    for (let i = 0; i < count; i++) text += String.fromCodePoint(view.getUint32(buf + i * 4, true));
    return text;
  }

  private hyperlink(ref: number): string | null {
    const len = this.scratch + 1276;
    const result = this.e.ghostty_grid_ref_hyperlink_uri(ref, 0, 0, len);
    const size = this.view().getUint32(len, true);
    if (result !== OUT_OF_SPACE || !size) return null;
    const buf = this.e.ghostty_wasm_alloc(size);
    try {
      if (this.e.ghostty_grid_ref_hyperlink_uri(ref, buf, size, len) !== SUCCESS) return null;
      return Buffer.from(this.bytes().subarray(buf, buf + size)).toString("utf8");
    } finally {
      this.e.ghostty_wasm_free(buf, size);
    }
  }

  private readStyle(at: number): Style {
    const view = this.view();
    const color = (name: string): Color => {
      const base = at + this.field("GhosttyStyle", name);
      const tag = view.getUint32(base, true);
      const value = base + this.field("GhosttyStyleColor", "value");
      if (tag === 1) return { palette: view.getUint8(value) };
      if (tag === 2) return { rgb: [view.getUint8(value), view.getUint8(value + 1), view.getUint8(value + 2)] };
      return null;
    };
    const flag = (name: string) => view.getUint8(at + this.field("GhosttyStyle", name)) !== 0;
    return {
      fg: color("fg_color"),
      bg: color("bg_color"),
      underlineColor: color("underline_color"),
      bold: flag("bold"),
      italic: flag("italic"),
      faint: flag("faint"),
      blink: flag("blink"),
      inverse: flag("inverse"),
      invisible: flag("invisible"),
      strikethrough: flag("strikethrough"),
      overline: flag("overline"),
      underline: view.getInt32(at + this.field("GhosttyStyle", "underline"), true),
    };
  }
}

const BLANK_STYLE: Style = { fg: null, bg: null, underlineColor: null, bold: false, italic: false, faint: false, blink: false, inverse: false, invisible: false, strikethrough: false, overline: false, underline: 0 };

const SGR_UNDERLINE = ["24", "4", "4:2", "4:3", "4:4", "4:5"];

function sgrColor(color: Color, base: number, extended: number): string | null {
  if (!color) return null;
  if ("rgb" in color) return `${extended};2;${color.rgb.join(";")}`;
  if (color.palette < 8 && base) return String(base + color.palette);
  if (color.palette < 16 && base) return String(base + 60 + color.palette - 8);
  return `${extended};5;${color.palette}`;
}

export function sgr(style: Style | null): string {
  const parts = ["0"];
  if (style) {
    if (style.bold) parts.push("1");
    if (style.faint) parts.push("2");
    if (style.italic) parts.push("3");
    if (style.underline > 0) parts.push(SGR_UNDERLINE[style.underline] ?? "4");
    if (style.blink) parts.push("5");
    if (style.inverse) parts.push("7");
    if (style.invisible) parts.push("8");
    if (style.strikethrough) parts.push("9");
    if (style.overline) parts.push("53");
    const fg = sgrColor(style.fg, 30, 38);
    const bg = sgrColor(style.bg, 40, 48);
    const underline = sgrColor(style.underlineColor, 0, 58);
    if (fg) parts.push(fg);
    if (bg) parts.push(bg);
    if (underline) parts.push(underline);
  }
  return `\x1b[${parts.join(";")}m`;
}

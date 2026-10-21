#!/usr/bin/env node

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";

const PACKAGE = path.resolve(__dirname, "..");
const BIN = path.join(path.dirname(require.resolve("@zenbu-labs/pixel/package.json")), "dist", "bin.js");
const IMAGE_ID = 0x7e43;
const DEFAULT_ROWS = 16;
const REPLY_TIMEOUT_MS = 300;
const LONE_ESCAPE_MS = 30;

const PLACEHOLDER = "\u{10EEEE}";
const ROW_COLUMN_DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a,
  0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365,
  0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f,
  0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
  0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9,
  0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
  0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6,
  0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2,
  0x06e4, 0x06e7, 0x06e8, 0x06eb, 0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736,
  0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747, 0x0749, 0x074a,
  0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817,
  0x0818, 0x0819, 0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822,
  0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a, 0x082b, 0x082c, 0x082d, 0x0951,
  0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd,
  0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c,
  0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1,
  0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5, 0x1dc6,
  0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5,
  0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf,
  0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0, 0x20d1,
  0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0,
  0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6,
  0x2de7, 0x2de8, 0x2de9, 0x2dea, 0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0,
  0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa,
  0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1,
  0xa8e0, 0xa8e1, 0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9,
  0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2,
  0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23,
  0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189,
  0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
].map((c) => String.fromCodePoint(c));

type Mods = { shift: boolean; alt: boolean; ctrl: boolean; super: boolean };
type Grid = { imageId: number; cols: number; rows: number };
type Message = Record<string, unknown>;

const NO_MODS: Mods = { shift: false, alt: false, ctrl: false, super: false };

function write(text: string) {
  fs.writeSync(1, text);
}

function usage(): never {
  process.stderr.write("usage: inline-player <video> [--rows N]\n");
  process.exit(2);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let rows = DEFAULT_ROWS;
  let video: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rows") rows = Number(args[++i]);
    else video = args[i];
  }
  if (!video || !Number.isInteger(rows) || rows < 4) usage();
  if (!fs.existsSync(video)) {
    process.stderr.write(`inline-player: no such file ${video}\n`);
    process.exit(1);
  }
  return { video: path.resolve(video), rows };
}

function ttyName() {
  return fs.readlinkSync("/proc/self/fd/0");
}

let replySink: ((data: Buffer) => void) | null = null;

function ask(query: string, reply: RegExp): Promise<RegExpExecArray | null> {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => finish(null), REPLY_TIMEOUT_MS);
    const finish = (match: RegExpExecArray | null) => {
      clearTimeout(timer);
      replySink = null;
      resolve(match);
    };
    replySink = (data) => {
      buf += data.toString("latin1");
      const match = reply.exec(buf);
      if (match) finish(match);
    };
    write(query);
  });
}

async function cellSize(): Promise<[number, number]> {
  const cell = await ask("\x1b[16t", /\x1b\[6;(\d+);(\d+)t/);
  if (cell) return [Number(cell[2]), Number(cell[1])];
  const window = await ask("\x1b[14t", /\x1b\[4;(\d+);(\d+)t/);
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  if (window) return [Math.floor(Number(window[2]) / cols), Math.floor(Number(window[1]) / rows)];
  return [10, 20];
}

async function colors() {
  const found: Record<string, number[]> = {};
  for (const [slot, name] of [["10", "foreground"], ["11", "background"]]) {
    const m = await ask(`\x1b]${slot};?\x1b\\`, new RegExp(`\\x1b\\]${slot};rgb:([0-9a-fA-F]+)/([0-9a-fA-F]+)/([0-9a-fA-F]+)`));
    if (m) found[name] = [...m.slice(1, 4).map((part) => parseInt(part.slice(0, 2), 16)), 255];
  }
  return Object.keys(found).length ? found : null;
}

async function cursorRow(): Promise<number> {
  const m = await ask("\x1b[6n", /\x1b\[(\d+);(\d+)R/);
  return m ? Number(m[1]) - 1 : 0;
}

function sequenceLength(b: Buffer): number {
  if (b.length < 2) return 0;
  if (b[1] === 0x5b) {
    for (let i = 2; i < b.length; i++) if (b[i] >= 0x40 && b[i] <= 0x7e) return i + 1;
    return 0;
  }
  if (b[1] === 0x5d) {
    for (let i = 2; i < b.length; i++) {
      if (b[i] === 0x07) return i + 1;
      if (b[i] === 0x1b && b[i + 1] === 0x5c) return i + 2;
    }
    return 0;
  }
  if (b[1] === 0x4f) return b.length >= 3 ? 3 : 0;
  return 2;
}

class InlineHost {
  conn: Socket | null = null;
  child: ChildProcess | null = null;
  grid: Grid | null = null;
  buf = Buffer.alloc(0);
  lineBuf = Buffer.alloc(0);
  loneEscape: NodeJS.Timeout | null = null;
  pointerInApp = false;
  cell: [number, number] = [10, 20];
  colors: Record<string, number[]> | null = null;
  pixelMouse = false;
  row0 = 0;
  stopped = false;
  sockPath = path.join(os.tmpdir(), `inline-player-${process.pid}.sock`);

  constructor(readonly video: string, readonly rows: number) {}

  region() {
    return { row0: this.row0, cols: process.stdout.columns || 80, rows: this.rows };
  }

  sizeMessage(type: string): Message {
    const r = this.region();
    return { type, cols: r.cols, rows: r.rows, width: r.cols * this.cell[0], height: r.rows * this.cell[1], cell: [...this.cell] };
  }

  send(message: Message) {
    this.conn?.write(JSON.stringify(message) + "\n");
  }

  printPlaceholders() {
    if (!this.grid) return;
    const r = this.region();
    const cols = Math.min(this.grid.cols, r.cols, ROW_COLUMN_DIACRITICS.length);
    const rows = Math.min(this.grid.rows, r.rows, ROW_COLUMN_DIACRITICS.length);
    const id = this.grid.imageId;
    const out = [`\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`];
    for (let row = 0; row < rows; row++) {
      out.push(`\x1b[${r.row0 + row + 1};1H`);
      for (let col = 0; col < cols; col++) out.push(PLACEHOLDER + ROW_COLUMN_DIACRITICS[row] + ROW_COLUMN_DIACRITICS[col]);
    }
    out.push(`\x1b[39m\x1b[${r.row0 + 1};1H`);
    write(out.join(""));
  }

  handleAppLine(line: Buffer) {
    let message: Message;
    try {
      message = JSON.parse(line.toString("utf8")) as Message;
    } catch {
      return;
    }
    if (message.type === "join") {
      this.send({ ...this.sizeMessage("init"), imageId: IMAGE_ID, transport: "file", focused: true, ...(this.colors ? { colors: this.colors } : {}) });
    } else if (message.type === "placed") {
      this.grid = message as unknown as Grid;
      this.printPlaceholders();
    } else if (message.type === "pointer" && typeof message.shape === "string") {
      write(`\x1b]22;${message.shape}\x1b\\`);
    }
  }

  key(key: string, text?: string, mods: Partial<Mods> = {}) {
    this.send({ type: "key", key, kind: "press", mods: { ...NO_MODS, ...mods }, ...(text !== undefined ? { text } : {}) });
  }

  mouse(seq: string) {
    const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
    if (!m) return;
    const b = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    const r = this.region();
    const [cw, ch] = this.cell;
    let px: number;
    let py: number;
    if (this.pixelMouse) {
      px = x - 1;
      py = y - 1 - r.row0 * ch;
    } else {
      px = (x - 1) * cw + cw / 2;
      py = (y - 1 - r.row0) * ch + ch / 2;
    }
    const inside = px >= 0 && px < r.cols * cw && py >= 0 && py < r.rows * ch;
    if (this.pointerInApp && !inside) write("\x1b]22;default\x1b\\");
    this.pointerInApp = inside;
    if (!inside) return;
    const mods = { shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16), super: false };
    let kind: string;
    let button: string;
    if (b & 64) {
      kind = (b & 3) === 0 ? "scrollup" : "scrolldown";
      button = "none";
    } else if (b & 32) {
      kind = "move";
      button = "none";
    } else {
      kind = m[4] === "M" ? "down" : "up";
      button = ["left", "middle", "right", "none"][b & 3];
    }
    this.send({ type: "mouse", kind, button, mods, x: px, y: py });
  }

  handleSequence(seq: Buffer) {
    const s = seq.toString("latin1");
    if (s.startsWith("\x1b[<")) return this.mouse(s);
    const cursor = /^\x1b\[(\d+);(\d+)R$/.exec(s);
    if (cursor) {
      this.row0 = Number(cursor[1]) - 1;
      this.send(this.sizeMessage("size"));
      return;
    }
    const csi = /^\x1b\[(\d*)(?:;(\d+))?([A-Za-z~])$/.exec(s);
    if (csi) {
      const arrows: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
      if (arrows[csi[3]]) return this.key(arrows[csi[3]]);
      if (csi[3] === "~" && csi[1] === "3") return this.key("delete");
    }
  }

  handleInput(data: Buffer) {
    if (this.loneEscape) {
      clearTimeout(this.loneEscape);
      this.loneEscape = null;
    }
    this.buf = Buffer.concat([this.buf, data]);
    while (this.buf.length) {
      const b = this.buf;
      if (b[0] === 0x1b) {
        const len = sequenceLength(b);
        if (len === 0) {
          this.loneEscape = setTimeout(() => {
            this.loneEscape = null;
            this.buf = this.buf.subarray(1);
            this.key("escape");
            this.handleInput(Buffer.alloc(0));
          }, LONE_ESCAPE_MS);
          return;
        }
        this.buf = b.subarray(len);
        this.handleSequence(b.subarray(0, len));
        continue;
      }
      const ch = b[0];
      this.buf = b.subarray(1);
      if (ch === 0x03) return this.stop();
      if (ch === 0x0d) this.key("enter");
      else if (ch === 0x7f) this.key("backspace");
      else if (ch === 0x09) this.key("tab");
      else if (ch >= 1 && ch <= 26) this.key(String.fromCharCode(ch + 96), undefined, { ctrl: true });
      else {
        const stop = b.indexOf(0x1b);
        const plain = stop === -1 ? b : b.subarray(0, stop);
        const text = plain.toString("utf8");
        for (const c of text) this.key(c, c, { shift: c !== c.toLowerCase() });
        this.buf = b.subarray(plain.length);
      }
    }
  }

  async run() {
    if (!process.stdin.isTTY) usage();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => (replySink ? replySink(data) : this.handleInput(data)));

    this.cell = await cellSize();
    this.colors = await colors();
    this.pixelMouse = (await ask("\x1b[?1016$p", /\x1b\[\?1016;([12])\$y/)) !== null;

    // Newlines scroll the terminal when the prompt is near the bottom, so the reserved rows always fit.
    write("\n".repeat(this.rows) + `\x1b[${this.rows}A\r`);
    this.row0 = await cursorRow();
    write("\x1b[?25l\x1b[?1003h\x1b[?1006h" + (this.pixelMouse ? "\x1b[?1016h" : ""));

    if (fs.existsSync(this.sockPath)) fs.unlinkSync(this.sockPath);
    const server = net.createServer((conn) => {
      this.conn = conn;
      conn.on("data", (data: Buffer) => {
        this.lineBuf = Buffer.concat([this.lineBuf, data]);
        let at = this.lineBuf.indexOf(0x0a);
        while (at !== -1) {
          const line = this.lineBuf.subarray(0, at);
          this.lineBuf = this.lineBuf.subarray(at + 1);
          this.handleAppLine(line);
          at = this.lineBuf.indexOf(0x0a);
        }
      });
      conn.on("error", () => {});
      conn.on("close", () => this.stop());
    });
    server.listen(this.sockPath);

    const env: NodeJS.ProcessEnv = { ...process.env, PIXEL_EMBED: this.sockPath, PIXEL_TTY: ttyName(), EMBED_GATE_QUIET_MS: "0" };
    delete env.PIXEL_PANE;
    const log = fs.openSync(path.join(os.tmpdir(), "inline-player.stderr.log"), "a");
    this.child = spawn(process.execPath, [BIN, PACKAGE, "--", this.video], { env, stdio: ["ignore", "ignore", log] });
    this.child.on("exit", () => this.stop());

    process.on("SIGWINCH", () => {
      this.grid = null;
      write(`\x1b[${this.row0 + 1};1H\x1b[J\x1b[6n`);
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => this.stop());
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
    write(`\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b]22;default\x1b\\\x1b[${this.row0 + 1};1H\x1b[J\x1b[?25h`);
    try {
      process.stdin.setRawMode(false);
    } catch {}
    try {
      fs.unlinkSync(this.sockPath);
    } catch {}
    process.exit(0);
  }
}

const { video, rows } = parseArgs();
void new InlineHost(video, rows).run();

#!/usr/bin/env node

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, "..");
const ROOT = path.resolve(PACKAGE, "..", "..");
const BIN = path.join(ROOT, "packages", "pixel", "dist", "bin.js");
const APP = path.join(ROOT, "examples", "hello");
const COMMAND = process.argv.slice(2).length ? process.argv.slice(2) : ["node", BIN, APP];
const IMAGE_ID = 0x7e42;
const SIDEBAR = 28;

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

const EMPTY = Buffer.alloc(0);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

type Mods = { shift: boolean; alt: boolean; ctrl: boolean; super: boolean };
type Grid = { imageId: number; cols: number; rows: number };
type Message = Record<string, unknown>;

function winsize() {
  return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function write(s: string | Buffer) {
  const data = typeof s === "string" ? Buffer.from(s) : s;
  let written = 0;
  while (written < data.length) {
    try {
      written += fs.writeSync(1, data, written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      Atomics.wait(SLEEP_CELL, 0, 0, 2);
    }
  }
}


function sequenceLength(b: Buffer) {
  if (b.length < 2) return 0;
  const kind = b[1];
  if (kind === 0x5b) {
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
  return 1;
}

const INCOMPLETE_WAIT_MS = 100;

let sink: ((data: Buffer) => void) | null = null;

function readReply(done: (buf: Buffer) => boolean, timeout = 300): Promise<Buffer> {
  return new Promise((resolve) => {
    const previous = sink;
    let buf = EMPTY;
    let timer: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(timer);
      sink = previous;
      resolve(buf);
    };
    timer = setTimeout(finish, timeout);
    sink = (data) => {
      buf = Buffer.concat([buf, data]);
      clearTimeout(timer);
      if (done(buf)) return finish();
      timer = setTimeout(finish, timeout);
    };
  });
}

async function supportsPixelMouse() {
  write("\x1b[?1016$p");
  const buf = await readReply((b) => b.includes("$y"));
  return /\x1b\[\?1016;([12])\$y/.test(buf.toString("latin1"));
}

async function queryCellSize(): Promise<[number, number, boolean]> {
  write("\x1b[16t");
  const cell = await readReply((b) => b.includes("t"));
  const m = /\x1b\[6;(\d+);(\d+)t/.exec(cell.toString("latin1"));
  if (m) return [Number(m[2]), Number(m[1]), true];
  write("\x1b[14t");
  const window = await readReply((b) => b.includes("t"));
  const w = /\x1b\[4;(\d+);(\d+)t/.exec(window.toString("latin1"));
  const { rows, cols } = winsize();
  if (w && rows && cols) return [Math.floor(Number(w[2]) / cols), Math.floor(Number(w[1]) / rows), false];
  return [10, 20, false];
}

async function queryColors() {
  write("\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
  const buf = await readReply((b) => b.toString("latin1").split("rgb:").length > 2);
  const text = buf.toString("latin1");
  const colors: Record<string, number[]> = {};
  for (const [slot, name] of [["10", "foreground"], ["11", "background"]]) {
    const m = new RegExp(`\\x1b\\]${slot};rgb:([0-9a-fA-F]+)/([0-9a-fA-F]+)/([0-9a-fA-F]+)`).exec(text);
    if (m) colors[name] = [...m.slice(1, 4).map((part) => parseInt(part.slice(0, 2), 16)), 255];
  }
  return Object.keys(colors).length ? colors : null;
}

function ttyName() {
  try {
    return fs.readlinkSync("/proc/self/fd/0");
  } catch {
    return execFileSync("tty", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
  }
}

function isUpper(c: string) {
  return c !== c.toLowerCase() && c === c.toUpperCase();
}

function pad(text: string, width: number) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

class Host {
  title = "starting";
  conn: Socket | null = null;
  grid: Grid | null = null;
  child: ChildProcess | null = null;
  buf = EMPTY;
  lineBuf = EMPTY;
  pointerInApp = false;
  sockPath = `/tmp/tui-host-${process.pid}.sock`;
  cell: [number, number] = [10, 20];
  transport = "inline";
  colors: Record<string, number[]> | null = null;
  pixelMouse = false;
  stopped = false;

  region() {
    // interesting, there is an obvious rase case potential here
    const { rows, cols } = winsize();
    const col0 = SIDEBAR + 1;
    return { col0, row0: 1, cols: Math.max(1, cols - col0), rows: Math.max(1, rows - 2) };
  }

  drawSidebar() {
    const { rows } = winsize();
    const lines = [
      " ctrl+c  quit",
      " ctrl+d  engine devtools",
    ];
    for (let r = 0; r < rows; r++) {
      const text = r < lines.length ? lines[r] : "";
      write(`\x1b[${r + 1};1H\x1b[0m${pad(text, SIDEBAR)}\x1b[2m|\x1b[0m`);
    }
    write(`\x1b[${rows};${SIDEBAR + 2}H\x1b[2m image id ${IMAGE_ID}, ${this.transport} frames\x1b[0m`);
  }

  printPlaceholders() {
    if (!this.grid) return;
    const r = this.region();
    const cols = Math.min(this.grid.cols, r.cols, ROW_COLUMN_DIACRITICS.length);
    const rows = Math.min(this.grid.rows, r.rows, ROW_COLUMN_DIACRITICS.length);
    const image = this.grid.imageId;
    const fg = `\x1b[38;2;${(image >> 16) & 255};${(image >> 8) & 255};${image & 255}m`;
    const out: string[] = [];
    for (let row = 0; row < rows; row++) {
      out.push(`\x1b[${r.row0 + row + 1};${r.col0 + 1}H${fg}`);
      for (let col = 0; col < cols; col++) {
        out.push(PLACEHOLDER + ROW_COLUMN_DIACRITICS[row] + ROW_COLUMN_DIACRITICS[col]);
      }
    }
    out.push("\x1b[39m");
    write(out.join(""));
  }

  send(message: Message) {
    if (!this.conn) return;
    try {
      this.conn.write(JSON.stringify(message) + "\n");
    } catch { }
  }

  sizeMessage(kind: string): Message {
    const r = this.region();
    return {
      type: kind,
      cols: r.cols,
      rows: r.rows,
      width: r.cols * this.cell[0],
      height: r.rows * this.cell[1],
      cell: [...this.cell],
    };
  }


  resized() {
    this.grid = null;
    write("\x1b[2J");
    this.drawSidebar();
    write("\x1b[16t");
    this.send(this.sizeMessage("size"));
  }

  cellReply(w: number, h: number) {
    if (w === this.cell[0] && h === this.cell[1]) return;
    this.cell = [w, h];
    this.grid = null;
    this.send(this.sizeMessage("size"));
  }

  handleAppLine(line: Buffer) {
    let message: Message;
    try {
      message = JSON.parse(line.toString());
    } catch {
      return;
    }
    const kind = message.type;
    if (kind === "join") {
      const init = this.sizeMessage("init");
      Object.assign(init, { cell: [...this.cell], imageId: IMAGE_ID, transport: this.transport, focused: true });
      if (this.colors) init.colors = this.colors;
      this.send(init);
    } else if (kind === "placed") {
      this.grid = message as unknown as Grid;
      this.printPlaceholders();
    } else if (kind === "title") {
      this.title = (message.text as string) || this.title;
      this.drawSidebar();
    }
  }

  key(name: string, text?: string, mods: Partial<Mods> = {}) {
    const m: Mods = { shift: false, alt: false, ctrl: false, super: false, ...mods };
    const event: Message = { type: "key", key: name, kind: "press", mods: m };
    if (text !== undefined) event.text = text;
    this.send(event);
  }

  mouse(seq: string) {
    const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(seq);
    if (!m) return;
    const b = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    const kind = m[4];
    const r = this.region();
    let px: number;
    let py: number;
    let inside: boolean;
    if (this.pixelMouse) {
      px = x - 1 - r.col0 * this.cell[0];
      py = y - 1 - r.row0 * this.cell[1];
      inside = px >= 0 && px < r.cols * this.cell[0] && py >= 0 && py < r.rows * this.cell[1];
    } else {
      const cx = x - 1 - r.col0;
      const cy = y - 1 - r.row0;
      inside = cx >= 0 && cx < r.cols && cy >= 0 && cy < r.rows;
      px = cx * this.cell[0] + Math.floor(this.cell[0] / 2);
      py = cy * this.cell[1] + Math.floor(this.cell[1] / 2);
    }
    if (this.pointerInApp && !inside) {
      // the app may have set a pointer shape for what it was hovering
      write("\x1b]22;default\x1b\\");
    }
    this.pointerInApp = inside;
    if (!inside) return;
    const mods: Mods = { shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16), super: false };
    let action: string;
    let button: string;
    if (b & 64) {
      action = (b & 3) === 0 ? "scrollup" : "scrolldown";
      button = "none";
    } else if (b & 32) {
      action = "move";
      button = "none";
    } else {
      action = kind === "M" ? "down" : "up";
      button = ["left", "middle", "right", "none"][b & 3];
    }
    this.send({ type: "mouse", kind: action, button, mods, x: px, y: py });
  }

  incompleteTimer: NodeJS.Timeout | null = null;

  handleInput(data: Buffer) {
    if (this.incompleteTimer) {
      clearTimeout(this.incompleteTimer);
      this.incompleteTimer = null;
    }
    this.buf = Buffer.concat([this.buf, data]);
    while (this.buf.length) {
      const b = this.buf;
      if (b[0] === 0x1b) {
        if (b.length === 1) {
          this.key("escape");
          this.buf = EMPTY;
          return;
        }
        const len = sequenceLength(b);
        if (len === 0) {
          this.incompleteTimer = setTimeout(() => {
            this.incompleteTimer = null;
            this.buf = this.buf.subarray(1);
            this.handleInput(EMPTY);
          }, INCOMPLETE_WAIT_MS);
          return;
        }
        this.buf = b.subarray(len);
        if (len > 1) this.handleSequence(b.subarray(0, len));
        continue;
      }
      const ch = b[0];
      if (ch === 0x03) {
        this.stop();
        return;
      }
      if (ch === 0x04) {
        this.send({ type: "devtools" });
        this.buf = b.subarray(1);
        continue;
      }
      if (ch === 0x0d) this.key("enter");
      else if (ch === 0x7f) this.key("backspace");
      else if (ch === 0x09) this.key("tab");
      else if (ch >= 1 && ch <= 26) this.key(String.fromCharCode(ch + 96), undefined, { ctrl: true });
      else {
        const stop = b.indexOf(0x1b);
        const plain = stop === -1 ? b : b.subarray(0, stop);
        let text: string;
        try {
          text = UTF8.decode(plain);
        } catch {
          this.buf = b.subarray(1);
          continue;
        }
        for (const c of text) this.key(c, c, { shift: isUpper(c) });
        this.buf = b.subarray(plain.length);
        continue;
      }
      this.buf = b.subarray(1);
    }
  }

  handleSequence(seq: Buffer) {
    const s = seq.toString("latin1");
    const cellSize = /^\x1b\[6;(\d+);(\d+)t$/.exec(s);
    if (cellSize) {
      this.cellReply(Number(cellSize[2]), Number(cellSize[1]));
      return;
    }
    if (s.startsWith("\x1b[<")) {
      this.mouse(s);
      return;
    }
    const csi = /^\x1b\[(\d*)(?:;(\d+))?([A-Za-z~])$/.exec(s);
    if (csi) {
      const [, num, , final] = csi;
      const arrows: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
      if (arrows[final]) return this.key(arrows[final]);
      if (final === "~" && num === "3") return this.key("delete");
    }
  }

  async run() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => sink?.(data));
    const [cellW, cellH, answered] = await queryCellSize();
    this.cell = [cellW, cellH];
    this.transport = answered ? "file" : "inline";
    this.colors = await queryColors();
    this.pixelMouse = await supportsPixelMouse();
    write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1003h\x1b[?1006h" + (this.pixelMouse ? "\x1b[?1016h" : ""));
    this.drawSidebar();
    sink = (data) => this.handleInput(data);

    if (fs.existsSync(this.sockPath)) fs.unlinkSync(this.sockPath);
    const server = net.createServer((conn) => {
      this.conn = conn;
      this.lineBuf = EMPTY;
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
      conn.on("error", () => { });
      conn.on("close", () => {
        if (this.conn === conn) this.stop();
      });
    });
    server.listen(this.sockPath);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PIXEL_EMBED: this.sockPath,
      PIXEL_TTY: ttyName(),
      EMBED_GATE_QUIET_MS: "0",
    };
    delete env.PIXEL_PANE;
    const log = fs.openSync(path.join(PACKAGE, "app.stderr.log"), "a");
    this.child = spawn(COMMAND[0], COMMAND.slice(1), { env, stdio: ["ignore", "ignore", log] });
    this.child.on("exit", () => this.stop());

    let pendingResize = false;
    process.on("SIGWINCH", () => {
      pendingResize = true;
    });
    setInterval(() => {
      if (!pendingResize) return;
      pendingResize = false;
      this.resized();
    }, 200).unref();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => this.stop());
    process.on("uncaughtException", (error) => this.stop(error));
  }

  stop(error?: unknown) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
    write("\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l");
    try {
      process.stdin.setRawMode(false);
    } catch { }
    try {
      fs.unlinkSync(this.sockPath);
    } catch { }
    if (error !== undefined) {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    }
    process.exit(0);
  }
}

new Host().run();

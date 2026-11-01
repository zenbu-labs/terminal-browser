import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { KeyEvent, KeyMods } from "./input";
import { logError, trace } from "../log";
import type { FromView, ToView } from "../protocol";

const PIXEL_ROOT = path.join(__dirname, "..", "..", "..", "..");
const PIXEL_BIN = path.join(PIXEL_ROOT, "packages", "pixel", "dist", "bin.js");
const VIEW_APP = path.join(__dirname, "..", "..");
const LOG = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "pxsh", "view.stderr.log");

export interface Frame {
  shm: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

interface PaneSize {
  cols: number;
  rows: number;
  cell: { width: number; height: number };
}

export type Rgba = [number, number, number, number];

function lines(socket: net.Socket, onLine: (message: Record<string, unknown>) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        onLine(JSON.parse(line) as Record<string, unknown>);
      } catch {}
    }
  });
  socket.on("error", () => {});
}

export function transmitFrame(frame: Frame, imageId: number): string {
  const name = Buffer.from(frame.shm).toString("base64");
  return `\x1b_Ga=T,f=32,s=${frame.width},v=${frame.height},t=s,i=${imageId},U=1,c=${frame.cols},r=${frame.rows},q=2;${name}\x1b\\`;
}

export class PixelView {
  readonly imageId = 0x500000 | (process.pid & 0xffff);
  onFrame: ((frame: Frame) => void) | null = null;
  onMessage: ((message: FromView) => void) | null = null;
  onPointer: ((shape: string) => void) | null = null;
  onClipboard: ((text: string) => void) | null = null;
  onExit: (() => void) | null = null;
  ready = false;
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-view-"));
  private engine: net.Socket | null = null;
  private view: net.Socket | null = null;
  private child: ChildProcess | null = null;
  private servers: net.Server[] = [];
  private queued: ToView[] = [];

  constructor(
    private size: PaneSize,
    private colors: { foreground: Rgba | null; background: Rgba | null; palette: (Rgba | null)[] },
  ) {}

  static available(): boolean {
    return fs.existsSync(PIXEL_BIN) && fs.existsSync(path.join(VIEW_APP, "dist", "view.js"));
  }

  start(): void {
    const embedPath = path.join(this.dir, "embed.sock");
    const viewPath = path.join(this.dir, "view.sock");
    this.servers.push(
      net.createServer((socket) => {
        this.engine = socket;
        lines(socket, (message) => this.engineMessage(message));
        socket.on("close", () => this.exited());
      }),
      net.createServer((socket) => {
        this.view = socket;
        lines(socket, (message) => this.onMessage?.(message as unknown as FromView));
        for (const message of this.queued.splice(0)) this.send(message);
      }),
    );
    this.servers[0].listen(embedPath);
    this.servers[1].listen(viewPath);
    const env: NodeJS.ProcessEnv = { ...process.env, PIXEL_EMBED: embedPath, PXSH_SOCKET: viewPath, PIXEL_TTY: "/dev/null", NODE_ENV: "production" };
    delete env.PIXEL_PANE;
    for (const name of Object.keys(env)) if (name.startsWith("PXSH_") && name !== "PXSH_SOCKET" && name !== "PXSH_TRACE") delete env[name];
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const log = fs.openSync(LOG, "a");
    this.child = spawn(process.execPath, [PIXEL_BIN, VIEW_APP], { env, stdio: ["ignore", "ignore", log], detached: false });
    fs.closeSync(log);
    this.child.on("error", (error) => {
      logError(error);
      this.exited();
    });
    this.child.on("exit", () => this.exited());
  }

  stop(): void {
    this.child?.kill("SIGTERM");
    for (const server of this.servers) server.close();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  send(message: ToView): void {
    if (!this.view) {
      if (message.type === "state") this.queued = this.queued.filter((q) => q.type !== "state");
      this.queued.push(message);
      return;
    }
    this.view.write(JSON.stringify(message) + "\n");
  }

  private engineSend(message: Record<string, unknown>): void {
    this.engine?.write(JSON.stringify(message) + "\n");
  }

  private sizeMessage(type: "size" | "init"): Record<string, unknown> {
    const { cols, rows, cell } = this.size;
    return { type, cols, rows, width: cols * cell.width, height: rows * cell.height, cell: [cell.width, cell.height] };
  }

  private engineMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "join":
        this.engineSend({ ...this.sizeMessage("init"), imageId: this.imageId, transport: "host", focused: true, colors: this.colors });
        this.ready = true;
        trace("view joined");
        break;
      case "frame":
        this.onFrame?.(message as unknown as Frame);
        break;
      case "pointer":
        if (typeof message.shape === "string") this.onPointer?.(message.shape);
        break;
      case "clipboard":
        if (typeof message.text === "string") this.onClipboard?.(message.text);
        break;
    }
  }

  resize(size: PaneSize): void {
    this.size = size;
    if (this.ready) this.engineSend(this.sizeMessage("size"));
  }

  setColors(colors: PixelView["colors"]): void {
    this.colors = colors;
    if (this.ready) this.engineSend({ type: "colors", colors });
  }

  key(event: KeyEvent): void {
    this.engineSend({ type: "key", key: event.key, kind: event.kind, mods: event.mods, ...(event.text != null ? { text: event.text } : {}) });
  }

  paste(text: string): void {
    this.engineSend({ type: "paste", text });
  }

  focus(focused: boolean): void {
    this.engineSend({ type: "focus", focused });
  }

  mouse(kind: string, button: string, mods: KeyMods, x: number, y: number): void {
    this.engineSend({ type: "mouse", kind, button, mods, x, y });
  }

  private exited(): void {
    if (!this.ready && !this.child) return;
    this.ready = false;
    this.engine = null;
    this.view = null;
    this.child = null;
    this.onExit?.();
  }
}

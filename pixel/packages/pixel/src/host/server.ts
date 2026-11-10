import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { debug } from "../debug";
import type { EngineKeyEvent, TerminalColors } from "../react";
export interface GuestFrame {
  path: string;
  width: number;
  height: number;
  ack(): void;
}

export interface InitPayload {
  cols: number;
  rows: number;
  width: number;
  height: number;
  colors: TerminalColors;
  focused: boolean;
}

export type GuestMessage =
  | ({ type: "key" } & EngineKeyEvent)
  | { type: "paste"; text: string }
  | {
      type: "mouse";
      kind: "down" | "up" | "move" | "scrollup" | "scrolldown" | "scrollleft" | "scrollright";
      button: "left" | "middle" | "right" | "none";
      mods: EngineKeyEvent["mods"];
      x: number;
      y: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      mods: EngineKeyEvent["mods"];
    }
  | { type: "focus"; focused: boolean }
  | { type: "colors"; colors: TerminalColors }
  | ({ type: "size" } & Pick<InitPayload, "cols" | "rows" | "width" | "height">)
  | ({ type: "init" } & InitPayload)
  | { type: "adopt"; tty: string }
  | { type: "rejoin"; socket: string };

export class Guest {
  title: string | null = null;
  onFrame: ((frame: GuestFrame) => void) | null = null;
  onTitle: ((title: string) => void) | null = null;
  onPointer: ((shape: string) => void) | null = null;
  onClipboard: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;
  private closed = false;
  private departed = false;
  // Nothing may reach the guest before init; its engine reads init first.
  private greeted = false;
  private queued: GuestMessage[] = [];

  constructor(
    readonly pane: string,
    readonly name: string,
    public pid: number,
    // Null while only announced: the app's electron has not joined yet.
    private control: net.Socket | null,
    private announce: net.Socket | null,
  ) {}

  get pending(): boolean {
    return this.control === null;
  }

  attach(control: net.Socket, pid: number) {
    this.control = control;
    if (pid > 0) this.pid = pid;
    this.greeted = false;
    for (const waiting of this.queued.splice(0)) this.send(waiting);
  }

  send(message: GuestMessage) {
    if (this.closed) return;
    if (!this.control) {
      this.queued.push(message);
      return;
    }
    if (!this.greeted) {
      if (message.type !== "init") {
        this.queued.push(message);
        return;
      }
      this.greeted = true;
      this.control.write(`${JSON.stringify(message)}\n`);
      for (const waiting of this.queued.splice(0)) this.send(waiting);
      return;
    }
    this.control.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line: string) {
    let message: { type?: string; text?: string; shape?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    switch (message.type) {
      case "title":
        this.title = message.text ?? null;
        if (this.title != null) this.onTitle?.(this.title);
        break;
      case "pointer":
        if (message.shape) this.onPointer?.(message.shape);
        break;
      case "clipboard":
        if (typeof message.text === "string") this.onClipboard?.(message.text);
        break;
    }
  }

  // Dropping the control connection ends the guest's engine; a guest that
  // still lingers after that gets a signal.
  close() {
    if (this.closed) return;
    this.closed = true;
    this.control?.destroy();
    this.announce?.destroy();
    if (this.pid > 0) {
      setTimeout(() => {
        if (this.departed) return;
        try {
          process.kill(this.pid, "SIGTERM");
        } catch {}
      }, 2000).unref();
    }
  }

  gone() {
    if (this.departed) return;
    this.departed = true;
    this.closed = true;
    this.onClose?.();
  }
}


function frameDirectory(): string {
  const root = path.join(os.tmpdir(), "pixel-frames");
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync(root)) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  }
  const dir = path.join(root, String(process.pid));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

export class OwnerServer {
  readonly frameDir: string;
  onJoin: ((guest: Guest) => void) | null = null;
  private readonly server: net.Server;
  private readonly guests = new Map<string, Guest>();

  constructor(
    readonly socketPath: string,
    private readonly cell: () => { width: number; height: number },
  ) {
    this.frameDir = frameDirectory();
    fs.rmSync(socketPath, { force: true });
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    this.server = net.createServer((connection) => this.serve(connection));
    this.server.on("error", (error) => debug("owner server error", error.message));
    this.server.listen(socketPath);
  }

  stop() {
    for (const guest of this.guests.values()) guest.close();
    this.guests.clear();
    this.server.close();
    fs.rmSync(this.socketPath, { force: true });
    fs.rmSync(this.frameDir, { recursive: true, force: true });
  }

  private serve(connection: net.Socket) {
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    let buffer = "";
    let route: ((line: string) => void) | null = null;
    let owned: Guest | null = null;
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        if (route) {
          route(line);
          continue;
        }
        const opened = this.open(connection, line);
        route = opened.route;
        owned = opened.guest;
      }
    });
    connection.on("close", () => {
      if (owned) {
        debug("guest gone", { pane: owned.pane, name: owned.name });
        this.guests.delete(owned.pane);
        owned.gone();
      }
    });
  }

  private open(
    connection: net.Socket,
    line: string,
  ): { route: (line: string) => void; guest: Guest | null } {
    let opening: {
      id?: string;
      method?: string;
      params?: { pane_id?: string };
      type?: string;
      pane?: string;
      name?: string;
      pid?: number;
    };
    try {
      opening = JSON.parse(line) as typeof opening;
    } catch {
      connection.destroy();
      return { route: () => {}, guest: null };
    }
    if (opening.method === "pane.graphics.info") {
      const cell = this.cell();
      const result = {
        type: "pane_graphics_info",
        cell_width_px: cell.width,
        cell_height_px: cell.height,
        pane_visible: true,
        file_frame_directory: this.frameDir,
        file_frame_formats: ["bgra"],
        file_frame_transport: "direct-kitty",
      };
      connection.end(`${JSON.stringify({ id: opening.id ?? "info", result })}\n`);
      return { route: () => {}, guest: null };
    }
    if (opening.method === "pane.graphics.stream") {
      const pane = opening.params?.pane_id ?? "";
      const id = opening.id ?? "stream";
      connection.write(`${JSON.stringify({ id, result: { type: "ok" } })}\n`);
      const ack = `${JSON.stringify({ id, result: { type: "pane_graphics_frame_ack" } })}\n`;
      return {
        guest: null,
        route: (header) => {
          const guest = this.guests.get(pane);
          let frame: { file?: { path?: string }; image_width?: number; image_height?: number };
          try {
            frame = JSON.parse(header) as typeof frame;
          } catch {
            return;
          }
          const file = frame.file?.path;
          if (!guest?.onFrame || !file || !frame.image_width || !frame.image_height) {
            connection.write(ack);
            return;
          }
          let acked = false;
          guest.onFrame({
            path: file,
            width: frame.image_width,
            height: frame.image_height,
            ack: () => {
              if (acked) return;
              acked = true;
              connection.write(ack);
            },
          });
        },
      };
    }
    const name = typeof opening.name === "string" && opening.name ? opening.name : "app";
    const pid = typeof opening.pid === "number" ? opening.pid : 0;
    if (opening.type === "announce" && typeof opening.pane === "string") {
      if (this.guests.has(opening.pane)) {
        connection.destroy();
        return { route: () => {}, guest: null };
      }
      const guest = new Guest(opening.pane, name, pid, null, connection);
      this.guests.set(guest.pane, guest);
      debug("guest announced", { pane: guest.pane, name });
      this.onJoin?.(guest);
      connection.on("close", () => {
        if (guest.pending) {
          this.guests.delete(guest.pane);
          guest.gone();
        }
      });
      return { route: () => {}, guest: null };
    }
    if (opening.type === "join" && typeof opening.pane === "string") {
      const announced = this.guests.get(opening.pane);
      if (announced) {
        if (!announced.pending) {
          connection.destroy();
          return { route: () => {}, guest: null };
        }
        announced.attach(connection, pid);
        debug("guest joined", { pane: announced.pane, name: announced.name, pid });
        return { route: (line) => announced.handleLine(line), guest: announced };
      }
      const guest = new Guest(opening.pane, name, pid, connection, null);
      this.guests.set(guest.pane, guest);
      debug("guest joined", { pane: guest.pane, name: guest.name, pid: guest.pid });
      this.onJoin?.(guest);
      return { route: (line) => guest.handleLine(line), guest };
    }
    connection.destroy();
    return { route: () => {}, guest: null };
  }
}

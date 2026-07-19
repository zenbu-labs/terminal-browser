import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { BrowserState } from "./chrome";

export const REGISTRY_DIR = path.join(os.homedir(), ".pixel-browser", "instances");

export interface InstanceRecord extends BrowserState {
  tabs?: unknown;
  viewport?: { width: number; height: number } | null;
  pid: number;
  key: string;
  tty: string | null;
  socket: string;
  cdpPort: number | null;
  startedAt: number;
}

export interface ControlHost {
  /** unique per pane: the pid for dedicated processes, pid-session for daemon sessions */
  key: string;
  /** the pane's tty; null falls back to walking this process's ancestry */
  tty: string | null;
  state(): BrowserState;
  openTab(url?: string): void;
  tabs(): unknown;
  viewport(): { width: number; height: number } | null;
}

interface ControlRequest {
  cmd: string;
  url?: string;
}

function ownTty(): string | null {
  let pid = process.pid;
  for (let hops = 0; hops < 20 && pid > 1; hops++) {
    let out: string;
    try {
      out = execFileSync("ps", ["-o", "ppid=,tty=", "-p", String(pid)], {
        encoding: "utf8",
      });
    } catch {
      return null;
    }
    const [ppid, tty] = out.trim().split(/\s+/);
    if (tty && tty !== "??") return `/dev/${tty}`;
    pid = Number(ppid);
    if (!Number.isFinite(pid)) return null;
  }
  return null;
}

export class Registry {
  private readonly host: ControlHost;
  private readonly file: string;
  private readonly socketPath: string;
  private readonly tty: string | null;
  private readonly startedAt = Date.now();
  private cdpPort: number | null = null;
  private server: net.Server | null = null;
  private disposed = false;

  constructor(host: ControlHost) {
    this.host = host;
    this.tty = host.tty ?? ownTty();
    this.file = path.join(REGISTRY_DIR, `${host.key}.json`);
    this.socketPath = path.join(REGISTRY_DIR, `${host.key}.sock`);
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    fs.rmSync(this.socketPath, { force: true });
    this.server = net.createServer((connection) => this.serve(connection));
    this.server.on("error", () => {});
    this.server.listen(this.socketPath);
    this.write();
  }

  setCdpPort(port: number | null) {
    this.cdpPort = port;
    this.write();
  }

  update() {
    this.write();
  }

  record(): InstanceRecord {
    return {
      ...this.host.state(),
      tabs: this.host.tabs(),
      viewport: this.host.viewport(),
      pid: process.pid,
      key: this.host.key,
      tty: this.tty,
      socket: this.socketPath,
      cdpPort: this.cdpPort,
      startedAt: this.startedAt,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.server?.close();
    this.server = null;
    fs.rmSync(this.file, { force: true });
    fs.rmSync(this.socketPath, { force: true });
  }

  private write() {
    if (this.disposed) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.record()));
    } catch {}
  }

  private serve(connection: net.Socket) {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      void this.handle(line)
        .then((data) => {
          connection.end(`${JSON.stringify({ ok: true, data })}\n`);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          connection.end(`${JSON.stringify({ ok: false, error: message })}\n`);
        });
    });
  }

  private async handle(line: string): Promise<unknown> {
    const request = JSON.parse(line) as ControlRequest;
    switch (request.cmd) {
      case "state":
        return this.record();
      case "open-tab":
        this.host.openTab(request.url);
        return this.record();
      default:
        throw new Error(`unknown command: ${request.cmd}`);
    }
  }
}

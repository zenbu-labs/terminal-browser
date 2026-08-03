import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { callerTty } from "pixel-terminals";
import { removeInstance, upsertInstance } from "pixel-store";
import type { InstanceRow } from "pixel-store";

import type { BrowserState } from "./page/types";
import { INSTANCES_DIR } from "pixel-store";

export interface ControlHost {
  key: string;
  tty: string | null;
  splitDir: InstanceRow["splitDir"];
  parentTty: string | null;
  state(): BrowserState;
  openTab(url?: string, cwd?: string): number;
  activateTab(id: number): boolean;
  closeTab(id: number): boolean;
  tabs(): unknown;
  targets(): Promise<unknown>;
  viewport(): { width: number; height: number } | null;
}

interface ControlRequest {
  cmd: string;
  url?: string;
  cwd?: string;
  tab?: number;
}

export class Registry {
  private readonly host: ControlHost;
  private readonly socketPath: string;
  private readonly tty: string | null;
  private readonly startedAt = Date.now();
  private cdpPort: number | null = null;
  private server: net.Server | null = null;
  private disposed = false;

  constructor(host: ControlHost) {
    this.host = host;
    this.tty = host.tty ?? callerTty();
    this.socketPath = path.join(INSTANCES_DIR, `${host.key}.sock`);
    fs.mkdirSync(INSTANCES_DIR, { recursive: true });
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

  record(): InstanceRow {
    return {
      ...this.host.state(),
      tabs: this.host.tabs(),
      viewport: this.host.viewport(),
      pid: process.pid,
      key: this.host.key,
      tty: this.tty,
      splitDir: this.host.splitDir,
      parentTty: this.host.parentTty,
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
    void removeInstance(this.host.key).catch(() => {});
    fs.rmSync(this.socketPath, { force: true });
  }

  private write() {
    if (this.disposed) return;
    void upsertInstance(this.record()).catch(() => {});
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
      case "open-tab": {
        const id = this.host.openTab(request.url, request.cwd);
        return { ...this.record(), openedTab: id, tabs: await this.host.targets() };
      }
      case "targets":
        return { ...this.record(), tabs: await this.host.targets() };
      case "activate-tab": {
        if (request.tab === undefined) throw new Error("activate-tab needs a tab id");
        if (!this.host.activateTab(request.tab)) throw new Error(`no tab ${request.tab}`);
        return { ...this.record(), tabs: await this.host.targets() };
      }
      case "close-tab": {
        if (request.tab === undefined) throw new Error("close-tab needs a tab id");
        if (!this.host.closeTab(request.tab)) throw new Error(`no tab ${request.tab}`);
        return { ...this.record(), tabs: await this.host.targets() };
      }
      default:
        throw new Error(`unknown command: ${request.cmd}`);
    }
  }
}

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { callerTty } from "pixel-terminals";
import {
  INTEROP_PROTOCOL_VERSIONS,
  advertiseInstance,
  openSpecSchema,
  removeInstance,
  upsertInstance,
  withdrawInstance,
} from "pixel-store";
import type { InstanceRow, OpenResult, OpenSpec } from "pixel-store";

import type { BrowserState } from "./page/types";
import { INSTANCES_DIR } from "pixel-store";

export interface Where {
  terminal: string | null;
  tab: string | null;
  pane: string | null;
}

export interface InteropInfo {
  mode: "browser" | "app";
}

export interface ControlHost {
  key: string;
  tty: string | null;
  where(): Promise<Where>;
  splitDir: InstanceRow["splitDir"];
  parentTty: string | null;
  state(): BrowserState;
  interop(): InteropInfo;
  openAppTab(spec: OpenSpec, app: NonNullable<OpenSpec["app"]>): OpenResult;
  openTab(url?: string, cwd?: string): number;
  activateTab(id: number): boolean;
  closeTab(id: number): boolean;
  agentTouch(id: number): boolean;
  agentRelease(): void;
  tabs(): unknown;
  targets(): Promise<unknown>;
  viewport(): { width: number; height: number } | null;
}

interface ControlRequest {
  id?: string;
  cmd: string;
  url?: string;
  cwd?: string;
  tab?: number;
}

export class Registry {
  private readonly host: ControlHost;
  readonly socketPath: string;
  private readonly tty: string | null;
  private readonly startedAt = Date.now();
  private cdpPort: number | null = null;
  private server: net.Server | null = null;
  private disposed = false;

  constructor(host: ControlHost) {
    this.host = host;
    this.tty = host.tty ?? callerTty().path;
    this.socketPath = path.join(INSTANCES_DIR, `${host.key}.sock`);
    fs.mkdirSync(INSTANCES_DIR, { recursive: true });
    fs.rmSync(this.socketPath, { force: true });
    this.server = net.createServer((connection) => this.serve(connection));
    this.server.on("error", () => {});
    this.server.listen(this.socketPath);
    this.write();
    this.advertise();
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
    withdrawInstance(this.host.key);
    fs.rmSync(this.socketPath, { force: true });
  }

  private write() {
    if (this.disposed) return;
    void upsertInstance(this.record()).catch(() => {});
  }

  private advertise() {
    advertiseInstance(this.host.key, {
      protocolVersions: INTEROP_PROTOCOL_VERSIONS,
      mode: this.host.interop().mode,
      pid: process.pid,
      socket: this.socketPath,
      startedAt: this.startedAt,
    });
  }

  private serve(connection: net.Socket) {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim()) void this.dispatch(line, connection);
      }
    });
  }

  private async dispatch(line: string, connection: net.Socket) {
    let id: string | null = null;
    try {
      const request = JSON.parse(line) as ControlRequest;
      id = typeof request.id === "string" && request.id.length > 0 ? request.id : null;
      if (id === null) throw new Error("request id required");
      if (request.cmd === "interop/1/open") {
        const parsed = openSpecSchema.safeParse(request);
        if (!parsed.success) throw new Error("malformed open request");
        const spec = parsed.data;
        const tab = spec.app
          ? this.host.openAppTab(spec, spec.app).tab
          : this.host.openTab(spec.url);
        connection.end(`${JSON.stringify({ id, ok: true, data: { tab } })}\n`);
        return;
      }
      const data = await this.handle(request);
      connection.end(`${JSON.stringify({ id, ok: true, data })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        connection.end(`${JSON.stringify({ id, ok: false, error: message })}\n`);
      } catch {}
    }
  }

  private async handle(request: ControlRequest): Promise<unknown> {
    switch (request.cmd) {
      case "state":
        return this.record();
      case "where":
        return this.host.where();
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
      case "agent-touch": {
        if (request.tab === undefined) throw new Error("agent-touch needs a tab id");
        if (!this.host.agentTouch(request.tab)) throw new Error(`no tab ${request.tab}`);
        return this.record();
      }
      case "agent-release": {
        this.host.agentRelease();
        return { ...this.record(), tabs: await this.host.targets() };
      }
      default:
        throw new Error(`unknown command: ${request.cmd}`);
    }
  }
}

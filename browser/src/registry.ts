import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { callerTty } from "pixel-terminals";
import { INSTANCES_DIR, removeInstance, upsertInstance } from "pixel-store";
import type { InstanceRow } from "pixel-store";

import type { BrowserState } from "./page/types";
import type { CookieImportRequest, CookieSource } from "./cookies";
import type { BrowserProfile } from "./profiles";
import {
  PRE_AUTH_MAX_BYTES,
  PRE_AUTH_TIMEOUT_MS,
  authenticationFailure,
  loadOrCreateSocketSecret,
  prepareSocketDirectory,
  restrictSocketMode,
} from "./socket-secret";

// Every request this socket takes is a short json line, so an authenticated peer still
// has a ceiling and still has to say something before its slot is reclaimed.
const POST_AUTH_MAX_BYTES = 64 * 1024;
const POST_AUTH_IDLE_MS = 10_000;
const MAX_UNAUTHENTICATED_CONNECTIONS = 32;

export interface Where {
  terminal: string | null;
  tab: string | null;
  pane: string | null;
}

export interface ProfileListing {
  profiles: (BrowserProfile & { active: boolean })[];
  /** Empty for a pane pinned to an explicit --partition, which is on no profile. */
  activeSlug: string;
  activeName: string;
}

export interface ControlHost {
  key: string;
  tty: string | null;
  where(): Promise<Where>;
  splitDir: InstanceRow["splitDir"];
  parentTty: string | null;
  profile(): string | null;
  state(): BrowserState;
  openTab(url?: string, cwd?: string): number;
  activateTab(id: number): boolean;
  closeTab(id: number): boolean;
  tabs(): unknown;
  targets(): Promise<unknown>;
  importCookies(request: CookieImportRequest): Promise<unknown>;
  cookieSources(): CookieSource[];
  profiles(): ProfileListing;
  createProfile(name: string): BrowserProfile;
  renameProfile(selector: string, name: string): BrowserProfile;
  deleteProfile(selector: string): Promise<BrowserProfile>;
  clearProfile(selector: string): Promise<BrowserProfile>;
  switchProfile(selector: string): { profile: BrowserProfile; url: string };
  viewport(): { width: number; height: number } | null;
}

interface ControlRequest {
  cmd: string;
  url?: string;
  cwd?: string;
  tab?: number;
  from?: string;
  profile?: string;
  name?: string;
  selector?: string;
  toProfile?: string;
  domain?: string;
}

export class Registry {
  private readonly host: ControlHost;
  private readonly socketPath: string;
  private readonly tty: string | null;
  private readonly startedAt = Date.now();
  private readonly secret: string;
  private readonly pending = new Set<net.Socket>();
  private cdpPort: number | null = null;
  private server: net.Server | null = null;
  private importing: Promise<unknown> | null = null;
  private disposed = false;

  constructor(host: ControlHost) {
    this.host = host;
    this.tty = host.tty ?? callerTty().path;
    this.socketPath = path.join(INSTANCES_DIR, `${host.key}.sock`);
    prepareSocketDirectory(this.socketPath);
    // The secret has to exist before the socket accepts anyone.
    this.secret = loadOrCreateSocketSecret();
    fs.rmSync(this.socketPath, { force: true });
    this.server = net.createServer((connection) => this.serve(connection));
    this.server.on("error", () => {});
    this.server.listen(this.socketPath, () => restrictSocketMode(this.socketPath));
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
      profile: this.host.profile(),
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
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    // Refusing the newcomer would let a flooder hold every slot forever, so the peer
    // that has been silent longest loses its place instead.
    if (this.pending.size >= MAX_UNAUTHENTICATED_CONNECTIONS) {
      for (const oldest of this.pending) {
        oldest.destroy();
        break;
      }
    }
    this.pending.add(connection);
    let authenticated = false;
    let buffer = "";
    let idleTimer = setTimeout(() => connection.destroy(), PRE_AUTH_TIMEOUT_MS);
    connection.on("close", () => {
      clearTimeout(idleTimer);
      this.pending.delete(connection);
    });
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > (authenticated ? POST_AUTH_MAX_BYTES : PRE_AUTH_MAX_BYTES)) {
        connection.destroy();
        return;
      }
      while (!connection.destroyed) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!authenticated) {
          const failure = authenticationFailure(this.secret, line);
          if (failure) {
            connection.end(`${JSON.stringify({ ok: false, error: failure })}\n`);
            return;
          }
          authenticated = true;
          this.pending.delete(connection);
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => connection.destroy(), POST_AUTH_IDLE_MS);
          connection.write(`${JSON.stringify({ ok: true, data: { authenticated: true } })}\n`);
          continue;
        }
        buffer = "";
        clearTimeout(idleTimer);
        void this.handle(line)
          .then((data) => {
            connection.end(`${JSON.stringify({ ok: true, data })}\n`);
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            connection.end(`${JSON.stringify({ ok: false, error: message })}\n`);
          });
        return;
      }
    });
  }

  private async handle(line: string): Promise<unknown> {
    const request = JSON.parse(line) as ControlRequest;
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
      case "cookie-sources":
        return this.host.cookieSources();
      case "import-cookies":
        return this.importCookies(request);
      case "profiles":
        return this.host.profiles();
      case "profile-create": {
        if (!request.name) throw new Error("profile-create needs a name");
        return { profile: this.host.createProfile(request.name) };
      }
      case "profile-rename": {
        if (!request.selector) throw new Error("profile-rename needs a profile");
        if (!request.name) throw new Error("profile-rename needs a new name");
        return { profile: this.host.renameProfile(request.selector, request.name) };
      }
      case "profile-delete": {
        if (!request.selector) throw new Error("profile-delete needs a profile");
        return { profile: await this.host.deleteProfile(request.selector) };
      }
      case "profile-clear": {
        if (!request.selector) throw new Error("profile-clear needs a profile");
        return { profile: await this.host.clearProfile(request.selector) };
      }
      case "profile-switch": {
        if (!request.selector) throw new Error("profile-switch needs a profile");
        return this.host.switchProfile(request.selector);
      }
      default:
        throw new Error(`unknown command: ${request.cmd}`);
    }
  }

  /**
   * One copy at a time: each import rederives a key per row and rewrites a whole cookie store,
   * so concurrent requests would only multiply that work.
   */
  private importCookies(request: ControlRequest): Promise<unknown> {
    const done = (this.importing ?? Promise.resolve()).then(() =>
      this.host.importCookies({
        from: request.from,
        profile: request.profile,
        toProfile: request.toProfile,
        domain: request.domain,
      }),
    );
    this.importing = done.catch(() => {});
    return done;
  }
}

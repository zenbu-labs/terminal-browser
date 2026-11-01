import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app, webFrameMain } from "electron";
import type { ServiceWorkerMain } from "electron";

import type { Caller } from "./router";
import type { ExtensionService } from "./service";

// Chrome's own error strings (extensions/browser/api/messaging/native_message_host.cc).
export const NATIVE_ERRORS = {
  invalidName: "Invalid native messaging host name specified.",
  notFound: "Specified native messaging host not found.",
  forbidden: "Access to the specified native messaging host is forbidden.",
  failedToStart: "Failed to start native messaging host.",
  exited: "Native host has exited.",
  io: "Error when communicating with the native messaging host.",
} as const;

const HOST_MESSAGE_LIMIT = 1024 * 1024;
const BROWSER_MESSAGE_LIMIT = 64 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

export function nativeHostDirs(): string[] {
  const home = os.homedir();
  const ours = path.join(app.getPath("userData"), "NativeMessagingHosts");
  if (process.platform === "darwin") {
    return [
      ours,
      path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
      "/Library/Google/Chrome/NativeMessagingHosts",
    ];
  }
  return [ours, path.join(home, ".config/google-chrome/NativeMessagingHosts"), "/etc/opt/chrome/native-messaging-hosts"];
}

export function isValidHostName(name: string): boolean {
  return /^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(name);
}

interface HostManifest {
  path: string;
}

function originAllowed(entries: unknown[], extensionId: string): boolean {
  return entries.some((entry) => {
    const match = typeof entry === "string" ? /^chrome-extension:\/\/([a-p]{32})(\/.*)$/.exec(entry) : null;
    if (!match || match[1] !== extensionId) return false;
    const glob = match[2].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${glob}$`).test("/");
  });
}

// Finds and checks a host's manifest the way Chrome's LaunchContext does.
export function findNativeHost(name: string, extensionId: string): HostManifest {
  if (!isValidHostName(name)) throw new Error(NATIVE_ERRORS.invalidName);
  const file = nativeHostDirs()
    .map((dir) => path.join(dir, `${name}.json`))
    .find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(NATIVE_ERRORS.notFound);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(NATIVE_ERRORS.notFound);
  }
  const valid =
    manifest &&
    typeof manifest === "object" &&
    manifest.name === name &&
    typeof manifest.description === "string" &&
    manifest.description !== "" &&
    manifest.type === "stdio" &&
    typeof manifest.path === "string" &&
    manifest.path !== "" &&
    Array.isArray(manifest.allowed_origins) &&
    manifest.allowed_origins.every((entry) => typeof entry === "string");
  if (!valid) throw new Error(NATIVE_ERRORS.notFound);
  if (!originAllowed(manifest.allowed_origins as unknown[], extensionId)) throw new Error(NATIVE_ERRORS.forbidden);
  const hostPath = manifest.path as string;
  if (!path.isAbsolute(hostPath) || !fs.existsSync(hostPath)) throw new Error(NATIVE_ERRORS.notFound);
  return { path: hostPath };
}

// The 4-byte native-endian length prefix plus JSON that hosts speak on stdio.
export function encodeNativeMessage(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message ?? null), "utf8");
  const header = Buffer.alloc(4);
  if (os.endianness() === "LE") header.writeUInt32LE(json.length);
  else header.writeUInt32BE(json.length);
  return Buffer.concat([header, json]);
}

type Owner = { kind: "frame"; processId: number; routingId: number; contentsId: number } | { kind: "worker"; worker: ServiceWorkerMain };

// One running host process talking to one extension context.
class NativeHost {
  private readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    hostPath: string,
    extensionId: string,
    private readonly onMessage: (message: unknown) => void,
    private readonly onClose: (error: string | null) => void,
  ) {
    this.child = spawn(hostPath, [`chrome-extension://${extensionId}/`], {
      cwd: path.dirname(hostPath),
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child.on("error", () => this.close(NATIVE_ERRORS.failedToStart));
    this.child.on("exit", () => this.close(NATIVE_ERRORS.exited));
    this.child.stdin?.on("error", () => this.close(NATIVE_ERRORS.io));
    this.child.stdout?.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stdout?.on("end", () => this.close(NATIVE_ERRORS.exited));
  }

  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.closed && this.buffer.length >= 4) {
      const size = os.endianness() === "LE" ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0);
      if (size > HOST_MESSAGE_LIMIT) {
        this.close(NATIVE_ERRORS.io);
        return;
      }
      if (this.buffer.length < 4 + size) return;
      const body = this.buffer.subarray(4, 4 + size).toString("utf8");
      this.buffer = this.buffer.subarray(4 + size);
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        this.close(NATIVE_ERRORS.io);
        return;
      }
      this.onMessage(message);
    }
  }

  post(message: unknown) {
    if (this.closed) return;
    const encoded = encodeNativeMessage(message);
    if (encoded.length - 4 > BROWSER_MESSAGE_LIMIT) {
      this.close(NATIVE_ERRORS.io);
      return;
    }
    this.child.stdin?.write(encoded);
  }

  // `error` is null when the extension closed the port itself.
  close(error: string | null) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {}
    const child = this.child;
    if (child.exitCode === null && child.signalCode === null) {
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS).unref();
      }, KILL_GRACE_MS).unref();
    }
    this.onClose(error);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
}

interface Port {
  extensionId: string;
  portId: number;
  owner: Owner;
  host: NativeHost;
  release: () => void;
}

function ownerOf(caller: Caller): Owner {
  if (caller.kind === "worker") return { kind: "worker", worker: caller.worker };
  return { kind: "frame", processId: caller.frame.processId, routingId: caller.frame.routingId, contentsId: caller.contents.id };
}

function sameOwner(a: Owner, b: Owner): boolean {
  if (a.kind === "worker") return b.kind === "worker" && a.worker === b.worker;
  return b.kind === "frame" && a.processId === b.processId && a.routingId === b.routingId;
}

// chrome.runtime.connectNative / sendNativeMessage. A port only ever talks to
// the frame or worker that opened it, and its host dies with that context.
export class NativeMessaging {
  private readonly ports = new Map<string, Port>();

  constructor(private readonly service: ExtensionService) {
    service.onUnload((id) => {
      for (const port of [...this.ports.values()]) if (port.extensionId === id) port.host.close(null);
    });
    service.session.serviceWorkers.on("running-status-changed", ({ runningStatus, versionId }) => {
      if (runningStatus !== "stopping" && runningStatus !== "stopped") return;
      for (const port of [...this.ports.values()]) {
        if (port.owner.kind === "worker" && port.owner.worker.versionId === versionId) port.host.close(null);
      }
    });
  }

  private key(extensionId: string, portId: number): string {
    return `${extensionId}:${portId}`;
  }

  hostPids(extensionId?: string): number[] {
    return [...this.ports.values()]
      .filter((port) => !extensionId || port.extensionId === extensionId)
      .map((port) => port.host.pid)
      .filter((pid): pid is number => pid !== undefined);
  }

  connect(caller: Caller, portId: unknown, name: unknown) {
    if (typeof portId !== "number") throw new Error(NATIVE_ERRORS.io);
    const extensionId = caller.extension.id;
    const key = this.key(extensionId, portId);
    if (this.ports.has(key)) throw new Error(NATIVE_ERRORS.io);
    const manifest = findNativeHost(String(name), extensionId);
    const owner = ownerOf(caller);
    const send = (event: string, args: unknown[]) => {
      if (owner.kind === "worker") this.service.events.sendToWorker(owner.worker, event, args);
      else this.service.events.sendToFrame(owner, event, args);
    };
    const release = this.keepOwnerAlive(caller, () => port.host.close(null));
    const host = new NativeHost(
      manifest.path,
      extensionId,
      (message) => send("runtime.nativeMessage", [portId, message]),
      (error) => {
        if (this.ports.get(key) !== port) return;
        this.ports.delete(key);
        port.release();
        if (error) send("runtime.nativeDisconnect", [portId, error]);
      },
    );
    const port: Port = { extensionId, portId, owner, host, release };
    this.ports.set(key, port);
  }

  post(caller: Caller, portId: unknown, message: unknown) {
    const port = this.ports.get(this.key(caller.extension.id, Number(portId)));
    if (port && sameOwner(port.owner, ownerOf(caller))) port.host.post(message);
  }

  disconnect(caller: Caller, portId: unknown) {
    const port = this.ports.get(this.key(caller.extension.id, Number(portId)));
    if (port && sameOwner(port.owner, ownerOf(caller))) port.host.close(null);
  }

  sendOnce(caller: Caller, name: unknown, message: unknown): Promise<unknown> {
    const manifest = findNativeHost(String(name), caller.extension.id);
    return new Promise((resolve, reject) => {
      let settled = false;
      const host = new NativeHost(
        manifest.path,
        caller.extension.id,
        (reply) => {
          if (settled) return;
          settled = true;
          resolve(reply);
          host.close(null);
        },
        (error) => {
          if (settled) return;
          settled = true;
          reject(new Error(error ?? NATIVE_ERRORS.exited));
        },
      );
      host.post(message);
    });
  }

  // Keeps a worker running while its port is open, and closes a frame's port
  // when that frame goes away or loads another document.
  private keepOwnerAlive(caller: Caller, close: () => void): () => void {
    if (caller.kind === "worker") {
      let task: { end(): void } | null = null;
      try {
        task = caller.worker.startTask();
      } catch {}
      return () => {
        try {
          task?.end();
        } catch {}
      };
    }
    const contents = caller.contents;
    const { processId, routingId } = caller.frame;
    const gone = () => close();
    const navigated = (_event: unknown, _url: string, _code: number, _status: string, _main: boolean, pid: number, rid: number) => {
      const frame = webFrameMain.fromId(processId, routingId);
      if ((pid === processId && rid === routingId) || !frame || frame.isDestroyed()) close();
    };
    contents.once("destroyed", gone);
    contents.on("render-process-gone", gone);
    contents.on("did-frame-navigate", navigated);
    return () => {
      if (contents.isDestroyed()) return;
      contents.off("destroyed", gone);
      contents.off("render-process-gone", gone);
      contents.off("did-frame-navigate", navigated);
    };
  }
}

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { streamEnv } from "../terminal/stream";
import { Wire, WINDOW_BYTES, olderSide, protocolRange, trace, type Control, type ProtocolRange } from "./wire";

interface Hello {
  protocol: ProtocolRange;
  session: string;
  terminal: { cols: number; rows: number; env: Record<string, unknown> };
  args: string[];
  meta: unknown;
}

export interface LocalRenderLaunch {
  args: string[];
  env: Record<string, string>;
  meta: unknown;
}

export interface Started {
  pid?: number;
  stop(): void;
  exited: Promise<number>;
}

export interface HandleLocalRenderingOptions {
  send(message: Uint8Array): void;
  start(launch: LocalRenderLaunch): { command: string; args: string[]; env?: Record<string, string> } | Started;
  log?(line: string): void;
}

export interface HandledRendering {
  receive(message: Uint8Array): void;
  disconnected(): void;
  stop(): void;
  closed: Promise<void>;
}

// fixme: placeholder copy
const COPY = {
  noStart: "the app didn't start",
};

const START_MS = 20_000;

export function handleLocalRendering(options: HandleLocalRenderingOptions): HandledRendering {
  const wire = new Wire(options.send);
  const log = options.log ?? (() => {});
  const protocol = protocolRange();
  let hello: Hello | null = null;
  let frontend: Started | null = null;
  let terminal: net.Socket | null = null;
  let terminalServer: net.Server | null = null;
  let dir: string | null = null;
  const pendingInput: Buffer[] = [];
  let sent = 0;
  let acked = 0;
  let paused = false;
  let closed = false;
  let markClosed = () => {};
  const done = new Promise<void>((resolve) => (markClosed = resolve));

  const cleanup = () => {
    if (closed) return;
    closed = true;
    wire.open = false;
    stopKeepAlive();
    frontend?.stop();
    terminal?.destroy();
    terminalServer?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    trace("host-closed", { session: hello?.session, sent, acked });
    markClosed();
  };

  const refuse = (reason: string, extra: Record<string, unknown> = {}) => {
    log(`refused: ${reason}`);
    wire.send({ type: "refused", reason, ...extra });
    cleanup();
  };

  const stopKeepAlive = wire.keepAlive(() => {
    trace("link-dead", { side: "screen", session: hello?.session });
    cleanup();
  });

  const start = async (h: Hello) => {
    dir = fs.mkdtempSync(path.join("/tmp", "pixel-pair-"));
    fs.chmodSync(dir, 0o700);
    const socketPath = path.join(dir, "terminal.sock");
    const begun = Date.now();
    terminalServer = net.createServer((socket) => {
      terminal?.destroy();
      terminal = socket;
      trace("stream-connected", { session: h.session, ms: Date.now() - begun });
      wire.send({ type: "started", pid: frontend?.pid });
      for (const chunk of pendingInput.splice(0)) socket.write(chunk);
      socket.on("data", (data: Buffer) => {
        wire.output(data);
        sent += data.length;
        if (!paused && sent - acked > WINDOW_BYTES) {
          paused = true;
          socket.pause();
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => terminalServer!.listen(socketPath, resolve));
    if (closed) return;
    const env = streamEnv({ socket: socketPath, cols: h.terminal.cols, rows: h.terminal.rows, terminal: h.terminal.env });
    const how = options.start({ args: h.args, env, meta: h.meta });
    frontend = "command" in how ? spawned(how.command, how.args, { ...env, ...how.env }, log) : how;
    trace("app-started", { session: h.session, pid: frontend.pid });
    log(`started: pid ${frontend.pid ?? "?"}`);
    void frontend.exited.then((code) => {
      trace("app-exit", { session: h.session, code });
      wire.send({ type: "exit", code });
      cleanup();
    });
    setTimeout(() => {
      if (!terminal && !closed) refuse(COPY.noStart);
    }, START_MS).unref();
  };

  wire.onInput = (payload) => {
    if (terminal) terminal.write(Buffer.from(payload));
    else pendingInput.push(Buffer.from(payload));
  };
  wire.onControl = (message: Control) => {
    if (message.type === "hello") {
      if (hello) return;
      hello = message as unknown as Hello;
      trace("hello", { session: hello.session });
      if (!Array.isArray(hello.protocol) || olderSide(protocol, hello.protocol)) return refuse("protocol", { protocol });
      void start(hello).catch((error) => refuse(error instanceof Error ? error.message : String(error)));
    } else if (message.type === "ack") {
      acked = Number(message.bytes);
      if (paused && sent - acked < WINDOW_BYTES / 2) {
        paused = false;
        terminal?.resume();
      }
    } else if (message.type === "resize") {
      terminal?.write(`\x1b[48;${message.rows};${message.cols};0;0t`);
    } else if (message.type === "stop") {
      trace("stop", { session: hello?.session });
      cleanup();
    }
  };

  return {
    receive: (message) => wire.receive(message),
    disconnected: cleanup,
    stop: cleanup,
    closed: done,
  };
}

function spawned(command: string, args: string[], env: Record<string, string>, log: (line: string) => void): Started {
  const child = spawn(command, args, {
    cwd: os.homedir(),
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env },
  });
  child.stderr?.on("data", (data: Buffer) => log(data.toString().trim()));
  return {
    pid: child.pid,
    exited: new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 0)))),
    stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const pid = child.pid!;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }, 2000).unref();
    },
  };
}

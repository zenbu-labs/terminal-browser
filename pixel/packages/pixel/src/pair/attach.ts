import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { terminalVariables } from "../terminal/stream";
import { Wire, olderSide, protocolRange, trace, type Control, type ProtocolRange } from "./wire";

const START_MS = 30_000;
const QUIT_DRAIN_MS = 250;
const TERMINAL_RESET =
  "\x1b\\\x1b[?2026l\x1b_Ga=d,d=A,q=2\x1b\\\x1b[>4;0m\x1b[?2031l\x1b[0m\x1b[0 q" +
  "\x1b[<u\x1b[?2048l\x1b[?2004l\x1b[?1004l\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l";

export interface PairTerminal {
  input: Readable & { setRawMode?(raw: boolean): unknown };
  output: Writable;
  size(): { cols: number; rows: number };
  onResize(listener: () => void): () => void;
  env: NodeJS.ProcessEnv;
}

export interface AttachOptions {
  send(message: Uint8Array): void;
  args?: string[];
  meta?: unknown;
  terminal?: PairTerminal;
  signal?: AbortSignal;
  onStarted?(): void;
}

export type AttachError =
  | { kind: "noTerminal" }
  | { kind: "protocol"; older: "screen" | "remote"; screen: ProtocolRange; remote: ProtocolRange }
  | { kind: "refused"; message: string }
  | { kind: "disconnected" }
  | { kind: "timeout" };

export type Attached = { started: true; code: number; lost: boolean } | { started: false; error: AttachError };

export interface Attachment {
  receive(message: Uint8Array): void;
  disconnected(): void;
  done: Promise<Attached>;
}

function processTerminal(): PairTerminal | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return {
    input: process.stdin,
    output: process.stdout,
    size: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    onResize(listener) {
      process.on("SIGWINCH", listener);
      return () => process.off("SIGWINCH", listener);
    },
    env: process.env,
  };
}

export function attach(options: AttachOptions): Attachment {
  const wire = new Wire(options.send);
  const terminal = options.terminal ?? processTerminal();
  if (!terminal) {
    wire.open = false;
    return { receive() {}, disconnected() {}, done: Promise.resolve({ started: false, error: { kind: "noTerminal" } }) };
  }
  const { input, output } = terminal;
  const protocol = protocolRange();
  const ownSignals = !options.terminal && !options.signal;
  let started = false;
  let finished = false;
  let written = 0;
  let watcher: ChildProcess | null = null;
  let stopResize = () => {};
  let resolveDone: (attached: Attached) => void = () => {};
  const done = new Promise<Attached>((resolve) => (resolveDone = resolve));

  const restore = (reset: boolean) => {
    watcher?.kill();
    input.removeAllListeners("data");
    input.pause();
    if (reset) output.write(TERMINAL_RESET);
    try {
      input.setRawMode?.(false);
    } catch {}
    stopKeepAlive();
    stopResize();
    for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.off(signal, onGone);
    options.signal?.removeEventListener("abort", onGone);
  };

  const notStarted = (error: AttachError) => {
    if (started || finished) return;
    finished = true;
    clearTimeout(startTimer);
    restore(false);
    wire.open = false;
    resolveDone({ started: false, error });
  };

  const end = (code: number, lost: boolean) => {
    if (finished) return;
    finished = true;
    input.off("data", onInput);
    input.on("data", () => {});
    setTimeout(() => {
      restore(code !== 0 || lost);
      trace("done", { code, written, lost });
      wire.open = false;
      resolveDone({ started: true, code, lost });
    }, QUIT_DRAIN_MS);
  };

  const disconnected = () => {
    if (!started) return notStarted({ kind: "disconnected" });
    trace("link-lost", {});
    end(1, true);
  };

  const onInput = (data: Buffer) => wire.input(data);
  const onResize = () => wire.send({ type: "resize", ...terminal.size() });
  const onGone = () => {
    wire.send({ type: "stop" });
    end(0, false);
  };

  const startTimer = setTimeout(() => notStarted({ kind: "timeout" }), START_MS);
  const stopKeepAlive = wire.keepAlive(() => {
    trace("link-dead", { side: "remote" });
    disconnected();
  });

  wire.onOutput = (payload) => {
    const bytes = payload.length;
    output.write(Buffer.from(payload), () => {
      written += bytes;
      wire.send({ type: "ack", bytes: written });
    });
  };
  wire.onControl = (message: Control) => {
    if (message.type === "started") {
      started = true;
      clearTimeout(startTimer);
      trace("started", { pid: message.pid });
      options.onStarted?.();
    } else if (message.type === "refused") {
      const screen = message.protocol as ProtocolRange | undefined;
      if (screen) notStarted({ kind: "protocol", older: olderSide(screen, protocol) === "mine" ? "screen" : "remote", screen, remote: protocol });
      else notStarted({ kind: "refused", message: String(message.reason) });
    } else if (message.type === "exit") end(Number(message.code) || 0, false);
  };

  input.setRawMode?.(true);
  if (terminal.input === process.stdin) watcher = watchTerminal();
  input.on("data", onInput);
  input.resume();
  stopResize = terminal.onResize(onResize);
  if (ownSignals) for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(signal, onGone);
  options.signal?.addEventListener("abort", onGone);
  const env = terminalVariables(terminal.env);
  wire.send({
    type: "hello",
    protocol,
    session: randomUUID(),
    terminal: { ...terminal.size(), env },
    args: options.args ?? [],
    meta: options.meta ?? null,
  });

  return { receive: (message) => wire.receive(message), disconnected, done };
}

function watchTerminal(): ChildProcess | null {
  try {
    const watcher = spawn(
      "/bin/sh",
      ["-c", 'while kill -0 "$WATCHED" 2>/dev/null; do sleep 0.3; done; printf "%s" "$RESET"; stty sane'],
      { stdio: ["inherit", "inherit", "ignore"], detached: true, env: { WATCHED: String(process.pid), RESET: TERMINAL_RESET, PATH: "/bin:/usr/bin" } },
    );
    watcher.unref();
    return watcher;
  } catch {
    return null;
  }
}

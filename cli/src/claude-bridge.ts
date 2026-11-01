import { execFile as execFileCb, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { callerTty } from "@zenbu-labs/pixel/terminal";
import { connectionUid, listenPrivately, peerAllowed, privateServer } from "@zenbu-labs/pixel/private-socket";
import { ensurePrivateDir, ownUid } from "@zenbu-labs/pixel/private-dir";
import { appendPrivateFile, BRIDGE_SOCKETS_DIR, ensureOwnedDir, openPrivateLog } from "shared";

import { err, outJson } from "./output";
import { installedVersion } from "./upgrade";
import { AGENT_TOKEN_ON_STDIN } from "./agent-token";

const execFile = promisify(execFileCb);


const LOG_DIR = path.join(os.homedir(), ".terminal-browser", "logs");
const LOG_FILE = path.join(LOG_DIR, "claude-code-plugin-bridge.log");
const DEFAULT_CELL: [number, number] = [16, 34];
const DEBUG = process.env.CC_BROWSER_DEBUG === "1";

function log(event: string, detail?: unknown): void {
  const line = `${new Date().toISOString()} ${event}${detail === undefined ? "" : " " + JSON.stringify(detail)}\n`;
  err(line);
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function selfCommand(): string[] {
  return [process.execPath, process.argv[1]];
}


function parseCell(text: string | undefined): [number, number] | null {
  const m = /^(\d+)x(\d+)$/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}




function report(value: unknown, exitCode = 0): never {
  outJson(value, 0);
  process.exit(exitCode);
}

async function launch(argv: string[]): Promise<never> {
  const tty = flag(argv, "--tty") ?? callerTty().path;
  if (!tty) report({ error: "no tty: Claude Code is not running on a terminal", code: "tty" }, 2);
  const cellOverride = flag(argv, "--cell") ?? process.env.CC_BROWSER_CELL ?? "";
  const token = crypto.randomBytes(24).toString("hex");
  const name = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const bridgeDir = ensurePrivateDir(BRIDGE_SOCKETS_DIR);
  const socket = path.join(bridgeDir, `${name}.sock`);
  const apiSocket = path.join(bridgeDir, `${name}.api.sock`);
  ensureOwnedDir(LOG_DIR);
  const logFd = openPrivateLog(LOG_FILE);
  const [self, ...selfArgs] = selfCommand();
  const child = spawn(
    self,
    [...selfArgs, "claude-bridge", "serve", "--tty", tty, "--socket", socket, "--api-socket", apiSocket, "--cell", cellOverride],
    { detached: true, stdio: ["pipe", "pipe", logFd], env: withoutNodeOptions(process.env) },
  );
  child.stdin!.end(`${token}\n`);
  let line = "";
  try {
    await new Promise<void>((resolve, reject) => {
      // fixme: placeholder copy
      const timer = setTimeout(() => reject(new Error("bridge did not report its socket")), 10_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        line += chunk.toString();
        if (line.includes("\n")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`bridge exited with ${code}`));
      });
    });
  } catch (error) {
    report({ error: error instanceof Error ? error.message : String(error), code: "start" }, 1);
  }
  const { socket: listening } = JSON.parse(line.split("\n")[0]) as { socket: string };
  child.stdout!.destroy();
  child.unref();
  const launched = { socket: listening, pid: child.pid, tty, terminalBrowser: installedVersion() ?? "dev", token };
  appendPrivateFile(LOG_FILE, `${new Date().toISOString()} launch ${JSON.stringify({ ...launched, token: undefined })}\n`);
  report(launched);
}


const Cell = z.tuple([z.number().int().positive(), z.number().int().positive()]);

const Size = z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() });
type Size = z.infer<typeof Size>;

const Mods = z.object({ shift: z.boolean(), alt: z.boolean(), ctrl: z.boolean(), super: z.boolean() }).partial();

const Frame = z.object({
  shm: z.string(),
  format: z.enum(["rgba", "rgb"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
type Frame = z.infer<typeof Frame>;

const PixelMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), pane: z.string().optional(), name: z.string().optional(), pid: z.number().optional() }),
  Frame.extend({ type: z.literal("frame"), cell: Cell.nullish() }),
  z.object({ type: z.literal("title"), text: z.string() }),
  z.object({ type: z.literal("pointer"), shape: z.string() }),
  z.object({ type: z.literal("clipboard"), text: z.string() }),
]);

const InputEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    kind: z.enum(["down", "up", "move", "scrollup", "scrolldown"]),
    button: z.enum(["left", "middle", "right", "none"]).optional(),
    x: z.number(),
    y: z.number(),
    mods: Mods.optional(),
  }),
  z.object({ type: z.literal("key"), key: z.string(), text: z.string().optional(), mods: Mods.optional() }),
  z.object({ type: z.literal("paste"), text: z.string() }),
  z.object({ type: z.literal("focus"), focused: z.boolean() }),
]);

const OpenBody = z.object({ url: z.string().optional(), cols: z.number().optional(), rows: z.number().optional() });
const STATE_WAIT_MS = 1000;
const MAX_IMAGE_PX = 4096;
const InputBody = z.object({ events: z.array(z.unknown()) });
const AgentTextBody = z.object({ text: z.string().trim().min(1), screenshot: z.string().nullish() });
type AgentText = { text: string; screenshot: string | null };

class Bridge {
  apiSocket: string | null = null;
  size: Size = { cols: 80, rows: 24 };
  url: string | null = null;
  frame: Frame | null = null;
  version = 0;
  private waiters: Array<() => void> = [];
  title = "";
  alive = false;
  error: string | null = null;
  inbox: AgentText[] = [];
  private conn: net.Socket | null = null;
  private child: ChildProcess | null = null;
  private pixelServer: net.Server | null = null;
  private lineBuf = "";
  private stopping = false;
  private measuredCell: [number, number] | null = null;

  constructor(
    readonly tty: string,
    readonly socketPath: string,
    readonly cellOverride: [number, number] | null,
    readonly token: string,
  ) {}

  state() {
    return {
      version: this.version,
      url: this.url,
      frame: this.frame,
      title: this.title,
      alive: this.alive,
      error: this.error,
      inbox: this.inbox.length,
    };
  }

  changed(): void {
    this.version += 1;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  stateAfter(version: number): Promise<ReturnType<Bridge["state"]>> {
    if (version !== this.version) return Promise.resolve(this.state());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve(this.state());
      }, STATE_WAIT_MS);
      const wake = () => {
        clearTimeout(timer);
        resolve(this.state());
      };
      this.waiters.push(wake);
    });
  }

  pushInbox(item: AgentText): void {
    this.inbox.push(item);
    this.changed();
  }

  takeInbox(): AgentText[] {
    const items = this.inbox.splice(0, this.inbox.length);
    if (items.length > 0) this.changed();
    return items;
  }


  private sizeMessage(type: "init" | "size") {
    return { type, cols: this.size.cols, rows: this.size.rows, cell: this.cellOverride ?? undefined };
  }

  private fitImageLimits(size: Size): Size {
    const [cw, ch] = this.cell() ?? DEFAULT_CELL;
    return {
      cols: Math.max(1, Math.min(size.cols, Math.floor(MAX_IMAGE_PX / cw))),
      rows: Math.max(1, Math.min(size.rows, Math.floor(MAX_IMAGE_PX / ch))),
    };
  }

  private setFrame(frame: Frame | null): void {
    this.frame = frame;
    this.changed();
  }

  private send(message: unknown): void {
    if (!this.conn) return;
    try {
      this.conn.write(JSON.stringify(message) + "\n");
    } catch {}
  }

  listenForPixel(): void {
    this.pixelServer = privateServer((conn) => {
      if (this.conn) {
        conn.destroy();
        return;
      }
      this.conn = conn;
      this.lineBuf = "";
      conn.on("data", (data: Buffer) => {
        this.lineBuf += data.toString("utf8");
        let at = this.lineBuf.indexOf("\n");
        while (at !== -1) {
          this.handlePixelLine(this.lineBuf.slice(0, at));
          this.lineBuf = this.lineBuf.slice(at + 1);
          at = this.lineBuf.indexOf("\n");
        }
      });
      conn.on("error", () => {});
      conn.on("close", () => {
        if (this.conn === conn) {
          this.conn = null;
          this.setFrame(null);
        }
      });
    });
    listenPrivately(this.pixelServer, this.socketPath);
  }

  private handlePixelLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = PixelMessage.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case "join":
        this.send({ ...this.sizeMessage("init"), transport: "host", focused: true });
        break;
      case "frame": {
        const { type: _type, cell, ...frame } = message;
        if (cell) this.measuredCell = cell;
        this.setFrame(frame);
        break;
      }
      case "title":
        if (message.text !== this.title) {
          this.title = message.text;
          this.changed();
        }
        break;
      case "clipboard":
        if (DEBUG) log("clipboard from browser", { chars: message.text.length });
        if (process.platform === "darwin") {
          try {
            spawn("pbcopy", { stdio: ["pipe", "ignore", "ignore"] }).stdin!.end(message.text);
          } catch {}
        }
        break;
      case "pointer":
        break;
    }
  }

  private cell(): [number, number] | null {
    return this.measuredCell ?? this.cellOverride;
  }


  open(url: string | undefined, size: Size | null): void {
    if (size) this.size = this.fitImageLimits(size);
    if (this.alive) {
      if (url && url !== this.url) void this.navigate(url);
      this.send(this.sizeMessage("size"));
      this.send({ type: "visible", value: true });
      return;
    }
    this.url = url ?? this.url ?? "about:blank";
    this.error = null;
    this.alive = true;
    this.setFrame(null);
    const env = withoutNodeOptions(process.env);
    delete env.PIXEL_PANE;
    env.PIXEL_EMBED = this.socketPath;
    env.PIXEL_TTY = this.tty;
    env.TERMINAL_BROWSER_COPY_ON_SELECT = "1";
    env.TERMINAL_BROWSER_START_PAGE = "1";
    if (this.apiSocket) {
      env.TERMINAL_BROWSER_AGENT_BRIDGE = this.apiSocket;
      env[AGENT_TOKEN_ON_STDIN] = "1";
    }
    const [command, ...args] = selfCommand();
    const child = spawn(command, [...args, "open", this.url], { env, stdio: ["pipe", "ignore", "pipe"] });
    child.stdin!.on("error", () => {});
    child.stdin!.end(this.apiSocket ? `${this.token}\n` : "");
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", (error) => {
      this.alive = false;
      this.error = error.message;
      this.changed();
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.alive = false;
      this.setFrame(null);
      if (code && !this.stopping) {
        this.error = stderr.trim() || `terminal-browser exited with ${code}`;
        log("browser exited with an error", { code, stderr: stderr.trim().slice(-300) });
      }
    });
    this.child = child;
  }

  private async browserKey(): Promise<string | null> {
    const [command, ...args] = selfCommand();
    try {
      const { stdout } = await execFile(command, [...args, "ls", "--all", "--json"], { timeout: 5000 });
      const list = JSON.parse(stdout);
      const rows = Array.isArray(list) ? list : list.browsers ?? [];
      const mine = rows.find((b: { tty?: string }) => b.tty === this.tty);
      return mine?.key ?? null;
    } catch {
      return null;
    }
  }

  private async navigate(url: string): Promise<void> {
    this.url = url;
    const key = await this.browserKey();
    const [command, ...args] = selfCommand();
    const selectors = key ? ["--browser", key] : [];
    spawn(command, [...args, "action", ...selectors, "--", "open", url], { env: withoutNodeOptions(process.env), stdio: "ignore" }).on("error", () => {});
  }

  resize(size: Size): void {
    const fitted = this.fitImageLimits(size);
    if (fitted.cols === this.size.cols && fitted.rows === this.size.rows) return;
    this.size = fitted;
    this.send(this.sizeMessage("size"));
  }

  input(events: unknown[]): void {
    const [cw, ch] = this.cell() ?? DEFAULT_CELL;
    if (DEBUG) log("input", events);
    for (const raw of events) {
      const parsed = InputEvent.safeParse(raw);
      if (!parsed.success) continue;
      const event = parsed.data;
      switch (event.type) {
        case "mouse": {
          const x = Math.max(0, Math.round(event.x * cw + cw / 2));
          const y = Math.max(0, Math.round(event.y * ch + ch / 2));
          this.send({ type: "mouse", kind: event.kind, button: event.button ?? "none", mods: event.mods ?? {}, x, y });
          break;
        }
        case "key":
          this.send({ type: "key", key: event.key, kind: "press", text: event.text, mods: event.mods ?? {} });
          break;
        case "paste":
          this.send({ type: "paste", text: event.text });
          break;
        case "focus":
          this.send({ type: "focus", focused: event.focused });
          break;
      }
    }
  }

  hide(): void {
    this.send({ type: "visible", value: false });
  }

  close(): void {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.child;
    const finish = () => {
      try {
        this.pixelServer?.close();
      } catch {}
      fs.rmSync(this.socketPath, { force: true });
      if (this.apiSocket) fs.rmSync(this.apiSocket, { force: true });
      process.exit(0);
    };
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      child.once("exit", () => setTimeout(finish, 200));
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish();
      }, 3500).unref();
    } else {
      setTimeout(finish, 300).unref();
    }
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {}

function readJson(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        request.destroy();
        return;
      }
      body += chunk.toString();
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    request.on("error", () => resolve({}));
  });
}

function sizeOf(body: z.infer<typeof OpenBody>): Size | null {
  const { cols, rows } = body;
  return cols && rows ? Size.safeParse({ cols, rows }).data ?? null : null;
}

type Reply = [number, unknown];
type Handler = (body: unknown, query: URLSearchParams) => Reply | Promise<Reply>;

function withBody<T>(schema: z.ZodType<T>, handler: (body: T) => Reply): Handler {
  return (body) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return [400, { error: "invalid body" }];
    return handler(parsed.data);
  };
}

function routes(bridge: Bridge): Record<string, Handler> {
  return {
    "GET /state": async (_body, query) => {
      const version = Number(query.get("version"));
      return [200, await bridge.stateAfter(Number.isFinite(version) ? version : -1)];
    },
    "POST /open": withBody(OpenBody, (body) => {
      bridge.open(body.url, sizeOf(body));
      return [200, bridge.state()];
    }),
    "POST /size": withBody(OpenBody, (body) => {
      const size = sizeOf(body);
      if (size) bridge.resize(size);
      return [200, bridge.state()];
    }),
    "POST /input": withBody(InputBody, (body) => {
      bridge.input(body.events);
      return [200, {}];
    }),
    "POST /agent-text": withBody(AgentTextBody, (body) => {
      bridge.pushInbox({ text: body.text, screenshot: body.screenshot ?? null });
      return [200, {}];
    }),
    "POST /inbox/take": () => [200, { items: bridge.takeInbox() }],
    "POST /browser/close": () => {
      bridge.hide();
      return [200, bridge.state()];
    },
    "POST /close": () => {
      setTimeout(() => bridge.close(), 0);
      return [200, {}];
    },
  };
}

const IDLE_EXIT_MS = 60_000;
const HEADERS_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 64;

// NODE_OPTIONS=--inspect would make each child open a debugger on a TCP port.
function withoutNodeOptions(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _ignored, ...rest } = env;
  return rest;
}

function sameSecret(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The launcher writes the token to our stdin, so it never shows up in process listings.
function readToken(): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (text += chunk));
    process.stdin.on("end", () => resolve(text.trim()));
    process.stdin.on("error", () => resolve(""));
  });
}

async function serve(argv: string[]): Promise<void> {
  const tty = flag(argv, "--tty");
  const socket = flag(argv, "--socket");
  const apiSocket = flag(argv, "--api-socket");
  const cellOverride = parseCell(flag(argv, "--cell"));
  const token = await readToken();
  if (!/^[0-9a-f]{48}$/.test(token)) {
    // fixme: placeholder copy
    err("claude-bridge serve needs its token on stdin\n");
    process.exit(2);
  }
  if (!tty || !socket || !apiSocket) {
    // fixme: placeholder copy
    err("claude-bridge serve needs --tty, --socket and --api-socket\n");
    process.exit(2);
  }
  const bridgeDir = ensurePrivateDir(BRIDGE_SOCKETS_DIR);
  const realDir = (file: string) => (fs.existsSync(path.dirname(file)) ? fs.realpathSync(path.dirname(file)) : null);
  const socketPath = path.join(bridgeDir, path.basename(socket));
  const apiPath = path.join(bridgeDir, path.basename(apiSocket));
  if (realDir(socket) !== bridgeDir || realDir(apiSocket) !== bridgeDir || socketPath === apiPath) {
    // fixme: placeholder copy
    err(`claude-bridge serve only listens inside ${bridgeDir}\n`);
    process.exit(2);
  }
  const bridge = new Bridge(tty, socketPath, cellOverride, token);
  bridge.listenForPixel();
  const table = routes(bridge);
  let lastSeen = Date.now();
  const server = http.createServer({ connectionsCheckingInterval: 1000 }, async (request, response) => {
    if (!sameSecret(request.headers.authorization, `Bearer ${token}`)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    lastSeen = Date.now();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const handler = table[`${request.method} ${url.pathname}`] as Handler | undefined;
    let body: unknown = {};
    if (handler && request.method === "POST") {
      try {
        body = await readJson(request);
      } catch {
        response.writeHead(413, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: "request too large" }));
        return;
      }
    }
    const [status, value] = handler ? await handler(body, url.searchParams) : [404, { error: "not found" }];
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  // Only processes of our own user get to talk to the bridge, the same check privateServer makes.
  server.prependListener("connection", (connection: net.Socket) => {
    if (!peerAllowed(connectionUid(connection), ownUid())) connection.destroy();
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = HEADERS_TIMEOUT_MS * 3;
  server.maxConnections = MAX_CONNECTIONS;
  server.on("listening", () => {
    bridge.apiSocket = apiPath;
    outJson({ socket: apiPath }, 0);
  });
  listenPrivately(server, apiPath);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => bridge.close());
  setInterval(() => {
    if (Date.now() - lastSeen > IDLE_EXIT_MS) bridge.close();
  }, 10_000).unref();
}

export async function claudeBridgeCommand(args: string[]): Promise<number> {
  const [mode, ...rest] = args;
  if (mode === "launch") await launch(rest);
  if (mode === "serve") {
    await serve(rest);
    return new Promise<never>(() => {});
  }
  err("usage: terminal-browser claude-bridge launch|serve ...\n");
  return 2;
}

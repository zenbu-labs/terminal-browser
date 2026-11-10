#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { checkTerminal, detect } from "@zenbu-labs/pixel/terminal";

import { SOCKET, STATE_DIR, isSetUp } from "./paths";
import { lines } from "./protocol";
import type { Reply, Request } from "./protocol";

function ownTty(): string {
  const out = execFileSync("tty", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
  if (!out.startsWith("/dev/")) throw new Error("not running on a terminal");
  return out;
}

function targetFolder(arg: string | undefined): string {
  const callerDir = process.env.INIT_CWD ?? process.cwd();
  const target = fs.realpathSync(path.resolve(callerDir, arg ?? "."));
  return fs.statSync(target).isDirectory() ? target : path.dirname(target);
}

function spawnDaemon(): void {
  const library = path.dirname(require.resolve("@zenbu-labs/pixel/package.json"));
  const dist = path.join(library, "electron", "dist");
  const electron =
    process.platform === "darwin"
      ? path.join(dist, "Electron.app", "Contents", "MacOS", "pixel")
      : path.join(dist, "pixel");
  const bootstrap = path.join(library, "dist", "bootstrap.js");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PIXEL_") && key !== "ELECTRON_RUN_AS_NODE"),
  );
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(path.join(STATE_DIR, "daemon.log"), "a");
  const child = spawn(electron, [bootstrap, path.join(__dirname, "daemon.js")], {
    detached: true,
    stdio: ["ignore", log, log],
    env,
  });
  child.unref();
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function daemon(): Promise<net.Socket> {
  try {
    return await connect();
  } catch {}
  spawnDaemon();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return await connect();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`the zed daemon did not start (log: ${path.join(STATE_DIR, "daemon.log")})`);
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  if (process.argv[2] === "shutdown") {
    const socket = await connect().catch(() => null);
    if (!socket) return 0;
    socket.write(`${JSON.stringify({ cmd: "shutdown" } satisfies Request)}\n`);
    socket.end();
    return 0;
  }
  if (!isSetUp()) {
    process.stderr.write("run `pnpm zed:setup` first (builds zed-remote-server and downloads the editor bundle)\n");
    return 1;
  }

  const folder = targetFolder(process.argv[2]);
  const tty = process.env.PIXEL_TTY ?? ownTty();
  const check = await checkTerminal(detect());
  if (check.graphics === "unsupported") {
    process.stderr.write("this terminal doesn't support graphics\n");
    return 1;
  }

  const socket = await daemon();
  const send = (request: Request) => socket.write(`${JSON.stringify(request)}\n`);
  send({ cmd: "open", tty, folder, env: process.env, startedAt });

  return new Promise<number>((resolve) => {
    socket.on(
      "data",
      lines((line) => {
        const reply = JSON.parse(line) as Reply;
        if ("ok" in reply && !reply.ok) {
          process.stderr.write(`${reply.error}\n`);
          resolve(1);
        } else if ("event" in reply && reply.event === "closed") {
          resolve(reply.code);
        }
      }),
    );
    socket.on("close", () => resolve(0));
    socket.on("error", () => resolve(1));
    process.on("SIGWINCH", () => send({ cmd: "resize" }));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => send({ cmd: "close" }));
    }
  });
}

void main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);

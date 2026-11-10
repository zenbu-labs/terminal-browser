#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { checkTerminal, detect } from "@zenbu-labs/pixel/terminal";

import { SOCKET, lines } from "./protocol";
import type { Reply, Request } from "./protocol";

const url = process.argv[2] ?? "https://example.com";

function ownTty(): string {
  const out = execFileSync("tty", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
  if (!out.startsWith("/dev/")) throw new Error("not running on a terminal");
  return out;
}

function libraryDir(): string {
  return path.dirname(require.resolve("@zenbu-labs/pixel/package.json"));
}

// pixel's own launcher insists on a terminal and hands it to the
// app it starts. A daemon has no terminal of its own, so it has to start
// electron the same way the launcher does, by hand.
function spawnDaemon(): void {
  const library = libraryDir();
  const dist = path.join(library, "electron", "dist");
  const electron =
    process.platform === "darwin"
      ? path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
      : path.join(dist, "electron");
  const bootstrap = path.join(library, "dist", "bootstrap.js");
  const entry = path.join(__dirname, "daemon.js");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PIXEL_") && key !== "ELECTRON_RUN_AS_NODE"),
  );
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
  const log = fs.openSync(path.join(path.dirname(SOCKET), "daemon.log"), "a");
  const child = spawn(electron, [bootstrap, entry], { detached: true, stdio: ["ignore", "ignore", log], env });
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
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("the daemon did not start");
}

async function main(): Promise<number> {
  if (process.argv[2] === "shutdown") {
    const socket = await connect().catch(() => null);
    if (!socket) return 0;
    socket.write(`${JSON.stringify({ cmd: "shutdown" } satisfies Request)}\n`);
    socket.end();
    return 0;
  }

  const tty = process.env.PIXEL_TTY ?? ownTty();
  const check = await checkTerminal(detect());
  if (check.graphics === "unsupported") {
    process.stderr.write("this terminal doesn't support graphics\n");
    return 1;
  }

  const socket = await daemon();
  const send = (request: Request) => socket.write(`${JSON.stringify(request)}\n`);
  send({ cmd: "open", tty, url, cwd: process.cwd(), env: process.env });

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
    // The daemon owns the terminal now, but signals still land here, so the
    // shell's resize and ctrl+c have to be relayed.
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

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app } from "electron";

import { DAEMON_SOCKET, makeRoomForSocket } from "pixel-store";
import { createSession } from "./session/session";
import type { SessionHandle } from "./session/session";

// what
const IDLE_EXIT_MS = 15_000;


interface OpenRequest {
  cmd: "open";
  tty: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  build?: string;
}

export function buildStamp(): string {
  try {
    return String(Math.floor(fs.statSync(path.join(__dirname, "main.js")).mtimeMs));
  } catch {
    return "unknown";
  }
}

export async function runDaemon(cdpPort: number | null): Promise<void> {
  if (await socketAlive()) {
    process.stderr.write("terminal-browser daemon already running\n");
    app.exit(3);
    return;
  }
  makeRoomForSocket(DAEMON_SOCKET);

  const build = buildStamp();
  const sessions = new Map<string, SessionHandle>();
  let seq = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (sessions.size === 0) app.exit(0);
    }, IDLE_EXIT_MS);
  };
  scheduleIdleExit();

  const stopEverything = (code: number) => {
    for (const open of [...sessions.values()]) {
      try {
        open.close();
      } catch {}
    }
    sessions.clear();
    setTimeout(() => app.exit(code), 200);
  };
  process.on("SIGINT", () => stopEverything(130));
  process.on("SIGTERM", () => stopEverything(143));

  const server = net.createServer((connection) => {
    let key: string | null = null;
    let session: SessionHandle | null = null;
    const reply = (value: unknown) => {
      try {
        connection.write(`${JSON.stringify(value)}\n`);
      } catch {}
    };

    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let message: Omit<OpenRequest, "cmd"> & { cmd: string };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.cmd === "open" && !session) {
          if (message.build && message.build !== build) {
            reply({ ok: false, error: "stale" });
            connection.end();
            if (sessions.size === 0) app.exit(0);
            return;
          }
          if (!message.tty) {
            reply({ ok: false, error: "no tty" });
            connection.end();
            return;
          }
          if (idleTimer) clearTimeout(idleTimer);
          key = `${process.pid}-${++seq}`;
          const sessionKey = key;
          try {
            session = createSession({
              tty: message.tty,
              key: sessionKey,
              argv: message.argv ?? [],
              env: message.env ?? {},
              cwd: message.cwd ?? process.cwd(),
              cdpPort,
              onClose: (code) => {
                sessions.delete(sessionKey);
                reply({ event: "closed", code });
                connection.end();
                scheduleIdleExit();
              },
            });
          } catch (error) {
            reply({ ok: false, error: String(error) });
            connection.end();
            scheduleIdleExit();
            return;
          }
          sessions.set(sessionKey, session);
          reply({ ok: true, session: sessionKey, pid: process.pid });
        } else if (message.cmd === "resize") {
          session?.nudgeResize();
        } else if (message.cmd === "close") {
          session?.close();
        } else if (message.cmd === "shutdown") {
          reply({ ok: true, sessions: sessions.size });
          connection.end();
          setTimeout(() => app.exit(0), 50);
        }
      }
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      if (key && sessions.has(key)) {
        const orphan = sessions.get(key)!;
        sessions.delete(key);
        orphan.close();
        scheduleIdleExit();
      }
    });
  });
  server.on("error", (error) => {
    process.stderr.write(`terminal-browser daemon socket error: ${error}\n`);
    app.exit(1);
  });
  server.listen(DAEMON_SOCKET);
}

function socketAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(DAEMON_SOCKET);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app } from "@zenbu-labs/pixel/electron";
import { createRoot, WebView } from "@zenbu-labs/pixel";
import type { Root } from "@zenbu-labs/pixel";

import { SOCKET, lines } from "./protocol";
import type { Reply, Request } from "./protocol";

const IDLE_EXIT_MS = 15_000;

const roots = new Set<Root>();
let idle: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleExit() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (roots.size === 0) app.exit(0);
  }, IDLE_EXIT_MS);
}

function openPage(request: Extract<Request, { cmd: "open" }>, onClosed: (code: number) => void): Root {
  const root = createRoot({
    name: "daemon",
    tty: request.tty,
    sessionEnv: request.env,
    onKey(event) {
      if (event.kind === "press" && event.mods.ctrl && event.key === "c") {
        root.stop();
        return true;
      }
    },
    onExit(code) {
      roots.delete(root);
      onClosed(code);
      scheduleIdleExit();
    },
  });
  roots.add(root);
  root.render(
    <WebView
      src={request.url}
      style={{ width: "100%", height: "100%" }}
      onChange={(state) => root.setTitle(state.title || state.url)}
    />,
  );
  return root;
}

fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
fs.rmSync(SOCKET, { force: true });

const server = net.createServer((connection) => {
  let root: Root | null = null;
  const reply = (value: Reply) => {
    try {
      connection.write(`${JSON.stringify(value)}\n`);
    } catch {}
  };
  connection.on(
    "data",
    lines((line) => {
      const request = JSON.parse(line) as Request;
      switch (request.cmd) {
        case "open":
          if (root) return;
          if (idle) clearTimeout(idle);
          try {
            root = openPage(request, (code) => {
              reply({ event: "closed", code });
              connection.end();
            });
            reply({ ok: true, pid: process.pid });
          } catch (error) {
            reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
            connection.end();
            scheduleIdleExit();
          }
          return;
        case "resize":
          root?.nudgeResize();
          return;
        case "close":
          root?.stop();
          return;
        case "shutdown":
          for (const open of roots) open.stop();
          setTimeout(() => app.exit(0), 100);
          return;
      }
    }),
  );
  connection.on("error", () => {});
  connection.on("close", () => root?.stop());
});

server.on("error", (error) => {
  process.stderr.write(`daemon socket error: ${error.message}\n`);
  app.exit(1);
});
server.listen(SOCKET);
scheduleIdleExit();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const open of roots) open.stop();
    setTimeout(() => app.exit(0), 200);
  });
}

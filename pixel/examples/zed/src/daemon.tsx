import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { app } from "@zenbu-labs/pixel/electron";
import { createRoot, WebView } from "@zenbu-labs/pixel";
import type { Root } from "@zenbu-labs/pixel";

import { BUNDLE_BUILD, BUNDLE_DIR, BUNDLE_FILES, SOCKET, STATE_DIR, WEB_DIR } from "./paths";
import { lines } from "./protocol";
import type { Reply, Request } from "./protocol";
import { mintToken, participantFor, stopAllWorkspaces, workspaceFor } from "./workspaces";
import type { Workspace } from "./workspaces";

const IDLE_EXIT_MS = 10 * 60_000;
const ZED_BACKGROUND = "#131314";
const PAGE_PORT_FILE = path.join(STATE_DIR, "page-port");
const CONFIG_DIR = path.join(STATE_DIR, "config");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".tar": "application/x-tar",
};
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const DEFAULT_KEYMAP = JSON.stringify(
  [
    { bindings: { "ctrl-c": "zed::Quit" } },
    { context: "menu", bindings: { "ctrl-c": "menu::Cancel" } },
    { context: "Picker > Editor", bindings: { "ctrl-c": "menu::Cancel" } },
    { context: "Terminal", bindings: { "ctrl-c": ["terminal::SendKeystroke", "ctrl-c"] } },
    { context: "vim_mode == visual", bindings: { "ctrl-c": "vim::SwitchToNormalMode" } },
    { context: "vim_mode == insert", bindings: { "ctrl-c": "vim::NormalBefore" } },
    { context: "vim_mode == replace", bindings: { "ctrl-c": "vim::NormalBefore" } },
    { context: "vim_mode == waiting", bindings: { "ctrl-c": "vim::ClearOperators" } },
    { context: "vim_mode == operator", bindings: { "ctrl-c": "vim::ClearOperators" } },
    { context: "vim_mode == literal", bindings: { "ctrl-c": ["vim::Literal", ["ctrl-c", "\u0003"]] } },
  ],
  null,
  2,
);

interface ZedWindow {
  id: string;
  root: Root;
  workspace: Workspace;
  participant: string;
  ready: boolean;
  startedAt: number;
}

const windows = new Map<string, ZedWindow>();
let idle: ReturnType<typeof setTimeout> | null = null;
let pageOrigin = "";

// Once a window is attached to a terminal, stderr no longer reaches the log file.
function log(message: string) {
  fs.appendFileSync(path.join(STATE_DIR, "daemon.log"), `[${new Date().toISOString()}] ${message}\n`);
}

function scheduleIdleExit() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (windows.size === 0) void shutdown();
  }, IDLE_EXIT_MS);
}

async function shutdown() {
  for (const window of windows.values()) window.root.stop();
  await stopAllWorkspaces();
  setTimeout(() => app.exit(0), 100);
}

function configFile(kind: string) {
  return path.join(CONFIG_DIR, kind === "keymap" ? "keymap.json" : "settings.json");
}

function readConfig(kind: "settings" | "keymap") {
  const file = configFile(kind);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  return kind === "keymap" ? DEFAULT_KEYMAP : "";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendFile(res: http.ServerResponse, file: string, cache: string) {
  res.writeHead(200, {
    ...ISOLATION_HEADERS,
    "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": fs.statSync(file).size,
    "Cache-Control": cache,
  });
  fs.createReadStream(file).pipe(res);
}

function sendJson(res: http.ServerResponse, value: unknown) {
  res.writeHead(200, { ...ISOLATION_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function handleEvent(window: ZedWindow, stage: string, detail: string) {
  if (stage === "ready" && !window.ready) {
    window.ready = true;
    log(`${window.workspace.folder}: ready in ${Date.now() - window.startedAt}ms`);
  } else if (stage === "stopped" && detail === "quit") {
    window.root.stop();
  } else if (stage === "stopped" || stage === "failed") {
    window.ready = false;
    log(`${window.workspace.folder}: ${stage} ${detail}`);
  }
}

async function handlePage(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", pageOrigin);
  if (req.headers.host !== url.host) return res.writeHead(403).end();
  const windowRoute = url.pathname.match(/^\/window\/([^/]+)\/(connect|event)$/);
  if (windowRoute) {
    const window = windows.get(windowRoute[1]);
    if (!window) return res.writeHead(404, ISOLATION_HEADERS).end();
    if (windowRoute[2] === "connect") {
      return sendJson(res, {
        buildId: BUNDLE_BUILD,
        connect: mintToken(window.workspace, window.participant),
        workspace: { id: window.workspace.id, paths: [window.workspace.folder] },
        settingsJson: readConfig("settings"),
        keymapJson: readConfig("keymap"),
      });
    }
    const { stage, detail } = JSON.parse(await readBody(req)) as { stage: string; detail: string };
    handleEvent(window, stage, detail);
    return res.writeHead(204, ISOLATION_HEADERS).end();
  }
  const configRoute = url.pathname.match(/^\/config\/(settings|keymap)$/);
  if (configRoute && req.method === "PUT") {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(configFile(configRoute[1]), await readBody(req));
    return res.writeHead(204, ISOLATION_HEADERS).end();
  }
  if (url.pathname === "/") return sendFile(res, path.join(WEB_DIR, "index.html"), "no-cache");
  if (url.pathname === "/loader.js") return sendFile(res, path.join(WEB_DIR, "loader.js"), "no-cache");
  const bundleFile = url.pathname.slice(`/editor/${BUNDLE_BUILD}/`.length);
  if (url.pathname.startsWith(`/editor/${BUNDLE_BUILD}/`) && BUNDLE_FILES.includes(bundleFile)) {
    // The build id is in the url, so the browser can keep these (and its compiled wasm) forever.
    return sendFile(res, path.join(BUNDLE_DIR, bundleFile), "public, max-age=31536000, immutable");
  }
  res.writeHead(404, ISOLATION_HEADERS).end();
}

function listenPage(server: http.Server): Promise<number> {
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  const saved = fs.existsSync(PAGE_PORT_FILE) ? Number(fs.readFileSync(PAGE_PORT_FILE, "utf8")) : 0;
  return listen(saved).catch(() => listen(0)).then((port) => {
    fs.writeFileSync(PAGE_PORT_FILE, String(port));
    return port;
  });
}

async function openWindow(request: Extract<Request, { cmd: "open" }>, onClosed: (code: number) => void) {
  const workspace = await workspaceFor(request.folder, pageOrigin);
  const id = crypto.randomUUID();
  const participant = participantFor(workspace);
  workspace.participants.add(participant);
  const root = createRoot({
    name: "zed",
    tty: request.tty,
    sessionEnv: request.env,
    onKey(event) {
      if (!zedWindow.ready && event.kind === "press" && event.mods.ctrl && event.key === "c") {
        root.stop();
        return true;
      }
    },
    onExit(code) {
      windows.delete(id);
      workspace.participants.delete(participant);
      onClosed(code);
      scheduleIdleExit();
    },
  });
  const zedWindow: ZedWindow = { id, root, workspace, participant, ready: false, startedAt: request.startedAt };
  windows.set(id, zedWindow);
  root.setTitle(`zed ${path.basename(workspace.folder)}`);
  root.render(
    <WebView
      src={`${pageOrigin}/?window=${id}`}
      partition="zed"
      autoFocus
      browserWindowOptions={{ backgroundColor: ZED_BACKGROUND }}
      style={{ width: "100%", height: "100%" }}
      onContextMenu={() => {}}
    />,
  );
  return root;
}

function daemonAlreadyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(SOCKET);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (await daemonAlreadyRunning()) return app.exit(0);
  const page = http.createServer((req, res) => {
    handlePage(req, res).catch((error: unknown) => {
      log(`page request ${req.url} failed: ${String(error)}`);
      if (!res.headersSent) res.writeHead(500, ISOLATION_HEADERS);
      res.end();
    });
  });
  pageOrigin = `http://127.0.0.1:${await listenPage(page)}`;

  fs.rmSync(SOCKET, { force: true });
  const server = net.createServer((connection) => {
    let root: Root | null = null;
    let closed = false;
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
            openWindow(request, (code) => {
              reply({ event: "closed", code });
              connection.end();
            }).then(
              (opened) => {
                root = opened;
                if (closed) return opened.stop();
                reply({ ok: true });
              },
              (error: unknown) => {
                reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
                connection.end();
                scheduleIdleExit();
              },
            );
            return;
          case "resize":
            root?.nudgeResize();
            return;
          case "close":
            root?.stop();
            return;
          case "shutdown":
            void shutdown();
            return;
        }
      }),
    );
    connection.on("error", () => {});
    connection.on("close", () => {
      closed = true;
      root?.stop();
    });
  });
  server.on("error", (error) => {
    log(`daemon socket error: ${error.message}`);
    app.exit(1);
  });
  server.listen(SOCKET);
  scheduleIdleExit();
  log(`page server on ${pageOrigin}`);
}

app.on("window-all-closed", () => {});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown());
void main().catch((error: unknown) => {
  log(`daemon failed: ${String(error)}`);
  app.exit(1);
});

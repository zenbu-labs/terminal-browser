import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRef } from "react";
import type { ReactNode } from "react";

import { app, screen } from "electron";

import { debug } from "./debug";
import { Shell } from "./host/shell";
import { OwnerServer } from "./host/server";
import { PaneShell } from "./host/strip";
import {
  InstanceRecord,
  PROTOCOL,
  clearHandoff,
  findOwner,
  instanceKey,
  instancesDir,
  markHandoff,
} from "./instances";
import type { Instance } from "./instances";
import { createRoot as createEngineRoot } from "./react/node";
import type { EngineKeyEvent, PixelRoot, RootOptions as EngineRootOptions } from "./react";
import { RootContext, ViewRegistry } from "./registry";
import type { ViewEntry } from "./registry";
import { WebView } from "./webview";
import type { WebViewHandle, WebViewProps } from "./webview";
import { CellZoomFollower, hostDisplayScale } from "./scale";
import { UNSUPPORTED_ENV, detect } from "./terminal";
import type { Terminal } from "./terminal";
import { initOffscreenMode } from "./web/offscreen";
import {
  broadcastTheme,
  flushSessions,
  installEmbedderApi,
  uninstallEmbedderApi,
} from "./web/session";
import type { EmbedderHost } from "./web/session";

export interface RootOptions
  extends Omit<
    EngineRootOptions,
    | "keyEventTypes"
    | "onKey"
    | "onEngineExit"
    | "onLayout"
    | "host"
    | "onHostClosed"
    | "onHandoff"
  > {
  name?: string;
  onKey?: (event: EngineKeyEvent) => boolean | void;
  onQuit?: (view: WebViewHandle | null) => void;
  onExit?: (code: number) => void;
  onUnsupportedTerminal?: (terminal: Terminal | null) => string;
}

export type LoadOptions = Omit<WebViewProps, "src" | "style" | "hidden" | "autoFocus">;

export interface Root extends Omit<PixelRoot, "render" | "flushSync" | "stop" | "retarget"> {
  readonly displayScale: number;
  readonly hosted: boolean;
  render(element: ReactNode): void;
  loadURL(url: string, options?: LoadOptions): WebViewHandle;
  loadFile(file: string, options?: LoadOptions): WebViewHandle;
  stop(code?: number): void;
}

function ownTty(): string | undefined {
  try {
    const out = execFileSync("tty", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
    return out.startsWith("/dev/") ? out : undefined;
  } catch {
    return undefined;
  }
}

const liveRoots = new Set<{ stop(code: number): void }>();
let signalsInstalled = false;

function installSignals() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  const stopAll = (code: number) => () => {
    for (const root of [...liveRoots]) root.stop(code);
  };
  process.on("SIGTERM", stopAll(143));
  process.on("SIGHUP", stopAll(129));
}

const REJOIN_WAIT_MS = 5000;

function waitForSocket(socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + REJOIN_WAIT_MS;
    const check = () => {
      if (fs.existsSync(socket)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`no owner appeared at ${socket}`));
      setTimeout(check, 25);
    };
    check();
  });
}

export function createRoot(options: RootOptions = {}): Root {
  if (!app.isReady()) {
    throw new Error(
      "createRoot() needs electron to be ready. Run your entry with `pixel .`, which waits for app.whenReady() before loading it.",
    );
  }
  const env = options.sessionEnv ?? process.env;
  const terminal = detect(env);
  if (env[UNSUPPORTED_ENV]) {
    const message = options.onUnsupportedTerminal?.(terminal) ?? "pixel: this terminal doesn't support graphics\n";
    fs.writeSync(1, message);
    app.exit(1);
    throw new Error("this terminal doesn't support graphics");
  }

  const tty = options.tty ?? env.PIXEL_TTY ?? ownTty();

  const embed = env.PIXEL_EMBED ?? null;
  let owner: Instance | null = tty && !embed ? findOwner(tty) : null;
  const name = options.name ?? app.getName();
  const cellZoom = new CellZoomFollower();
  const shell = new Shell(() => name);
  let registry: ViewRegistry | null = null;
  let embedder: EmbedderHost | null = null;
  let server: OwnerServer | null = null;
  let record: InstanceRecord | null = null;
  let handoff: { tty?: string; socket?: string } | null = null;
  let stopping = false;

  const shutdown = (code: number, then: () => void = () => finish(code)) => {
    if (stopping) return;
    stopping = true;
    debug("shutdown", { code, hosted: owner != null });
    liveRoots.delete(root);
    if (embedder) uninstallEmbedderApi(embedder);
    if (registry) {
      for (const host of [...registry.hosts()]) {
        try {
          host.stop();
        } catch {}
      }
    }
    flushSessions();
    try {
      engineRoot.stop();
    } catch {}
    record?.withdraw();
    server?.stop();
    then();
  };

  const finish = (code: number) => {
    if (tty) clearHandoff(tty, env);
    if (options.onExit) options.onExit(code);
    else app.exit(code);
  };


  const finishAfterSuccessor = (code: number) => {
    if (!tty) return finish(code);
    const deadline = Date.now() + 15000;
    const check = () => {
      if (findOwner(tty, env) || Date.now() > deadline) return finish(code);
      setTimeout(check, 25);
    };
    check();
  };

  const socketPath = tty ? path.join(instancesDir(env), `${instanceKey(tty)}.sock`) : null;

  const engineRoot = createEngineRoot({
    ...options,
    tty: owner || embed ? undefined : tty,
    host: owner
      ? {
          socket: owner.socket,
          pane: env.PIXEL_PANE ?? randomBytes(8).toString("hex"),
          name,
        }
      : embed && tty
        ? { socket: embed, pane: randomBytes(8).toString("hex"), name, tty }
        : undefined,
    wrapper: options.wrapper ?? (owner || embed ? undefined : terminal?.wrapper),
    keyEventTypes: true,

    devtools: options.devtools ?? process.env.NODE_ENV !== "production",
    onKey: (event) => {
      if (shell.handleKey(event)) return;
      if (!shell.guestActive() && options.onKey?.(event) === true) return;
      registry?.handleKey(event);
    },
    onPaste: (text) => {
      if (!shell.guestActive()) options.onPaste?.(text);
      registry?.handlePaste(text);
    },
    onPasteImage: (image) => {
      if (!shell.guestActive()) options.onPasteImage?.(image);
      registry?.handlePasteImage(image);
    },
    onFocus: (focused) => {
      options.onFocus?.(focused);
      registry?.handleTerminalFocus(focused);
    },
    onVisible: (visible) => options.onVisible?.(visible),
    onResize: (size) => {
      const ratio = cellZoom.ratio(engineRoot.info);
      if (registry) {
        if (ratio != null) {
          for (const host of registry.hosts()) {
            host.scaleZoom(ratio);
            host.popup?.scaleZoom(ratio);
          }
        }
        for (const listener of registry.resizeListeners) listener();
      }
      options.onResize?.(size);
    },
    onColors: (colors) => {
      debug("colors", { background: colors.background });
      if (registry) {
        registry.colors.set(colors);
        const background = registry.background();
        for (const host of registry.hosts()) void host.setBackground(background);
        if (embedder) broadcastTheme(embedder, registry.theme());
      }
      options.onColors?.(colors);
    },
    onLayout: (snapshot) => registry?.layout.set(snapshot),
    onHandoff: (next) => {
      handoff = next;
    },
    onHostClosed: () => void ownerLeft(),
    onEngineExit: (error) => {
      if (error) process.stderr.write(`pixel engine: ${error}\n`);
      shutdown(error ? 1 : 0);
    },
  });
  initOffscreenMode(engineRoot.sharedTextures);
  cellZoom.ratio(engineRoot.info);

  const quit = (entry: ViewEntry | null) => {
    if (options.onQuit) options.onQuit((entry?.handle as WebViewHandle | null) ?? null);
    else shutdown(0);
  };

  registry = new ViewRegistry(
    engineRoot,
    hostDisplayScale(terminal, env),
    !engineRoot.info.kittyKeyboard,
    { quit: (entry: ViewEntry | null) => quit(entry) },
  );
  const views = registry;

  embedder = {
    hosts: () => views.hosts(),
    theme: () => views.theme(),
    quit: (host) => quit([...views.views].find((view) => view.host === host) ?? null),
  };
  installEmbedderApi(embedder);

  const becomeOwner = () => {
    if (!tty || !socketPath) return;
    owner = null;
    server = new OwnerServer(socketPath, () => ({
      width: engineRoot.info.cellWidth,
      height: engineRoot.info.cellHeight,
    }));
    server.onJoin = (guest) => {
      const focused = views.focused;
      shell.rememberFocus(() => {
        if (focused && views.views.has(focused)) views.focus(focused);
      });
      guest.onClose = () => shell.remove(guest);
      shell.add(guest);
    };
    record = new InstanceRecord(
      {
        tty,
        pid: process.pid,
        socket: socketPath,
        protocol: PROTOCOL,
        name,
        title: currentTitle,
        cwd: options.cwd ?? process.cwd(),
        startedAt: Date.now(),
      },
      env,
    );
  };


  const ownerLeft = async () => {
    if (stopping) return;
    const next = embed ? null : handoff;
    handoff = null;
    try {
      if (next?.tty && socketPath) {
        debug("adopting tty", { tty: next.tty });
        await engineRoot.retarget({ tty: next.tty, wrapper: terminal?.wrapper });
        becomeOwner();
        engineRoot.nudgeResize();
        return;
      }
      if (next?.socket) {
        debug("rejoining", { socket: next.socket });
        await waitForSocket(next.socket);
        await engineRoot.retarget({
          host: { socket: next.socket, pane: randomBytes(8).toString("hex"), name },
        });
        return;
      }
      shutdown(0);
    } catch (error) {
      process.stderr.write(`pixel: ${error instanceof Error ? error.message : String(error)}\n`);
      shutdown(1);
    }
  };


  shell.onCloseOwner = () => {
    const successor = shell.successor();
    if (!successor || !tty || !socketPath) {
      quit(null);
      return;
    }
    markHandoff(tty, env);
    successor.send({ type: "adopt", tty });
    for (const other of shell.others(successor)) other.send({ type: "rejoin", socket: socketPath });
    shutdown(0, () => finishAfterSuccessor(0));
  };

  let currentTitle: string | null = null;
  if (owner) {
    debug("joined owner", { tty, owner: owner.name, pid: owner.pid });
  } else {
    becomeOwner();
  }
  if (tty && !embed) {
    process.on("SIGWINCH", () => {
      if (!stopping && !owner) engineRoot.nudgeResize();
    });
  }
  installSignals();

  const pageRef = createRef<WebViewHandle>();
  const loadURL = (url: string, options: LoadOptions = {}): WebViewHandle => {
    if (pageRef.current) {
      pageRef.current.loadURL(url);
      return pageRef.current;
    }
    engineRoot.flushSync(() => {
      root.render(<WebView ref={pageRef} src={url} style={{ width: "100%", height: "100%" }} {...options} />);
    });
    if (!pageRef.current) throw new Error("the page did not mount");
    return pageRef.current;
  };

  const root: Root = {
    ...engineRoot,
    displayScale: views.displayScale,
    get hosted() {
      return owner != null || embed != null;
    },
    get info() {
      return engineRoot.info;
    },
    render(element: ReactNode) {
      debug("render", { width: engineRoot.info.width, height: engineRoot.info.height });
      engineRoot.render(
        <RootContext.Provider value={views}>
          <PaneShell shell={shell}>{element}</PaneShell>
        </RootContext.Provider>,
      );
    },
    loadURL,
    loadFile: (file, options) => loadURL(pathToFileURL(path.resolve(file)).href, options),
    setTitle(text: string) {
      currentTitle = text || null;
      engineRoot.setTitle(text);
      record?.setTitle(currentTitle);
      shell.changed();
    },
    stop(code = 0) {
      shutdown(code);
    },
  };

  try {
    const hz = screen.getPrimaryDisplay().displayFrequency;
    if (hz > 0) engineRoot.setRender({ maxFps: hz });
  } catch {}
  liveRoots.add(root);
  return root;
}

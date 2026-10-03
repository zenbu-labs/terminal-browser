import path from "node:path";

import { clipboard } from "electron";
import {
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ContextMenu } from "./context-menu";
import type { MenuItem } from "./context-menu";
import { debug } from "./debug";
import { DevtoolsDockPane } from "./devtools";
import { dividerFraction, splitForDevtools } from "./devtools-layout";
import type { Rect } from "./devtools-layout";
import { useNodeRect } from "./layout";
import { PopupCard } from "./popup";
import type { PopupView } from "./popup";
import { Box } from "./react";
import type {
  DragEvent,
  EngineKeyEvent,
  NodeHandle,
  PointerEvent,
  Style,
  Surface,
  SurfaceCapture,
  WheelEvent,
} from "./react";
import { RootContext, handleEntries, useRegistryColors } from "./registry";
import type { ViewEntry } from "./registry";
import { makeTheme } from "./theme";
import type { DownloadProgress, PermissionRequest } from "./web/browser-session";
import { PageHost, decideOpenWindow } from "./web/host";
import type { BrowserWindowOptions, OpenWindowDecision, OpenWindowPolicy } from "./web/host";
import { persistentPartition } from "./web/browser-session";
import { initialWebViewState, snapToCssGrid } from "./web/types";
import type { DevtoolsDock, MediaCapture, SurfaceLayout, WebViewState } from "./web/types";
import type { ZoomDirection } from "./web/zoom";

export type {
  BrowserWindowOptions,
  DownloadProgress,
  OpenWindowDecision,
  OpenWindowPolicy,
  PermissionRequest,
  MediaCapture,
  WebViewState,
};

export interface WebViewProps {
  src: string;
  style?: Style;
  preload?: string;
  partition?: string;
  clipboardRead?: boolean;
  proxy?: string;
  browserWindowOptions?: BrowserWindowOptions;
  autoFocus?: boolean;
  devtools?: boolean | DevtoolsDock;
  hidden?: boolean;
  keepFrame?: boolean;
  onChange?(state: WebViewState): void;
  onPointer?(event: PointerEvent): void;
  onContextMenu?(params: Electron.ContextMenuParams): void;
  onOpenWindow?: OpenWindowPolicy;
  onDownload?(progress: DownloadProgress): void;
  onPermissionRequest?(request: PermissionRequest): Promise<boolean>;
  onPermissionCheck?(request: PermissionRequest): boolean;
}

export interface WebViewHandle {
  readonly webContents: Electron.WebContents;
  readonly state: WebViewState;
  onChange(listener: (state: WebViewState) => void): () => void;
  loadURL(url: string): void;
  focus(): void;
  blur(): void;
  back(): void;
  forward(): void;
  reload(): void;
  zoom(direction: ZoomDirection): number;
  setAudioMuted(muted: boolean): void;
  find(text: string): void;
  findNext(forward: boolean): void;
  stopFind(): void;
  cdp(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  openDevtools(): void;
  closeDevtools(): void;
  closePopup(): void;
  readonly recording: WebViewRecording;
}

export interface WebViewRecording {
  start(dir: string): SurfaceCapture;
  onFrame(listener: () => void): () => void;
  frameSize(): { width: number; height: number } | null;
  pinFrameRate(pinned: boolean): void;
  invalidate(): void;
}

interface MenuState {
  x: number;
  y: number;
  pageX: number;
  pageY: number;
  items: MenuItem[];
  linkURL: string;
  selectionText: string;
}

const DRAG_RESIZE_MS = 50;

export const WebView = forwardRef<WebViewHandle, WebViewProps>(function WebView(props, ref) {
  const registry = useContext(RootContext);
  if (!registry) {
    throw new Error(
      "<WebView> has to be rendered by a root from pixel's createRoot()",
    );
  }
  const colors = useRegistryColors(registry);
  const theme = useMemo(() => makeTheme(colors), [colors]);
  const hidden = !!props.hidden;
  const rem = registry.root.info.basePx;
  const scale = registry.displayScale;
  const boxRef = useRef<NodeHandle>(null);
  const rect = useNodeRect(boxRef, registry);

  const hostRef = useRef<PageHost | null>(null);
  const surfaces = useRef<{ page: Surface; popup: Surface; devtools: Surface } | null>(null);
  const stateRef = useRef<WebViewState>(initialWebViewState(props.src));
  const propsRef = useRef(props);
  propsRef.current = props;
  const hover = useRef({ page: false, popup: false, devtools: false, divider: false });
  const dragging = useRef(false);
  const lastDragResize = useRef(0);
  const pendingInspect = useRef<{ x: number; y: number } | null>(null);
  const frameListeners = useRef(new Set<() => void>());
  const changeListeners = useRef(new Set<(state: WebViewState) => void>());

  const [popup, setPopup] = useState<PopupView | null>(null);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [dock, setDock] = useState<DevtoolsDock>(
    typeof props.devtools === "string" ? props.devtools : "right",
  );
  const dockRef = useRef(dock);
  dockRef.current = dock;
  const [fraction, setFraction] = useState(0.4);
  const [dividerEngaged, setDividerEngaged] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;

  const devtoolsEnabled =
    props.devtools === undefined ? process.env.NODE_ENV !== "production" : props.devtools !== false;

  const entry = useMemo<ViewEntry>(
    () => ({
      host: null,
      handle: null,
      devtoolsEnabled: false,
      externalDevtools: false,
      externalDevtoolsAction: null,
      toggleDevtools: () => { },
      handleKey: () => false,
    }),
    [],
  );
  entry.devtoolsEnabled = devtoolsEnabled;
  entry.toggleDevtools = () => {
    if (hostRef.current?.devtools) hostRef.current.closeDevtools();
    else setDevtoolsOpen(true);
  };
  entry.handleKey = (event: EngineKeyEvent) => {
    if (!menuRef.current || event.kind === "release") return false;
    setMenu(null);
    return event.key === "escape";
  };

  const inner: Rect | null = rect ? { x: 0, y: 0, width: rect.width, height: rect.height } : null;
  const dockOpen = devtoolsOpen && !entry.externalDevtools;
  const gap = Math.max(2, Math.round(rem * 0.25));
  const split = inner ? splitForDevtools(inner, dockOpen ? { dock, fraction } : null, gap) : null;
  const page = split
    ? { ...split.page, ...snapToCssGrid(split.page.width, split.page.height, scale) }
    : null;
  const devtoolsRect = split?.devtools
    ? { ...split.devtools, ...snapToCssGrid(split.devtools.width, split.devtools.height, scale) }
    : null;

  const keepFrame = () => dragging.current || propsRef.current.keepFrame !== false;

  const syncCursor = () => {
    const host = hostRef.current;
    const h = hover.current;
    const shape = h.divider
      ? dockRef.current === "bottom"
        ? "ns-resize"
        : "ew-resize"
      : h.devtools
        ? host?.devtools?.cursorShape ?? "default"
        : host?.popup
          ? h.popup
            ? host.popup.cursorShape
            : "default"
          : h.page
            ? host?.cursorShape ?? "default"
            : "default";
    registry.setPointerShape(shape);
  };

  const readPopup = (host: PageHost): PopupView | null => {
    const top = host.popup;
    if (!top) return null;
    let hostName = "";
    try {
      hostName = new URL(top.state.url).host;
    } catch { }
    return {
      title: top.state.title,
      host: hostName,
      loading: top.state.loading,
      width: top.state.width,
      height: top.state.height,
    };
  };

  useLayoutEffect(() => {
    const created = {
      page: registry.root.createSurface(),
      popup: registry.root.createSurface(),
      devtools: registry.root.createSurface(),
    };
    surfaces.current = created;
    registry.register(entry);
    const initial = propsRef.current;
    const passthrough = initial.browserWindowOptions ?? {};
    const browserWindowOptions = {
      ...passthrough,
      webPreferences: {
        ...passthrough.webPreferences,
        ...(initial.partition ? { partition: persistentPartition(initial.partition) } : {}),
        ...(initial.preload ? { preload: path.resolve(initial.preload) } : {}),
      },
    };
    const info = registry.root.info;
    const host = new PageHost(
      created.page,
      created.popup,
      { x: 0, y: 0, width: info.width, height: info.height, scale },
      {
        url: initial.src,
        background: registry.background(),
        clipboardRead: !!initial.clipboardRead,
        proxy: initial.proxy ?? null,
        browserWindowOptions,
      },
      (state) => {
        debug("state", state);
        stateRef.current = state;
        propsRef.current.onChange?.(state);
        for (const listener of changeListeners.current) listener(state);
      },
    );
    hostRef.current = host;
    entry.host = host;
    debug("host created", { info: { width: info.width, height: info.height }, scale, url: initial.src });
    host.onCursorChange = () => syncCursor();
    host.onPopupChange = () => {
      setPopup(readPopup(host));
      syncCursor();
    };
    host.onDevtoolsChange = () => {
      const open = !!host.devtools;
      if (!open) entry.externalDevtools = false;
      setDevtoolsOpen(open);
      syncCursor();
    };
    host.onDevtoolsAction = (action) => {
      if (entry.externalDevtools) {
        entry.externalDevtoolsAction?.(action);
        return;
      }
      if (action === "close") host.closeDevtools();
      else setDock(action === "dock-bottom" ? "bottom" : "right");
    };
    host.onContextMenu = (params) => {
      const custom = propsRef.current.onContextMenu;
      if (custom) custom(params);
      else openMenu(params);
    };
    host.onOpenWindow = (details) => decideOpenWindow(propsRef.current.onOpenWindow, details);
    host.onDownload = (progress) => propsRef.current.onDownload?.(progress);
    host.onPermission = {
      request: (request) =>
        propsRef.current.onPermissionRequest?.(request) ?? Promise.resolve(false),
      check: (request) => propsRef.current.onPermissionCheck?.(request) ?? false,
    };
    host.onQuit = () => registry.quit(entry);
    host.onFrameSubmitted = () => {
      for (const listener of frameListeners.current) listener();
    };
    host.setVisible(!initial.hidden);
    if (!initial.hidden && (initial.autoFocus ?? registry.views.size === 1)) registry.focus(entry);
    return () => {
      registry.unregister(entry);
      host.stop();
      hostRef.current = null;
      entry.host = null;
      created.popup.close();
      created.devtools.close();
      surfaces.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A zero rect means an ancestor is hidden; keep the page at its last size.
  const collapsed = rect != null && (rect.width <= 0 || rect.height <= 0);
  useEffect(() => {
    hostRef.current?.setVisible(!hidden && !collapsed);
    if ((hidden || collapsed) && registry.focused === entry) registry.blur(entry);
  }, [hidden, collapsed]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !page || hidden || collapsed) return;
    const layout: SurfaceLayout = { ...page, scale };
    debug("page resize", layout);
    host.resize(layout, { keepFrame: keepFrame() });
  }, [page?.x, page?.y, page?.width, page?.height, scale, hidden]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !dockOpen || !devtoolsRect || hidden) return;
    const layout: SurfaceLayout = { ...devtoolsRect, scale };
    if (!host.devtools) {
      host.openDevtools(surfaces.current!.devtools, layout, dock);
      host.focusDevtools();
      const inspect = pendingInspect.current;
      if (inspect) {
        pendingInspect.current = null;
        host.inspect(inspect.x, inspect.y);
      }
      return;
    }
    host.devtools.resize(layout, { keepFrame: keepFrame() });
  }, [dockOpen, devtoolsRect?.x, devtoolsRect?.y, devtoolsRect?.width, devtoolsRect?.height, scale]);

  useEffect(() => {
    hostRef.current?.devtools?.setDock(dock);
  }, [dock]);

  const firstSrc = useRef(true);
  useEffect(() => {
    if (firstSrc.current) {
      firstSrc.current = false;
      return;
    }
    hostRef.current?.navigate(props.src);
  }, [props.src]);

  const openMenu = async (params: Electron.ContextMenuParams) => {
    const host = hostRef.current;
    if (!host || host.popup) return;
    const canPaste = params.isEditable && (await clipboard.readText()).length > 0;
    const state = stateRef.current;
    const selectionText = params.selectionText.trim();
    const mac = process.platform === "darwin";
    const items: MenuItem[] = [
      { id: "back", label: "back", enabled: state.canGoBack, shortcut: "" },
      { id: "forward", label: "forward", enabled: state.canGoForward, shortcut: "" },
      { id: "reload", label: "reload", enabled: true, shortcut: "" },
    ];
    if (selectionText) {
      items.push({ id: "copy", label: "copy", enabled: true, shortcut: mac ? "cmd+c" : "ctrl+c" });
    }
    if (params.isEditable) {
      items.push({
        id: "paste",
        label: "paste",
        enabled: canPaste,
        shortcut: mac ? "cmd+v" : "ctrl+v",
      });
    }
    if (params.linkURL) {
      items.push({ id: "open-link", label: "open link", enabled: true, shortcut: "" });
      items.push({ id: "copy-link", label: "copy link address", enabled: true, shortcut: "" });
    }
    if (devtoolsEnabled) {
      items.push({ id: "inspect", label: "inspect", enabled: true, shortcut: "f12" });
      items.push({ id: "engine-devtools", label: "pixel devtools", enabled: true, shortcut: "" });
    }
    const pageRect = page ?? { x: 0, y: 0 };
    setMenu({
      x: pageRect.x + params.x * scale,
      y: pageRect.y + params.y * scale,
      pageX: params.x,
      pageY: params.y,
      items,
      linkURL: params.linkURL,
      selectionText,
    });
  };

  const runMenu = (id: string) => {
    const current = menuRef.current;
    setMenu(null);
    const host = hostRef.current;
    if (!current || !host) return;
    switch (id) {
      case "back":
        return host.back();
      case "forward":
        return host.forward();
      case "reload":
        return host.reload();
      case "copy":
        return registry.root.setClipboard(current.selectionText);
      case "paste":
        return clipboard.readText().then((text) => host.paste(text));
      case "open-link":
        return host.navigate(current.linkURL);
      case "copy-link":
        return registry.root.setClipboard(current.linkURL);
      case "engine-devtools":
        return registry.root.openDevtools();
      case "inspect":
        pendingInspect.current = { x: current.pageX, y: current.pageY };
        if (host.devtools) {
          pendingInspect.current = null;
          host.focusDevtools();
          host.inspect(current.pageX, current.pageY);
        } else {
          setDevtoolsOpen(true);
        }
        return;
    }
  };

  const onDividerDrag = (event: DragEvent) => {
    if (!rect || !page || !devtoolsRect) return;
    if (event.phase === "start") {
      dragging.current = true;
      setDividerEngaged(true);
      return;
    }
    if (event.phase === "end") {
      dragging.current = false;
      setDividerEngaged(false);
      return;
    }
    const now = Date.now();
    if (now - lastDragResize.current < DRAG_RESIZE_MS) return;
    lastDragResize.current = now;
    const absPage = { x: rect.x + page.x, y: rect.y + page.y, width: page.width, height: page.height };
    const absDevtools = {
      x: rect.x + devtoolsRect.x,
      y: rect.y + devtoolsRect.y,
      width: devtoolsRect.width,
      height: devtoolsRect.height,
      dock,
    };
    setFraction(dividerFraction(absPage, absDevtools, event.x, event.y));
  };

  useImperativeHandle(
    ref,
    () => {
      const host = () => {
        const current = hostRef.current;
        if (!current) {
          throw new Error("this WebView has already been unmounted]");
        }
        return current;
      };
      const handle: WebViewHandle = {
        get webContents() {
          return host().webContents;
        },
        get state() {
          return stateRef.current;
        },
        onChange: (listener) => {
          changeListeners.current.add(listener);
          return () => {
            changeListeners.current.delete(listener);
          };
        },
        loadURL: (url) => host().navigate(url),
        focus: () => registry.focus(entry),
        blur: () => registry.blur(entry),
        back: () => host().back(),
        forward: () => host().forward(),
        reload: () => host().reload(),
        zoom: (direction) => host().zoom(direction),
        setAudioMuted: (muted) => host().setAudioMuted(muted),
        find: (text) => host().find(text),
        findNext: (forward) => host().findNext(forward),
        stopFind: () => host().stopFind(),
        cdp: (method, params) => host().cdp(method, params),
        openDevtools: () => setDevtoolsOpen(true),
        closeDevtools: () => hostRef.current?.closeDevtools(),
        closePopup: () => hostRef.current?.popup?.close(),
        recording: {
          start: (dir) => host().surface.startCapture(dir),
          onFrame: (listener) => {
            frameListeners.current.add(listener);
            return () => {
              frameListeners.current.delete(listener);
            };
          },
          frameSize: () => hostRef.current?.frameSize() ?? null,
          pinFrameRate: (pinned) => host().pinFrameRate(pinned),
          invalidate: () => hostRef.current?.invalidate(),
        },
      };
      handleEntries.set(handle, entry);
      entry.handle = handle;
      return handle;
    },
    [registry, entry],
  );

  const popupView = (() => {
    if (!popup || !page) return null;
    const headerPx = Math.round(rem * 1.7);
    const maxW = Math.round(page.width * 0.94);
    const maxH = Math.round(page.height * 0.94) - headerPx;
    return {
      ...popup,
      width: Math.max(60, Math.min(Math.round(popup.width * scale), maxW)),
      height: Math.max(60, Math.min(Math.round(popup.height * scale), maxH)),
    };
  })();

  if (hidden) {
    return <Box style={{ position: "absolute", inset: { top: 0, left: 0 }, width: 0, height: 0 }} />;
  }

  return (
    <Box ref={boxRef} style={{ ...props.style, overflow: "hidden" }}>
      {page && (
        <Box
          surface={surfaces.current?.page}
          style={{
            position: "absolute",
            inset: { top: page.y, left: page.x },
            width: page.width,
            height: page.height,
            cornerRadius: props.style?.cornerRadius,
            background: props.browserWindowOptions?.transparent ? undefined : theme.bg,
            opaque: !props.browserWindowOptions?.transparent,
          }}
          onPointer={(event: PointerEvent) => {
            if (menuRef.current) {
              if (event.kind === "down") setMenu(null);
              if (event.kind !== "up") return;
            }
            registry.focus(entry);
            hostRef.current?.pointer(event);
            propsRef.current.onPointer?.(event);
          }}
          onWheel={(event: WheelEvent) => {
            registry.focus(entry);
            hostRef.current?.wheel(event);
          }}
          onMouseEnter={() => {
            hover.current.page = true;
            syncCursor();
          }}
          onMouseLeave={() => {
            hover.current.page = false;
            syncCursor();
          }}
        />
      )}
      {devtoolsRect && surfaces.current && (
        <DevtoolsDockPane
          rect={devtoolsRect}
          dock={dock}
          rem={rem}
          theme={theme}
          surface={surfaces.current.devtools}
          dividerEngaged={dividerEngaged}
          onPointer={(event) => {
            const host = hostRef.current;
            if (!host?.devtools) return;
            registry.focus(entry, "devtools");
            host.devtools.input.pointer(event);
          }}
          onWheel={(event) => {
            const host = hostRef.current;
            if (!host?.devtools) return;
            registry.focus(entry, "devtools");
            host.devtools.input.wheel(event);
          }}
          onHover={(hovering) => {
            hover.current.devtools = hovering;
            syncCursor();
          }}
          onDividerDrag={onDividerDrag}
          onDividerHover={(hovering) => {
            hover.current.divider = hovering;
            syncCursor();
          }}
        />
      )}
      {popupView && page && surfaces.current && (
        <PopupCard
          view={popupView}
          page={page}
          rem={rem}
          theme={theme}
          surface={surfaces.current.popup}
          onPointer={(event) => {
            registry.focus(entry, "popup");
            hostRef.current?.popup?.input.pointer(event);
          }}
          onWheel={(event) => {
            registry.focus(entry, "popup");
            hostRef.current?.popup?.input.wheel(event);
          }}
          onHover={(hovering) => {
            hover.current.popup = hovering;
            syncCursor();
          }}
          onClose={() => hostRef.current?.popup?.close()}
        />
      )}
      {menu && rect && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          bounds={{ width: rect.width, height: rect.height }}
          items={menu.items}
          rem={rem}
          theme={theme}
          onAction={runMenu}
          onClose={() => setMenu(null)}
        />
      )}
    </Box>
  );
});

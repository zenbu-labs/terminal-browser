import { createElement, Profiler as ReactProfiler, type ReactNode } from "react";
import { ConcurrentRoot } from "react-reconciler/constants";

import {
  APP_VIEW,
  Bridge,
  ChangeSource,
  Container,
  DEVTOOLS_VIEW,
  devtoolsBridge,
  getBridge,
  MarkRef,
  reconciler,
} from "./reconciler-config";
import type { PasteSource, PastedImage, SelectionPart } from "./reconciler-config";
import type { EngineInfo, HostOptions, TerminalColors } from "./native";
import { Surface } from "./surface";
import { requestFrameRate } from "../web/frame-rate";
import { handleDevtoolsKey } from "./devtools/app";
import { installConsoleCapture } from "./devtools/console-capture";
import {
  attachDevtools,
  closeDevtools,
  engineOp,
  onEngineProfile,
  openDevtools,
  requestLayout,
  selectNode,
  startRecording,
  stopRecording,
  toggleDevtools,
  unmountDevtools,
} from "./devtools/controller";
import { exportProfile, setProfileDirectory } from "./devtools/export-profile";
import { installFiberHook } from "./devtools/fiber-hook";
import type { Rgba } from "./native";
import { publishColors } from "./colors";
import { refreshTheme } from "./devtools/theme";
import {
  devtoolsStore,
  DevtoolsTab,
  engineLogs,
  inspectorStore,
  layoutStore,
  LayoutRect,
  LayoutSnapshot,
  profilerStore,
  recordSpan,
} from "./devtools/stores";
import type { LogLevel } from "./devtools/store";

function appLog(level: LogLevel, target: string, text: string): void {
  engineLogs.push(level, target, text);
}

export {
  Box,
  Text,
  Input,
  Image,
  MarkedText,
  Path,
} from "./components";
export type { NodeHandle } from "./components";
export { appLog };
export { layoutStore, profilerStore, engineLogs } from "./devtools/stores";
export { useStore } from "./devtools/store";
export type { LogRow, LogBuffer } from "./devtools/store";
export type { DevtoolsTab, LayoutSnapshot, ProfileSession } from "./devtools/stores";
export type {
  BoxProps,
  TextProps,
  TextSpan,
  InputGutter,
  InputProps,
  MarkRef,
  PasteSource,
  PastedImage,
  CaretInfo,
  ChangeInfo,
  ChangeSource,
  ImageProps,
  ImageAdvancedProps,
  MarkedTextProps,
  ClickEvent,
  ContainerSelection,
  DragEvent,
  EventMods,
  MouseMoveEvent,
  ScrollEvent,
  SelectionPart,
  WheelEvent,
  PointerEvent,
  ShapeStroke,
  PathProps,
} from "./reconciler-config";
export type { Color, Edges, InsetEdges, InsetValue, ScrollbarStyle, Style } from "./styles";
export type {
  DiffEmphasis,
  DiffRow,
  EngineInfo,
  HighlightSpan,
  HostOptions,
  MarkdownBlock,
  MarkdownCell,
  MarkdownRow,
  MarkdownSpan,
  Rgba,
  SurfaceShm,
  TerminalColors,
} from "./native";
export { HIGHLIGHT_CAPTURES, captureFilmstrip, diff, encodeRecording, highlight, parseMarkdown } from "./native";
export { useTerminalColors } from "./colors";
export { Surface, SurfaceCapture } from "./surface";
export type {
  SurfaceFrame,
  SurfaceTexture,
  CaptureStats,
  CaptureFrameMeta,
  CaptureIndex,
} from "./surface";
export { Markdown } from "./markdown";
export type { MarkdownProps, MarkdownTheme } from "./markdown";
export { openDevtools, closeDevtools, toggleDevtools, requestLayout, engineOp };

/**
 * 
 * i think this api exists to support capturing a click to focus the input, 
 * this is dumb we can abstract this with a more cannonical capture/bubble phase
 */
export function setKeyCapture(keys: string[]): void {
  const bridge = getBridge();
  bridge.push(APP_VIEW, { op: "setKeyCapture", keys });
  bridge.flush();
}


export function setPointerShape(shape: string): void {
  const bridge = getBridge();
  bridge.push(APP_VIEW, { op: "setPointerShape", shape });
  bridge.flush();
}

export function requestClipboardImage(): void {
  const bridge = getBridge();
  bridge.push(APP_VIEW, { op: "requestClipboardImage" });
  bridge.flush();
}

export function setClipboard(text: string): void {
  const bridge = getBridge();
  bridge.push(APP_VIEW, { op: "setClipboard", text });
  bridge.flush();
}

export interface KeyMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  super: boolean;
}

export interface EngineKeyEvent {
  key: string;
  kind: "press" | "repeat" | "release";
  text?: string;
  mods: KeyMods;
}

export interface RootOptions {
  onKey?: (event: EngineKeyEvent) => void;
  onRightClick?: (event: { x: number; y: number }) => void;
  onPaste?: (text: string) => void;
  onFocus?: (focused: boolean) => void;
  onVisible?: (visible: boolean) => void;
  onPasteImage?: (image: PastedImage) => void;
  onEngineExit?: (error: string | null) => void;
  onResize?: (size: { width: number; height: number; basePx: number }) => void;
  onColors?: (colors: TerminalColors) => void;
  onLayout?: (snapshot: LayoutSnapshot) => void;
  onHostClosed?: () => void;
  onHandoff?: (handoff: { tty?: string; socket?: string }) => void;
  keyEventTypes?: boolean;
  focusClick?: boolean;
  devtools?: boolean;
  cwd?: string;
  tty?: string;
  host?: HostOptions;
  wrapper?: "tmux";
  sessionEnv?: NodeJS.ProcessEnv;
}


export interface RenderSettings {
  maxFps?: number;
  highlightTransmits?: boolean;
  frameEvents?: boolean;
}

export interface PixelRoot {
  info: EngineInfo;
  sharedTextures: boolean;
  render(element: ReactNode): void;
  flushSync<T>(fn: () => T): T;
  registerFont(path: string): Promise<number>;
  createSurface(): Surface;
  surfaceStats(): SurfaceStats;
  stop(): void;
  openDevtools(tab?: DevtoolsTab): void;
  closeDevtools(): void;
  startProfile(): void;
  stopProfile(): Promise<string | null>;
  setRender(settings: RenderSettings): void;
  setLogFile(path: string | null): void;
  setFocusClick(enabled: boolean): void;
  highlightTransmits(): boolean;
  // nudge resize is a ridiculous api
  nudgeResize(): void;
  queryLayout(): void;
  setPointerShape(shape: string): void;
  setClearColor(color: Rgba): void;
  setKeyCapture(keys: string[]): void;
  requestClipboardImage(): void;
  setClipboard(text: string): void;
  setTitle(text: string): void;
  retarget(target: RetargetTarget): Promise<void>;
}

export type RetargetTarget = { tty: string; wrapper?: "tmux" } | { host: HostOptions };

export interface SurfaceStats {
  submitted: number;
  coalesced: number;
  presented: number;
  rows: number;
}

/**
 * this looks like a really sus data type to me (probably should be a discriminated union over type?)
 */
interface EngineEventJson {
  type: string;
  atMs?: number;
  view?: number;
  node?: number;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  mods?: KeyMods;
  offset?: number | null;
  max?: number;
  width?: number;
  height?: number;
  cellWidth?: number;
  cellHeight?: number;
  basePx?: number;
  colors?: TerminalColors;
  message?: string;
  error?: string | null;
  ok?: boolean;
  info?: EngineInfo;
  tty?: string | null;
  socket?: string | null;
  path?: string;
  id?: number;
  cursor?: number;
  caret?: { x: number; y: number; w: number; h: number };
  source?: string;
  font?: number;
  seq?: number;
  token?: number;
  epochMs?: number;
  deltaX?: number;
  deltaY?: number;
  precise?: boolean;
  focused?: boolean;
  visible?: boolean;
  phase?: string;
  kind?: string;
  button?: string;
  w?: number;
  h?: number;
  parts?: unknown[];
  level?: string;
  target?: string;
  stats?: { frameMs: number; fps: number };
  nodes?: LayoutRect[];
  spans?: Array<{
    name: string;
    start: number;
    dur: number;
    depth: number;
    view: number;
    arg?: number | null;
  }>;
  counters?: Array<{ name: string; at: number; value: number }>;
  marks?: unknown[];
}

function applyColors(colors: TerminalColors): void {
  publishColors(colors);
  refreshTheme(colors);
  devtoolsStore.update((s) => ({ ...s, background: colors.background }));
}

export function createRoot(options: RootOptions = {}): PixelRoot {
  const bridge =
    options.tty || options.host
      ? new Bridge(options.tty, options.wrapper, options.sessionEnv, options.host)
      : getBridge(options.wrapper);
  const devtoolsEnabled = options.devtools !== false;
  if (options.cwd) setProfileDirectory(options.cwd);
  let devtoolsInstalled = false;
  const enableDevtools = () => {
    if (devtoolsInstalled) return;
    devtoolsInstalled = true;
    installConsoleCapture();
    installFiberHook();
    reconciler.injectIntoDevTools({
      bundleType: 0,
      version: "18.3.1",
      rendererPackageName: "pixel-react",
    });
    bridge.onFlush = (sample) => {
      recordSpan({
        name: `ops flush (${sample.ops} ops)`,
        start: sample.start,
        dur: sample.dur,
        depth: 0,
        lane: "bridge",
        arg: sample.seq,
      });
    };
  };
  const info = JSON.parse(bridge.engine.info()) as EngineInfo;
  applyColors(info.colors);
  bridge.engine.setKeyEventTypes(!!options.keyEventTypes);
  if (options.focusClick !== undefined) bridge.engine.setFocusClick(options.focusClick);
  if (options.onLayout) {
    bridge.afterCommit = (view) => {
      if (view !== APP_VIEW) return;
      bridge.push(APP_VIEW, { op: "queryLayout" });
      bridge.flush();
    };
  }
  const container: Container = { bridge, view: APP_VIEW, children: [] };
  bridge.containers[APP_VIEW] = container;
  const root = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    "pixel",
    (error: unknown) => {
      engineLogs.push("error", "react", String(error));
    },
    null
  );
  if (devtoolsEnabled) installConsoleCapture();

  const fontIds = new Map<string, number>();
  const fontRequests = new Map<
    string,
    Array<{ resolve: (font: number) => void; reject: (error: Error) => void }>
  >();
  const retargets: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  const dispatch = (event: EngineEventJson) => {
    const view = event.view ?? APP_VIEW;
    switch (event.type) {
      case "click": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onClick?.({ x: event.x!, y: event.y!, offset: event.offset ?? undefined });
        break;
      }
      case "clickOutside": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onClickOutside?.({ x: event.x!, y: event.y! });
        break;
      }
      case "change": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onChange?.(event.text!, {
          cursor: event.cursor ?? 0,
          ...(event.caret ?? { x: 0, y: 0, w: 0, h: 0 }),
          source: (event.source as ChangeSource) ?? "edit",
          marks: (event.marks as MarkRef[] | undefined) ?? [],
        });
        break;
      }
      case "caret": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onCaret?.({
          cursor: event.cursor ?? 0,
          ...(event.caret ?? { x: 0, y: 0, w: 0, h: 0 }),
        });
        break;
      }
      case "submit": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onSubmit?.(event.text!, (event.marks as MarkRef[] | undefined) ?? []);
        break;
      }
      case "serializeMarks": {
        const request = (event.marks ?? []) as unknown as Array<{
          node: number;
          id: number;
          index: number;
        }>;
        const replies: Array<{ index: number; data: string }> = [];
        for (const entry of request) {
          const props = bridge.propsById[view]?.get(entry.node);
          const data = props?.serializeMark?.(entry.id);
          if (typeof data === "string") replies.push({ index: entry.index, data });
        }
        bridge.push(view, { op: "richClipboard", token: event.token as number, marks: replies });
        bridge.flush();
        break;
      }
      case "pasteImage": {
        const image = {
          path: event.path!,
          width: event.width!,
          height: event.height!,
          source: event.source as PasteSource,
        };
        const props = bridge.propsById[view]?.get(event.node!);
        if (props?.onPasteImage) {
          props.onPasteImage(image);
        } else if (view === APP_VIEW) {
          options.onPasteImage?.(image);
        }
        break;
      }
      case "scroll": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onScroll?.({ offset: event.offset!, max: event.max! });
        break;
      }
      case "selection": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onSelection?.({
          text: event.text ?? "",
          x: event.x ?? 0,
          y: event.y ?? 0,
          w: event.w ?? 0,
          h: event.h ?? 0,
          parts: (event.parts ?? []) as SelectionPart[],
        });
        break;
      }
      case "drag": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onDrag?.({
          phase: event.phase as "start" | "move" | "end",
          x: event.x!,
          y: event.y!,
          mods: event.mods ?? { shift: false, alt: false, ctrl: false, super: false },
        });
        break;
      }
      case "hoverEnter": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onMouseEnter?.();
        break;
      }
      case "hoverLeave": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onMouseLeave?.();
        break;
      }
      case "wheel": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onWheel?.({
          x: event.x!,
          y: event.y!,
          deltaX: event.deltaX ?? 0,
          deltaY: event.deltaY ?? 0,
          precise: !!event.precise,
          mods: event.mods ?? { shift: false, alt: false, ctrl: false, super: false },
        });
        break;
      }
      case "pointer": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onPointer?.({
          kind: event.kind as "down" | "up" | "move",
          button: event.button as "left" | "middle" | "right" | "none",
          mods: event.mods!,
          x: event.x!,
          y: event.y!,
        });
        break;
      }
      case "mouseMove": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onMouseMove?.({ x: event.x!, y: event.y! });
        break;
      }
      case "colors": {
        info.colors = event.colors!;
        applyColors(info.colors);
        options.onColors?.(info.colors);
        break;
      }
      case "resize": {
        const size = {
          width: event.width!,
          height: event.height!,
          basePx: event.basePx!,
        };
        if (view === APP_VIEW) {
          info.width = size.width;
          info.height = size.height;
          info.cellWidth = event.cellWidth!;
          info.cellHeight = event.cellHeight!;
          info.basePx = size.basePx;
          options.onResize?.(size);
        } else if (devtoolsBridge() === bridge) {
          devtoolsStore.update((s) => ({ ...s, ...size }));
        }
        break;
      }
      case "key": {
        if (view === DEVTOOLS_VIEW) {
          if (devtoolsBridge() === bridge) handleDevtoolsKey(event.key!);
        } else {
          options.onKey?.({
            key: event.key!,
            kind: event.kind as "press" | "repeat" | "release",
            text: event.text,
            mods: event.mods!,
          });
        }
        break;
      }
      case "rightClick":
        if (view === APP_VIEW) {
          options.onRightClick?.({ x: event.x!, y: event.y! });
        }
        break;
      case "paste":
        if (view === APP_VIEW) options.onPaste?.(event.text!);
        break;
      case "focus":
        options.onFocus?.(!!event.focused);
        break;
      case "visible":
        options.onVisible?.(!!event.visible);
        break;
      case "devtools":
        enableDevtools();
        attachDevtools(bridge);
        toggleDevtools();
        break;
      case "inspect":
        if (devtoolsEnabled && view === APP_VIEW && event.node != null) {
          enableDevtools();
          attachDevtools(bridge);
          openDevtools(event.node);
          selectNode(event.node, true);
        }
        break;
      case "log":
        engineLogs.push(
          (event.level as LogLevel) ?? "info",
          event.target ?? "engine",
          event.message ?? event.text ?? "",
          event.epochMs
        );
        break;
      case "layout": {
        const rects = new Map<number, LayoutRect>();
        for (const node of event.nodes ?? []) rects.set(node.id, node);
        const snapshot: LayoutSnapshot = {
          rects,
          stats: event.stats ?? { frameMs: 0, fps: 0 },
          width: event.width ?? 0,
          height: event.height ?? 0,
          at: Date.now(),
        };
        layoutStore.set(snapshot);
        options.onLayout?.(snapshot);
        break;
      }
      case "profile":
        onEngineProfile({
          epochMs: event.epochMs ?? 0,
          spans: event.spans ?? [],
          counters: event.counters ?? [],
          marks: (event.marks as Array<{
            name: string;
            label: string;
            start: number;
            dur: number;
            view: number;
          }> | undefined) ?? [],
        });
        break;
      case "error":
        engineLogs.push("error", "bridge", event.message ?? "unknown bridge error");
        break;
      case "hostClosed":
        options.onHostClosed?.();
        break;
      case "handoff":
        options.onHandoff?.({ tty: event.tty ?? undefined, socket: event.socket ?? undefined });
        break;
      case "retargeted": {
        const waiting = retargets.shift();
        if (event.ok && event.info) {
          Object.assign(info, event.info);
          applyColors(info.colors);
          waiting?.resolve();
        } else {
          waiting?.reject(new Error(event.error ?? "retarget failed"));
        }
        break;
      }
      case "fontRegistered": {
        const pending = fontRequests.get(event.path!) ?? [];
        fontRequests.delete(event.path!);
        if (event.font != null) {
          fontIds.set(event.path!, event.font);
          for (const p of pending) p.resolve(event.font);
        } else {
          const error = new Error(event.error ?? "font failed to load");
          for (const p of pending) p.reject(error);
        }
        break;
      }
      case "exit":
        if (options.onEngineExit) {
          options.onEngineExit(event.error ?? null);
        } else {
          if (event.error) {
            process.stderr.write(`pixel-react: engine exited: ${event.error}\n`);
          }
          process.exit(event.error ? 1 : 0);
        }
        break;
    }
  };

  bridge.engine.start((err, json) => {
    if (err) return;
    const event = JSON.parse(json) as EngineEventJson;
    dispatch(event);
    if (event.atMs && event.type !== "profile" && profilerStore.get().recording) {
      const now = performance.timeOrigin + performance.now();
      recordSpan({
        name: `event ${event.type}`,
        start: event.atMs,
        dur: Math.max(now - event.atMs, 0.01),
        depth: 0,
        lane: "bridge",
      });
    }
  });

  if (!devtoolsEnabled || options.onRightClick) {
    bridge.push(APP_VIEW, { op: "setDefaultMenu", on: false });
    bridge.flush();
  }

  /**
   * 
   * fixme: node types?
   */
  const forwardResize = () => bridge.engine.applyOps(JSON.stringify({ view: 0, ops: [] }));
  const ownsStdout = !options.tty && !options.host;
  if (ownsStdout) process.stdout.on("resize", forwardResize);

  const restore = () => bridge.engine.stop();
  process.on("exit", restore);

  const onAppRender = (
    _id: string,
    phase: "mount" | "update" | "nested-update",
    actualDuration: number,
    _baseDuration: number,
    startTime: number,
    commitTime: number
  ) => {
    recordSpan({
      name: `react ${phase}`,
      start: performance.timeOrigin + startTime,
      dur: Math.max(commitTime - startTime, actualDuration),
      depth: 0,
      lane: "react",
      self: actualDuration,
    });
  };

  let nextSurfaceId = 1;

  return {
    info,
    sharedTextures: typeof bridge.engine.updateSurfaceTexture === "function",
    render(element: ReactNode) {
      const wrapped = devtoolsEnabled
        ? createElement(ReactProfiler, { id: "pixel-app", onRender: onAppRender }, element)
        : element;
      reconciler.updateContainer(wrapped, root, null, null);
    },
    flushSync(fn) {
      return reconciler.flushSync(fn);
    },
    registerFont(path: string) {
      const known = fontIds.get(path);
      if (known != null) return Promise.resolve(known);
      return new Promise<number>((resolve, reject) => {
        const pending = fontRequests.get(path);
        if (pending) {
          pending.push({ resolve, reject });
          return;
        }
        fontRequests.set(path, [{ resolve, reject }]);
        bridge.push(APP_VIEW, { op: "registerFont", path });
        bridge.flush();
      });
    },
    createSurface() {
      return new Surface(bridge.engine, nextSurfaceId++);
    },
    surfaceStats() {
      return JSON.parse(bridge.engine.surfaceStats()) as SurfaceStats;
    },
    stop() {
      reconciler.flushSync(() => {
        reconciler.updateContainer(null, root, null, null);
      });
      if (devtoolsBridge() === bridge) unmountDevtools();
      bridge.engine.stop();
      if (ownsStdout) process.stdout.off("resize", forwardResize);
      process.off("exit", restore);
    },
    openDevtools(tab?: DevtoolsTab) {
      enableDevtools();
      attachDevtools(bridge);
      if (tab) devtoolsStore.update((s) => ({ ...s, tab }));
      openDevtools();
    },
    startProfile() {
      enableDevtools();
      attachDevtools(bridge);
      startRecording();
    },
    stopProfile() {
      return new Promise<string | null>((resolve) => {
        const now = profilerStore.get();
        if (!now.recording && !now.pendingStop) {
          resolve(exportProfile());
          return;
        }
        const unsubscribe = profilerStore.subscribe(() => {
          const state = profilerStore.get();
          if (state.recording || state.pendingStop) return;
          unsubscribe();
          resolve(exportProfile());
        });
        stopRecording();
      });
    },
    setRender(settings: RenderSettings) {
      // The browser should not bother producing frames the engine would only drop.
      if (settings.maxFps !== undefined) requestFrameRate(settings.maxFps);
      devtoolsStore.update((s) => ({
        ...s,
        maxFps: settings.maxFps ?? s.maxFps,
        highlightTransmits: settings.highlightTransmits ?? s.highlightTransmits,
      }));
      bridge.push(APP_VIEW, { op: "setRender", ...settings });
      bridge.flush();
    },
    setLogFile(path: string | null) {
      bridge.push(APP_VIEW, { op: "setLogFile", path });
      bridge.flush();
    },
    setFocusClick(enabled: boolean) {
      bridge.push(APP_VIEW, { op: "setFocusClick", on: enabled });
      bridge.flush();
    },
    highlightTransmits() {
      return devtoolsStore.get().highlightTransmits;
    },
    closeDevtools() {
      if (devtoolsBridge() === bridge) closeDevtools();
    },
    // shitty name     
    nudgeResize() {
      forwardResize();
    },
    queryLayout() {
      bridge.push(APP_VIEW, { op: "queryLayout" });
      bridge.flush();
    },
    setPointerShape(shape: string) {
      bridge.push(APP_VIEW, { op: "setPointerShape", shape });
      bridge.flush();
    },
    setClearColor(color: Rgba) {
      bridge.push(APP_VIEW, { op: "setClearColor", color });
      bridge.flush();
    },
    setKeyCapture(keys: string[]) {
      bridge.push(APP_VIEW, { op: "setKeyCapture", keys });
      bridge.flush();
    },
    requestClipboardImage() {
      bridge.push(APP_VIEW, { op: "requestClipboardImage" });
      bridge.flush();
    },
    setClipboard(text: string) {
      bridge.push(APP_VIEW, { op: "setClipboard", text });
      bridge.flush();
    },
    setTitle(text: string) {
      bridge.push(APP_VIEW, { op: "setTitle", text });
      bridge.flush();
    },
    retarget(target: RetargetTarget) {
      return new Promise<void>((resolve, reject) => {
        retargets.push({ resolve, reject });
        bridge.push(APP_VIEW, { op: "retarget", ...target });
        bridge.flush();
      });
    },
  };
}

export { inspectorStore };

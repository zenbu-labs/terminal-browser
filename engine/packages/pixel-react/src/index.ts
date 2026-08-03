import { createElement, Profiler as ReactProfiler, type ReactNode } from "react";
import { ConcurrentRoot } from "react-reconciler/constants";

import {
  APP_VIEW,
  Bridge,
  ChangeSource,
  Container,
  DEVTOOLS_VIEW,
  getBridge,
  MarkRef,
  reconciler,
} from "./reconciler-config";
import type { PasteSource, PastedImage, SelectionPart } from "./reconciler-config";
import type { EngineInfo, TerminalColors } from "./native";
import { Surface } from "./surface";
import { handleDevtoolsKey } from "./devtools/app";
import { installConsoleCapture } from "./devtools/console-capture";
import {
  closeDevtools,
  engineOp,
  onEngineProfile,
  openDevtools,
  requestLayout,
  selectNode,
  toggleDevtools,
  unmountDevtools,
} from "./devtools/controller";
import { installFiberHook } from "./devtools/fiber-hook";
import { publishColors } from "./colors";
import { refreshTheme } from "./devtools/theme";
import {
  devtoolsStore,
  engineLogs,
  inspectorStore,
  layoutStore,
  LayoutRect,
  profilerStore,
  recordSpan,
} from "./devtools/stores";
import type { LogLevel } from "./devtools/store";

export {
  Box,
  Text,
  Input,
  Image,
  MarkedText,
  Path,
} from "./components";
export type { NodeHandle } from "./components";
export { layoutStore, profilerStore } from "./devtools/stores";
export type { LayoutSnapshot, ProfileSession } from "./devtools/stores";
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
  MarkdownBlock,
  MarkdownCell,
  MarkdownRow,
  MarkdownSpan,
  Rgba,
  SurfacePixmap,
  TerminalColors,
} from "./native";
export { HIGHLIGHT_CAPTURES, diff, highlight, parseMarkdown } from "./native";
export { useTerminalColors } from "./colors";
export { Surface } from "./surface";
export type { SurfaceFrame, SurfaceTexture } from "./surface";
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
  onPasteImage?: (image: PastedImage) => void;
  onEngineExit?: (error: string | null) => void;
  onResize?: (size: { width: number; height: number; basePx: number }) => void;
  /** the terminal's palette changed — rebuild any theme derived from it */
  onColors?: (colors: TerminalColors) => void;
  keyEventTypes?: boolean;
  devtools?: boolean;
  tty?: string;
  tmux?: boolean;
}

export interface PixelRoot {
  info: EngineInfo;
  sharedTextures: boolean;
  render(element: ReactNode): void;
  registerFont(path: string): Promise<number>;
  createSurface(): Surface;
  surfaceStats(): SurfaceStats;
  stop(): void;
  openDevtools(): void;
  closeDevtools(): void;
  // nudge resize sounds like a ridiculous api
  nudgeResize(): void;
  setPointerShape(shape: string): void;
  setKeyCapture(keys: string[]): void;
  requestClipboardImage(): void;
  setClipboard(text: string): void;
}

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
  basePx?: number;
  colors?: TerminalColors;
  message?: string;
  error?: string | null;
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
  // input mark refs on change/submit; profiler marks on profile
  marks?: unknown[];
}

function applyColors(colors: TerminalColors): void {
  publishColors(colors);
  refreshTheme(colors);
  devtoolsStore.update((s) => ({ ...s, background: colors.background }));
}

export function createRoot(options: RootOptions = {}): PixelRoot {
  const bridge = options.tty ? new Bridge(options.tty, options.tmux) : getBridge();
  const devtoolsEnabled = options.devtools !== false && bridge === getBridge();
  if (devtoolsEnabled) {
    installConsoleCapture();
    installFiberHook();
  }
  const info = JSON.parse(bridge.engine.info()) as EngineInfo;
  applyColors(info.colors);
  bridge.engine.setKeyEventTypes(!!options.keyEventTypes);
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
  if (devtoolsEnabled) {
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
  }

  const fontIds = new Map<string, number>();
  const fontRequests = new Map<
    string,
    Array<{ resolve: (font: number) => void; reject: (error: Error) => void }>
  >();

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
          info.basePx = size.basePx;
          options.onResize?.(size);
        } else {
          devtoolsStore.update((s) => ({ ...s, ...size }));
        }
        break;
      }
      case "key": {
        if (view === DEVTOOLS_VIEW) {
          handleDevtoolsKey(event.key!);
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
      case "inspect":
        if (devtoolsEnabled && view === APP_VIEW && event.node != null) {
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
        layoutStore.set({
          rects,
          stats: event.stats ?? { frameMs: 0, fps: 0 },
          width: event.width ?? 0,
          height: event.height ?? 0,
          at: Date.now(),
        });
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
  if (!options.tty) process.stdout.on("resize", forwardResize);

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
    sharedTextures:
      typeof bridge.engine.updateSurfaceTexture === "function" ||
      typeof bridge.engine.updateSurfacePixmap === "function",
    render(element: ReactNode) {
      const wrapped = devtoolsEnabled
        ? createElement(ReactProfiler, { id: "pixel-app", onRender: onAppRender }, element)
        : element;
      reconciler.updateContainer(wrapped, root, null, null);
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
      unmountDevtools();
      bridge.engine.stop();
      if (!options.tty) process.stdout.off("resize", forwardResize);
      process.off("exit", restore);
    },
    openDevtools() {
      openDevtools();
    },
    closeDevtools() {
      closeDevtools();
    },
    nudgeResize() {
      forwardResize();
    },
    setPointerShape(shape: string) {
      bridge.push(APP_VIEW, { op: "setPointerShape", shape });
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
  };
}

export { inspectorStore };

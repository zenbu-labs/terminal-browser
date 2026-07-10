import { createElement, Profiler as ReactProfiler, type ReactNode } from "react";
import { ConcurrentRoot } from "react-reconciler/constants";

import {
  APP_VIEW,
  Container,
  DEVTOOLS_VIEW,
  getBridge,
  reconciler,
} from "./hostConfig";
import type { EngineInfo } from "./native";
import { handleDevtoolsKey } from "./devtools/App";
import { installConsoleCapture } from "./devtools/consoleCapture";
import {
  closeDevtools,
  onEngineProfile,
  openDevtools,
  selectNode,
  toggleDevtools,
  unmountDevtools,
} from "./devtools/controller";
import { installFiberHook } from "./devtools/fiberHook";
import {
  devtoolsStore,
  engineLogs,
  inspectorStore,
  layoutStore,
  LayoutRect,
  recordSpan,
} from "./devtools/stores";
import type { LogLevel } from "./devtools/store";

export { Box, Text, Input } from "./components";
export type { NodeHandle } from "./components";
export type {
  BoxProps,
  TextProps,
  InputProps,
  ClickEvent,
  ScrollEvent,
  WheelEvent,
} from "./hostConfig";
export type { Color, Edges, ScrollbarStyle, Style } from "./styles";
export type { EngineInfo, Rgba } from "./native";
export { openDevtools, closeDevtools, toggleDevtools };

export interface KeyMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  super: boolean;
}

export interface EngineKeyEvent {
  key: string;
  mods: KeyMods;
}

export interface RootOptions {
  onKey?: (event: EngineKeyEvent) => void;
  /** Providing this disables the engine's built-in context menu. */
  onRightClick?: (event: { x: number; y: number }) => void;
  onPaste?: (text: string) => void;
  onEngineExit?: (error: string | null) => void;
  onResize?: (size: { width: number; height: number; basePx: number }) => void;
  /** Set false to disable the devtools integration entirely. */
  devtools?: boolean;
}

export interface PixelRoot {
  info: EngineInfo;
  render(element: ReactNode): void;
  stop(): void;
  openDevtools(): void;
  closeDevtools(): void;
}

interface EngineEventJson {
  type: string;
  view?: number;
  node?: number;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  mods?: KeyMods;
  offset?: number;
  max?: number;
  width?: number;
  height?: number;
  basePx?: number;
  message?: string;
  error?: string | null;
  seq?: number;
  epochMs?: number;
  deltaX?: number;
  deltaY?: number;
  precise?: boolean;
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
}

export function createRoot(options: RootOptions = {}): PixelRoot {
  const devtoolsEnabled = options.devtools !== false;
  if (devtoolsEnabled) {
    installConsoleCapture();
    installFiberHook();
  }
  const bridge = getBridge();
  const info = JSON.parse(bridge.engine.info()) as EngineInfo;
  const container: Container = { view: APP_VIEW, children: [] };
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

  const dispatch = (event: EngineEventJson) => {
    const view = event.view ?? APP_VIEW;
    switch (event.type) {
      case "click": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onClick?.({ x: event.x!, y: event.y! });
        break;
      }
      case "change": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onChange?.(event.text!);
        break;
      }
      case "submit": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onSubmit?.(event.text!);
        break;
      }
      case "scroll": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onScroll?.({ offset: event.offset!, max: event.max! });
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
        });
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
          options.onKey?.({ key: event.key!, mods: event.mods! });
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
        onEngineProfile({ epochMs: event.epochMs ?? 0, spans: event.spans ?? [] });
        break;
      case "error":
        engineLogs.push("error", "bridge", event.message ?? "unknown bridge error");
        break;
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
    dispatch(JSON.parse(json) as EngineEventJson);
  });

  if (!devtoolsEnabled || options.onRightClick) {
    bridge.push(APP_VIEW, { op: "setDefaultMenu", on: false });
    bridge.flush();
  }

  const forwardResize = () => bridge.engine.applyOps(JSON.stringify({ view: 0, ops: [] }));
  process.stdout.on("resize", forwardResize);

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

  return {
    info,
    render(element: ReactNode) {
      const wrapped = devtoolsEnabled
        ? createElement(ReactProfiler, { id: "pixel-app", onRender: onAppRender }, element)
        : element;
      reconciler.updateContainer(wrapped, root, null, null);
    },
    stop() {
      reconciler.flushSync(() => {
        reconciler.updateContainer(null, root, null, null);
      });
      unmountDevtools();
      bridge.engine.stop();
      process.stdout.off("resize", forwardResize);
      process.off("exit", restore);
    },
    openDevtools() {
      openDevtools();
    },
    closeDevtools() {
      closeDevtools();
    },
  };
}

export { inspectorStore };

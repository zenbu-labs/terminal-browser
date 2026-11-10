import { createContext, useSyncExternalStore } from "react";

import type { EngineKeyEvent, LayoutSnapshot, PastedImage, PixelRoot, PointerShape, TerminalColors } from "./react";
import { createStore } from "./react/devtools/store";
import type { Store } from "./react/devtools/store";
import type { PageHost } from "./web/host";
import type { PageInput } from "./web/input";
import type { TerminalTheme } from "./web/session";

export interface ViewEntry {
  host: PageHost | null;
  handle: object | null;
  devtoolsEnabled: boolean;
  externalDevtools: boolean;
  externalDevtoolsAction: ((action: "close" | "dock-bottom" | "dock-right") => void) | null;
  externalDevtoolsCursor: ((shape: PointerShape) => void) | null;
  toggleDevtools(): void;
  handleKey(event: EngineKeyEvent): boolean;
  // Views without a PageHost (a guest app's pixels) take these directly.
  paste?(text: string): void;
  setActive?(focused: boolean): void;
}

export interface RegistryHooks {
  quit(entry: ViewEntry | null): void;
}

export class ViewRegistry {
  readonly views = new Set<ViewEntry>();
  focused: ViewEntry | null = null;
  readonly resizeListeners = new Set<() => void>();
  readonly rectWatchers = new Set<() => number | undefined>();

  readonly layout: Store<LayoutSnapshot> = createStore<LayoutSnapshot>({
    rects: new Map(),
    stats: { frameMs: 0, fps: 0 },
    width: 0,
    height: 0,
    at: 0,
  });
  readonly colors: Store<TerminalColors>;

  constructor(
    readonly root: PixelRoot,
    readonly displayScale: number,
    private readonly noSuper: boolean,
    private readonly hooks: RegistryHooks,
  ) {
    this.colors = createStore<TerminalColors>(root.info.colors);
  }

  register(entry: ViewEntry) {
    this.views.add(entry);
  }

  unregister(entry: ViewEntry) {
    this.views.delete(entry);
    if (this.focused === entry) this.focused = null;
  }

  *hosts(): Iterable<PageHost> {
    for (const view of this.views) if (view.host) yield view.host;
  }

  focus(entry: ViewEntry, target: "page" | "devtools" | "popup" = "page") {
    if (this.focused !== entry) {
      this.setActive(this.focused, false);
      this.focused = entry;
      if (!entry.host) entry.setActive?.(true);
    }
    const host = entry.host;
    if (!host) return;
    if (target === "devtools") host.focusDevtools();
    else if (target === "page") host.focusContent();
  }

  blur(entry: ViewEntry) {
    if (this.focused !== entry) return;
    this.setActive(entry, false);
    this.focused = null;
  }

  private setActive(entry: ViewEntry | null, active: boolean) {
    if (!entry) return;
    if (entry.host) entry.host.setActive(active);
    else entry.setActive?.(active);
  }

  quit(entry: ViewEntry | null) {
    this.hooks.quit(entry);
  }

  watchedRects(): number[] {
    const ids: number[] = [];
    for (const watcher of this.rectWatchers) {
      const id = watcher();
      if (id != null) ids.push(id);
    }
    return ids;
  }

  queryLayout() {
    this.root.queryLayout(this.watchedRects());
  }

  background(): string {
    const bg = this.root.info.colors.background ?? [30, 32, 38, 255];
    return `#${bg.slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }

  theme(): TerminalTheme | null {
    const colors = this.root.info.colors;
    if (!colors.background || !colors.foreground) return null;
    const rgb = (channelled: number[] | null) =>
      channelled ? [channelled[0], channelled[1], channelled[2]] : null;
    return {
      background: rgb(colors.background) as number[],
      foreground: rgb(colors.foreground) as number[],
      ansi: Array.from({ length: 16 }, (_, at) => rgb(colors.palette[at] ?? null)),
    };
  }

  handleKey(event: EngineKeyEvent) {
    const view = this.focused;
    if (!view) return;
    if (view.handleKey(event)) return;
    const host = view.host;
    if (!host) return;
    if (host.popup) {
      if (event.kind !== "release" && event.key === "escape") {
        host.popup.close();
        return;
      }
      this.clipboardKeys(event, host.popup.input);
      host.popup.input.key(event);
      return;
    }
    if (event.kind !== "release" && view.devtoolsEnabled && this.isDevtoolsKey(event)) {
      view.toggleDevtools();
      return;
    }
    if (host.devtoolsFocused && host.devtools) {
      this.clipboardKeys(event, host.devtools.input);
      host.devtools.input.key(event);
      return;
    }
    this.clipboardKeys(event, host);
    host.key(event);
  }

  handlePaste(text: string) {
    const host = this.focused?.host;
    if (!host) {
      this.focused?.paste?.(text);
      return;
    }
    if (host.popup) host.popup.input.paste(text);
    else if (host.devtoolsFocused && host.devtools) host.devtools.input.paste(text);
    else host.paste(text);
  }

  handlePasteImage(image: PastedImage) {
    const host = this.focused?.host;
    if (!host) return;
    if (host.popup) host.popup.input.pasteImage(image);
    else if (host.devtoolsFocused && host.devtools) host.devtools.input.pasteImage(image);
    else host.pasteImage(image);
  }

  handleTerminalFocus(focused: boolean) {
    this.setActive(this.focused, focused);
  }

  private clipboardKeys(
    event: EngineKeyEvent,
    target: { selectionText(): Promise<string> } | PageInput,
  ) {
    if (event.kind !== "press") return;
    if (this.clipboardHeld(event) && event.key === "v") this.root.requestClipboardImage();
    if (this.clipboardHeld(event) && (event.key === "c" || event.key === "x")) {
      void target.selectionText().then((text) => {
        if (text) this.root.setClipboard(text);
      });
    }
  }

  private cmdHeld(event: EngineKeyEvent): boolean {
    return event.mods.super || (this.noSuper && event.mods.alt);
  }

  private clipboardHeld(event: EngineKeyEvent): boolean {
    if (this.cmdHeld(event)) return true;
    return (
      process.platform === "linux" && event.mods.ctrl && !event.mods.shift && !event.mods.alt
    );
  }

  private isDevtoolsKey(event: EngineKeyEvent): boolean {
    const { key, mods } = event;
    if (key === "f12" && !mods.super && !mods.ctrl && !mods.alt && !mods.shift) return true;
    if (key === "i" && mods.ctrl && mods.shift && !mods.alt && !mods.super) return true;
    if (process.platform === "darwin" && key === "i" && this.cmdHeld(event) && mods.alt) return true;
    return false;
  }
}

export const RootContext = createContext<ViewRegistry | null>(null);

export function useRegistryColors(registry: ViewRegistry): TerminalColors {
  return useSyncExternalStore(registry.colors.subscribe, registry.colors.get, registry.colors.get);
}

export const handleEntries = new WeakMap<object, ViewEntry>();

import os from "node:os";
import type {
  DragEvent,
  EngineKeyEvent,
  MouseMoveEvent,
  PointerEvent,
  Surface,
  WheelEvent,
} from "pixel-react";
import type { BrowserController } from "../page/controller";
import { zoomDirection } from "../page/zoom";
import { toolbarSize } from "../ui/markup-canvas";
import { recordBarCluster, recordBarMetrics } from "../ui/record-bar";
import type { ChromeLayout } from "../ui/types";
import {
  compositeRecording,
  writeFailedManifest,
  writeProcessingManifest,
} from "./compositor";
import type { Keyframe } from "./compositor";
import {
  CROP_SCOPES,
  MARKUP_COLORS,
  MarkupStore,
  TOOLS,
  bboxOf,
  handlesFor,
  hitTest,
  moveObject,
  pointInRect,
  rectFromPoints,
  rectsIntersect,
  resizeObject,
  unionRects,
} from "./model";
import type { CropScope, HandleId, MarkupObject, Rect, Tool, Vec } from "./model";
import { listStep } from "../session/keybindings";
import { newRecordingDir } from "./paths";
import {
  CLICK_PULSE_MS,
  CURSOR_LERP_MAX_MS,
  LINK_HOLD_MS,
  TOAST_FADE_MS,
  buildSampleTimes,
} from "./samples";
import { MAX_RECORDING_MS, Recorder, lastIndexAtOrBefore } from "./recorder";
import type { RecordActions, RecordInteraction, RecordShot, RecordView } from "./types";

export interface RecordHost {
  root: { createSurface(): Surface };
  layout(): ChromeLayout | null;
  canvasRect(): Rect;
  page(): { url: string; title: string };
  fontFile(): string;
  requestRender(): void;
  blurToOverlay(): void;
  refocusPage(): void;
  reviewStarted(): void;
  setKeyCapture(keys: string[]): void;
  setClipboard(text: string): void;
  recordKey(event: EngineKeyEvent): boolean;
  toast(name: string, state: "done" | "failed", detail?: string): void;
  finished(): void;
}

const IDLE_GAP_MS = 3000;

const FLASH_MS = 450;


const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  p: "pen",
  a: "arrow",
  o: "oval",
  t: "text",
  c: "crop",
};

interface Transform {
  scale: number;
  tx: number;
  ty: number;
  fit: number;
  frameKey: string;
}

type Gesture =
  | { type: "marquee"; anchor: Vec; rect: Rect; hadSelection: boolean; wasPlaying: boolean }
  | { type: "move"; ids: number[]; primary: number; last: Vec; moved: number; viaBounds?: boolean }
  | { type: "resize"; id: number; handle: HandleId; start: MarkupObject }
  | { type: "pen"; id: number; last: Vec }
  | { type: "arrow"; id: number; from: Vec }
  | { type: "oval"; id: number; anchor: Vec }
  | { type: "crop"; id: number; anchor: Vec }
  | { type: "text"; start: Vec; moved: number };

export class RecordSession {
  readonly surface: Surface;
  readonly actions: RecordActions;

  private readonly host: RecordHost;
  readonly controller: BrowserController;
  private readonly recorder: Recorder;
  private readonly markup = new MarkupStore();

  private scrub: number | null = null;
  private scrubMs = 0;
  private liveTick: ReturnType<typeof setInterval> | null = null;
  private playing = false;
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private lastPlayAt = 0;
  private tool: Tool = "select";
  private cropScope: CropScope = "frame";
  private color = MARKUP_COLORS[0];
  private selection: number[] = [];
  private editing: { id: number; draft: string } | null = null;
  private transform: Transform | null = null;
  private toolbarPos: Vec | null = null;
  private completing = false;
  private gesture: Gesture | null = null;
  private pointerLocal: Vec | null = null;
  private lastClick = { at: 0, x: 0, y: 0 };
  private dragFrac: number | null = null;
  private cropMenu: { focus: number | null } | null = null;
  private hold: { fromMs: number; at: number; direction: number } | null = null;
  private flashAt = 0;
  private flashTimer: ReturnType<typeof setInterval> | null = null;
  private presentAt = 0;
  private presentTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly shots: Keyframe[] = [];
  private thumbSurface: Surface | null = null;
  // eh?
  private thumbRing = "";
  private trimRange: { startMs: number; endMs: number } | null = null;
  private stripSurface: Surface | null = null;
  // eh?
  private stripKey = "";
  private stripBusy = false;
  private gapCache: {
    frames: number;
    trail: number;
    gaps: { start: number; end: number }[];
    lastMs: number;
  } | null = null;
  private interactionsCache: { counts: string; events: RecordInteraction[] } | null = null;
  private sampleTimes: number[] | null = null;
  private toolbarGrab: Vec | null = null;

  static async create(host: RecordHost, controller: BrowserController): Promise<RecordSession> {
    const session = new RecordSession(host, controller);
    await session.recorder.start();
    return session;
  }

  private constructor(host: RecordHost, controller: BrowserController) {
    this.host = host;
    this.controller = controller;
    this.surface = host.root.createSurface();
    this.recorder = new Recorder(controller, newRecordingDir(host.page().url));
    this.recorder.onCap = () => {
      this.host.toast(`recording capped at ${MAX_RECORDING_MS / 60000} minutes`, "done");
      this.stopReview();
    };
    this.actions = {
      trackDrag: (event) => this.trackDrag(event),
      trimDrag: (edge, event) => this.trimDrag(edge, event),
      seek: (tMs) => this.enterReview(tMs),
      playToggle: () => this.playToggle(),
      stop: () => this.stopReview(),
      complete: () => this.complete(),
      discard: () => this.discard(),
      canvasDrag: (event) => this.canvasDrag(event),
      canvasWheel: (event) => this.canvasWheel(event),
      canvasMove: (event) => this.canvasMove(event),
      toolbarDrag: (event) => this.toolbarDrag(event),
      setTool: (tool) => this.setTool(tool),
      beginCrop: (scope) => this.beginCrop(scope),
      toggleCropMenu: () => {
        this.cropMenu = this.cropMenu ? null : { focus: null };
        this.host.requestRender();
      },
      closeCropMenu: () => {
        this.cropMenu = null;
        this.host.requestRender();
      },
      setColor: (color) => {
        this.color = color;
        this.recolorSelected();
        this.host.requestRender();
      },
      snapshot: () => this.snapshot(),
      dismissShot: (tMs) => this.dismissShot(tMs),
      textChange: (text) => this.textChange(text),
      textSubmit: (text) => this.textSubmit(text),
    };
    this.liveTick = setInterval(() => {
      if (!this.closed && !this.recorder.stopped) this.host.requestRender();
    }, 500);
  }

  get active(): boolean {
    return !this.closed;
  }

  get reviewing(): boolean {
    return !this.closed && this.scrub != null;
  }

  pointerSample(event: PointerEvent) {
    if (this.scrub != null || this.completing || this.recorder.stopped) return;
    const click = event.kind === "down" && event.button === "left";
    this.recorder.samplePointer(event.x, event.y, this.host.canvasRect().width, click);
  }

  linkOpened(url: string) {
    if (this.scrub != null || this.completing || this.recorder.stopped) return;
    this.recorder.addLink(url);
  }

  reloaded() {
    if (this.scrub != null || this.completing || this.recorder.stopped) return;
    this.recorder.addReload();
  }

  tabClosed() {
    this.recorder.stop();
    if (this.recorder.frames.length === 0) {
      this.discard();
      return;
    }
    this.complete();
  }

  suspended() {
    this.pausePlayback();
    this.commitEditing();
    this.gesture = null;
    this.dragFrac = null;
  }

  resumed() {
    if (this.scrub == null) return;
    this.host.blurToOverlay();
    this.presentFrame();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.pausePlayback();
    this.clearLiveTick();
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    if (this.presentTimer) {
      clearTimeout(this.presentTimer);
      this.presentTimer = null;
    }
    this.recorder.stop();
    try {
      this.thumbSurface?.close();
      this.stripSurface?.close();
      this.surface.close();
    } catch {}
  }

  view(): RecordView {
    const frames = this.recorder.frames;
    const duration = Math.max(1, this.recorder.durationMs());
    if (this.scrub != null) this.ensureFilmstrip();
    const keyframes = this.keyframeTimes();
    const ringKey = keyframes.join(",");
    if (ringKey !== this.thumbRing) {
      this.thumbRing = ringKey;
      if (keyframes.length > 0) this.presentThumb(keyframes);
    }
    const markers = this.markup.annotatedKeys().map((key) => ({ atMs: key }));
    const canvas = this.canvasView();
    return {
      stopped: this.recorder.stopped,
      playing: this.playing,
      thumbFrac: this.dragFrac ?? (this.scrub == null ? 1 : this.scrubMs / duration),
      onMarkup: canvas != null && this.markup.ownObjects(this.stateKey()).length > 0,
      onShot: this.onShotNow(),
      scrubbing: this.dragFrac != null,
      markers,
      gaps: this.gapSpans(duration),
      interactions: this.interactions(),
      drops: this.recorder.drops,
      timeMs: this.scrub == null ? duration : this.scrubMs,
      durationMs: duration,
      currentKey: this.scrub == null ? null : this.stateKey(),
      pageUrl: this.host.page().url,
      shots: this.shotsView(),
      shotThumb: keyframes.length > 0 ? this.thumbSurface : null,
      keyframeCount: keyframes.length,
      filmstrip: this.stripSurface,
      trim: this.trimRange && { ...this.trimRange },
      frameAspect: (() => {
        const base = frames[0] ?? this.controller.frameSize();
        if (!base) return 0.625;
        const display = base;
        return display.height / Math.max(1, display.width);
      })(),
      canvas,
    };
  }

  private gapSpans(duration: number): { startFrac: number; endFrac: number }[] {
    const frames = this.recorder.frameTimes();
    const trail = this.recorder.pointerTrail;
    const cache = this.gapCache;
    if (!cache || cache.frames !== frames.length || cache.trail !== trail.length) {
      const gaps: { start: number; end: number }[] = [];
      let prev = 0;
      let f = 0;
      let t = 0;
      while (f < frames.length || t < trail.length) {
        const next =
          t >= trail.length || (f < frames.length && frames[f] <= trail[t].tMs)
            ? frames[f++]
            : trail[t++].tMs;
        if (next - prev >= IDLE_GAP_MS) gaps.push({ start: prev, end: next });
        prev = Math.max(prev, next);
      }
      this.gapCache = { frames: frames.length, trail: trail.length, gaps, lastMs: prev };
    }
    const { gaps, lastMs } = this.gapCache!;
    const spans = gaps.map((gap) => ({
      startFrac: gap.start / duration,
      endFrac: gap.end / duration,
    }));
    if (duration - lastMs >= IDLE_GAP_MS) {
      spans.push({ startFrac: lastMs / duration, endFrac: 1 });
    }
    return spans;
  }

  private interactions(): RecordInteraction[] {
    const recorder = this.recorder;
    const counts = [recorder.clicks, recorder.links, recorder.reloads, recorder.loads]
      .map((events) => events.length)
      .join("|");
    if (this.interactionsCache?.counts === counts) return this.interactionsCache.events;
    const events: RecordInteraction[] = [
      ...recorder.clicks.map((event) => ({ tMs: event.tMs, kind: "click" as const })),
      ...recorder.links.map((event) => ({ tMs: event.tMs, kind: "link" as const })),
      ...recorder.reloads.map((event) => ({ tMs: event.tMs, kind: "reload" as const })),
      ...recorder.loads.map((event) => ({ tMs: event.tMs, kind: "load" as const })),
    ].sort((a, b) => a.tMs - b.tMs);
    this.interactionsCache = { counts, events };
    return events;
  }

  handleKey(event: EngineKeyEvent): boolean {
    if (event.kind === "release") return false;
    if (this.scrub == null) {
      if (this.host.recordKey(event) && !this.recorder.stopped) {
        this.stopReview();
        return true;
      }
      return false;
    }
    if (this.editing) {
      if (event.key === "escape") {
        this.textSubmit(this.editing.draft);
        this.selection = [];
        this.host.requestRender();
      } else if (event.key === "enter") {
        this.textSubmit(this.editing.draft);
      }
      return true;
    }
    if (this.cropMenu) {
      this.handleCropMenuKey(event);
      return true;
    }
    const cmd = event.mods.super || event.mods.ctrl;
    const plainCtrl = event.mods.ctrl && !event.mods.super && !event.mods.alt;
    if (this.host.recordKey(event)) {
      this.discard();
      return true;
    }
    if (event.key === "enter") {
      if (cmd) this.complete();
      else this.snapshot();
      return true;
    }
    if (event.key === "tab") {
      this.stepShot(event.mods.shift ? -1 : 1);
      return true;
    }
    if (event.key === "left" || event.key === "right") {
      const direction = event.key === "left" ? -1 : 1;
      if (cmd) this.seekEdge(direction);
      else if (event.mods.alt) this.stepMark(direction);
      else if (event.mods.shift) this.stepShot(direction);
      else this.stepFrame(direction, event.kind === "repeat");
      return true;
    }
    if (plainCtrl && !event.mods.shift) {
      if (event.key === "a") {
        this.seekEdge(-1);
        return true;
      }
      if (event.key === "e") {
        this.seekEdge(1);
        return true;
      }
    }
    if (event.mods.alt && !cmd && !event.mods.shift) {
      if (event.key === "b") {
        this.stepMark(-1);
        return true;
      }
      if (event.key === "f") {
        this.stepMark(1);
        return true;
      }
    }
    if (cmd && event.key === "z") {
      const frame = this.stateKey();
      if (event.mods.shift) this.markup.redo(frame);
      else this.markup.undo(frame);
      this.selection = [];
      this.host.requestRender();
      return true;
    }
    if (cmd) {
      const direction = zoomDirection(event.key);
      if (direction === 0) {
        this.transform = null;
        this.host.requestRender();
        return true;
      }
      if (direction != null) {
        const rect = this.host.canvasRect();
        this.zoomAt({ x: rect.width / 2, y: rect.height / 2 }, direction > 0 ? 1.25 : 0.8);
        this.host.requestRender();
        return true;
      }
      return false;
    }
    if (event.mods.alt || event.mods.shift) return false;
    if (event.key === "space" || event.key === " ") {
      this.playToggle();
      return true;
    }
    if (/^[1-6]$/.test(event.key)) {
      this.selectTool(TOOLS[Number(event.key) - 1]);
      return true;
    }
    const mnemonic = TOOL_KEYS[event.key];
    if (mnemonic) {
      this.selectTool(mnemonic);
      return true;
    }
    if (/^[7-9]$/.test(event.key)) {
      this.color = MARKUP_COLORS[Number(event.key) - 7];
      this.recolorSelected();
      this.host.requestRender();
      return true;
    }
    if (event.key === "0") {
      this.color = MARKUP_COLORS[3];
      this.recolorSelected();
      this.host.requestRender();
      return true;
    }
    if (event.key === "backspace" || event.key === "delete") {
      this.deleteSelected();
      return true;
    }
    if (event.key === "escape") {
      if (this.tool !== "select") {
        this.setTool("select");
        return true;
      }
      if (this.selection.length > 0) {
        this.selection = [];
        this.host.requestRender();
      }
      return true;
    }
    return false;
  }

  // look into me
  private handleCropMenuKey(event: EngineKeyEvent) {
    const menu = this.cropMenu!;
    const step = listStep(event);
    if (step) {
      const from = menu.focus ?? (step > 0 ? -1 : 0);
      const count = CROP_SCOPES.length;
      this.cropMenu = { focus: (from + step + count) % count };
      this.host.requestRender();
      return;
    }
    if (event.key === "enter") {
      this.beginCrop(CROP_SCOPES[menu.focus ?? 0].scope);
      return;
    }
    if (event.key === "escape" || event.key === "6" || event.key === "c") {
      this.cropMenu = null;
      this.host.requestRender();
    }
  }

  private selectTool(tool: Tool) {
    if (tool === "crop") {
      this.cropMenu = { focus: 0 };
      this.host.requestRender();
      return;
    }
    this.setTool(tool);
  }

  private setTool(tool: Tool) {
    this.tool = tool;
    this.cropScope = "frame";
    this.cropMenu = null;
    if (tool !== "select") this.selection = [];
    this.host.requestRender();
  }

  private beginCrop(scope: CropScope) {
    this.setTool("crop");
    this.cropScope = scope;
    this.host.requestRender();
  }

  private recolorSelected() {
    if (this.scrub == null || this.selection.length === 0) return;
    this.markup.begin(this.stateKey());
    for (const id of this.selection) {
      const object = this.currentObject(id);
      if (object && object.kind !== "crop") {
        this.markup.update(this.stateKey(), { ...object, color: this.color });
      }
    }
  }

  private deleteSelected() {
    if (this.scrub == null || this.selection.length === 0) return;
    this.markup.begin(this.stateKey());
    for (const id of this.selection) this.markup.remove(this.stateKey(), id);
    this.selection = [];
    this.host.requestRender();
  }

  private canvasView(): RecordView["canvas"] {
    if (this.scrub == null) return null;
    const meta = this.recorder.frames[this.scrub];
    if (!meta) return null;
    const display = meta;
    const rect = this.host.canvasRect();
    const transform = this.ensureTransform(display.width, display.height, rect);
    const layout = this.host.layout();
    const rem = layout?.rem ?? 16;
    const key = this.stateKey();
    const objects = this.markup.objects(key);
    return {
      rect,
      frame: {
        x: transform.tx,
        y: transform.ty,
        width: display.width * transform.scale,
        height: display.height * transform.scale,
      },
      scale: transform.scale,
      objects,
      cursor: this.cursorAt(this.scrubMs),
      clickPulses: this.clickPulsesAt(this.scrubMs),
      linkToast: this.linkToastAt(this.scrubMs),
      selection: [...this.selection],
      marquee: this.gesture?.type === "marquee" ? this.gesture.rect : null,
      tool: this.tool,
      color: this.color,
      editing: this.editing,
      cropMenu: this.cropMenu,
      toolbar: this.toolbarPos ?? this.defaultToolbarPos(rect, rem),
      onShot: this.onShotNow(),
      flash: Math.max(0, 1 - (Date.now() - this.flashAt) / FLASH_MS),
    };
  }

  private clickPulsesAt(tMs: number): { x: number; y: number; progress: number }[] {
    const clicks = this.recorder.clicks;
    const last = lastIndexAtOrBefore(clicks, tMs, (click) => click.tMs);
    const pulses: { x: number; y: number; progress: number }[] = [];
    for (let at = last; at >= 0 && tMs < clicks[at].tMs + CLICK_PULSE_MS; at--) {
      pulses.push({
        x: clicks[at].x,
        y: clicks[at].y,
        progress: (tMs - clicks[at].tMs) / CLICK_PULSE_MS,
      });
    }
    return pulses;
  }

  private linkToastAt(tMs: number): { url: string; fade: number } | null {
    const links = this.recorder.links;
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i];
      if (link.tMs > tMs) continue;
      if (tMs >= link.tMs + LINK_HOLD_MS) return null;
      return {
        url: link.url,
        fade: Math.min(1, (link.tMs + LINK_HOLD_MS - tMs) / TOAST_FADE_MS),
      };
    }
    return null;
  }

  private cursorAt(tMs: number): Vec | null {
    const trail = this.recorder.pointerTrail;
    const at = lastIndexAtOrBefore(trail, tMs, (sample) => sample.tMs);
    if (at < 0) return null;
    const prev = trail[at];
    const next = trail[at + 1];
    if (next && next.tMs > prev.tMs && next.tMs - prev.tMs <= CURSOR_LERP_MAX_MS) {
      const f = (tMs - prev.tMs) / (next.tMs - prev.tMs);
      return { x: prev.x + (next.x - prev.x) * f, y: prev.y + (next.y - prev.y) * f };
    }
    return { x: prev.x, y: prev.y };
  }

  private ensureTransform(width: number, height: number, rect: Rect): Transform {
    const frameKey = `${width}x${height}|${rect.width}x${rect.height}`;
    if (this.transform?.frameKey === frameKey) return this.transform;
    const inset = 10;
    const fit = Math.min(
      Math.max(1, rect.width - inset * 2) / width,
      Math.max(1, rect.height - inset * 2) / height,
    );
    this.transform = {
      scale: fit,
      tx: (rect.width - width * fit) / 2,
      ty: (rect.height - height * fit) / 2,
      fit,
      frameKey,
    };
    return this.transform;
  }

  private trackDrag(event: DragEvent) {
    if (this.completing) return;
    const layout = this.host.layout();
    if (!layout) return;
    const metrics = recordBarMetrics(layout, recordBarCluster(this.recorder.durationMs()));
    this.stopCapture();
    if (this.recorder.frames.length === 0) return;
    const frac = Math.max(0, Math.min(1, (event.x - metrics.track.x) / metrics.track.width));
    this.dragFrac = event.phase === "end" ? null : frac;
    const atMs = frac * this.recorder.durationMs();
    this.enterReview(atMs);
    this.host.requestRender();
  }

  private trimStartMs(): number {
    return this.trimRange?.startMs ?? 0;
  }

  private trimEndMs(): number {
    return this.trimRange?.endMs ?? Math.round(this.recorder.durationMs());
  }

  private trimDrag(edge: "start" | "end", event: DragEvent) {
    if (this.completing || this.scrub == null) return;
    const layout = this.host.layout();
    if (!layout) return;
    const metrics = recordBarMetrics(layout, recordBarCluster(this.recorder.durationMs()));
    const duration = Math.round(this.recorder.durationMs());
    const frac = Math.max(0, Math.min(1, (event.x - metrics.track.x) / metrics.track.width));
    const tMs = Math.round(frac * duration);
    const minSpan = Math.min(duration, 100);
    const next =
      edge === "start"
        ? { startMs: Math.max(0, Math.min(tMs, this.trimEndMs() - minSpan)), endMs: this.trimEndMs() }
        : { startMs: this.trimStartMs(), endMs: Math.min(duration, Math.max(tMs, this.trimStartMs() + minSpan)) };
    this.trimRange = next.startMs <= 0 && next.endMs >= duration ? null : next;
    this.pausePlayback();
    const at = edge === "start" ? next.startMs : next.endMs;
    this.dragFrac = event.phase === "end" ? null : at / Math.max(1, duration);
    this.enterReview(at);
    this.host.requestRender();
  }

  private ensureFilmstrip() {
    const layout = this.host.layout();
    if (!layout || this.stripBusy || this.recorder.frames.length === 0) return;
    const metrics = recordBarMetrics(layout, recordBarCluster(this.recorder.durationMs()));
    const pxW = Math.max(16, Math.round(metrics.track.width * 2));
    const pxH = Math.max(16, Math.round(metrics.strip.height * 2));
    const key = `${pxW}x${pxH}`;
    if (key === this.stripKey) return;
    this.stripBusy = true;
    void this.buildFilmstrip(pxW, pxH)
      .then(() => {
        this.stripKey = key;
      })
      .catch(() => {})
      .finally(() => {
        this.stripBusy = false;
      });
  }

  private async buildFilmstrip(pxW: number, pxH: number) {
    const duration = this.recorder.durationMs();
    const base = this.recorder.frames[0];
    const tileW = Math.max(8, Math.round(pxH * (base.width / Math.max(1, base.height))));
    const count = Math.max(1, Math.ceil(pxW / tileW));
    const indices: number[] = [];
    for (let i = 0; i < count; i++) {
      indices.push(this.recorder.frameAt(duration * ((i + 0.5) / count)) ?? 0);
    }
    const strip = await this.recorder.filmstrip(indices, tileW, pxW, pxH);
    if (this.closed) return;
    this.stripSurface ??= this.host.root.createSurface();
    this.stripSurface.present({ bgra: strip, width: pxW, height: pxH });
    this.host.requestRender();
  }

  // what an ass backwards name
  private stopReview() {
    if (this.completing || this.scrub != null) return;
    if (!this.ensureFrames()) return;
    this.enterReview(0);
    this.playToggle();
  }

  private ensureFrames(): boolean {
    this.stopCapture();
    if (this.recorder.frames.length > 0) return true;
    this.host.toast("nothing captured", "failed");
    this.discard();
    return false;
  }

  private snapshot() {
    if (this.scrub == null || this.completing) return;
    const frame = this.scrub;
    const tMs = this.stateKey();
    if (this.onShotNow()) return;
    this.startFlash();
    const page = this.host.page();
    this.shots.push({ frame, tMs, url: page.url, title: page.title });
    this.host.requestRender();
  }

  private presentThumb(times: number[]) {
    const latest = times[times.length - 1];
    if (latest == null) return;
    const index =
      this.shots.find((shot) => shot.tMs === latest)?.frame ?? this.recorder.frameAt(latest);
    if (index == null) return;
    this.thumbSurface ??= this.host.root.createSurface();
    try {
      const decoded = this.recorder.bitmap(index);
      this.thumbSurface.present({
        bgra: decoded.bgra,
        width: decoded.width,
        height: decoded.height,
      });
    } catch {}
  }

  private startFlash() {
    this.flashAt = Date.now();
    if (this.flashTimer) clearInterval(this.flashTimer);
    this.flashTimer = setInterval(() => {
      if (Date.now() - this.flashAt >= FLASH_MS && this.flashTimer) {
        clearInterval(this.flashTimer);
        this.flashTimer = null;
      }
      this.host.requestRender();
    }, 33);
  }

  private stepFrame(direction: number, repeat: boolean) {
    if (this.scrub == null || this.recorder.frames.length === 0) return;
    this.pausePlayback();
    const times = this.samples();
    if (!repeat) {
      this.hold = null;
      const at = this.sampleIndexAt(this.scrubMs);
      const bounded = Math.max(0, Math.min(times.length - 1, at + direction));
      this.enterReview(times[bounded]);
      return;
    }
    if (this.hold?.direction !== direction) {
      this.hold = { fromMs: this.scrubMs, at: Date.now(), direction };
      return;
    }
    const target = this.hold.fromMs + direction * (Date.now() - this.hold.at);
    const bounded = Math.max(0, Math.min(times.length - 1, this.sampleIndexAt(target)));
    this.enterReview(times[bounded]);
  }

  private seekEdge(direction: number) {
    if (this.scrub == null) return;
    this.pausePlayback();
    this.enterReview(direction < 0 ? 0 : this.recorder.durationMs());
  }

  private markTimes(): number[] {
    const times = [
      ...this.markup.annotatedKeys(),
      ...this.shots.map((shot) => shot.tMs),
      ...this.interactions().map((event) => event.tMs),
    ];
    return [...new Set(times.map((tMs) => Math.round(tMs)))].sort((a, b) => a - b);
  }

  private stepMark(direction: number) {
    this.seekAmong(this.markTimes(), direction);
  }

  private keyframeTimes(): number[] {
    const stops = new Set<number>([...this.markup.annotatedKeys(), ...this.shots.map((s) => s.tMs)]);
    return [...stops].sort((a, b) => a - b);
  }

  private stepShot(direction: number) {
    this.seekAmong(this.keyframeTimes(), direction);
  }

  private seekAmong(times: number[], direction: number) {
    if (this.scrub == null || times.length === 0) return;
    this.pausePlayback();
    const target =
      direction > 0
        ? (times.find((tMs) => tMs > this.scrubMs + 1) ?? times[0])
        : ([...times].reverse().find((tMs) => tMs < this.scrubMs - 1) ?? times[times.length - 1]);
    this.enterReview(target);
  }

  private dismissShot(tMs: number) {
    const at = this.shots.findIndex((shot) => shot.tMs === tMs);
    if (at < 0) return;
    this.shots.splice(at, 1);
    this.host.requestRender();
  }

  private playToggle() {
    if (this.completing) return;
    if (this.playing) {
      this.pausePlayback();
      this.host.requestRender();
      return;
    }
    if (this.scrub == null || this.recorder.frames.length === 0) return;
    if (this.scrubMs >= this.trimEndMs() - 30 || this.scrubMs < this.trimStartMs()) {
      this.seekMs(this.trimStartMs());
    }
    this.playing = true;
    this.lastPlayAt = Date.now();
    this.playTimer = setInterval(() => this.playStep(), 16);
    this.host.requestRender();
  }

  private playStep() {
    if (this.closed) {
      this.pausePlayback();
      return;
    }
    const now = Date.now();
    const next = this.scrubMs + (now - this.lastPlayAt);
    this.lastPlayAt = now;
    const end = this.trimEndMs();
    if (next >= end) {
      this.seekMs(end);
      this.pausePlayback();
    } else {
      this.seekMs(next);
    }
    this.host.requestRender();
  }

  private seekMs(tMs: number) {
    this.scrubMs = tMs;
    const index = this.recorder.frameAt(tMs);
    if (index != null && index !== this.scrub) {
      this.scrub = index;
      this.presentFrame();
    }
  }

  private pausePlayback() {
    this.playing = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  private enterReview(tMs: number) {
    if (this.completing) return;// what is this case
    this.pausePlayback();
    this.stopCapture(); 
    const index = this.recorder.frameAt(tMs); 
    if (index == null) return;
    const wasLive = this.scrub == null;
    if (!wasLive && this.scrub !== index) this.commitEditing();
    this.scrubMs = tMs;
    if (this.scrub === index && !wasLive) {
      this.host.requestRender();
      return;
    }
    this.scrub = index;
    if (wasLive) {
      this.host.blurToOverlay();
      this.host.reviewStarted();
    }
    this.presentFrame();
    this.host.requestRender();
  }

  private stopCapture() {
    this.clearLiveTick();
    const wasStopped = this.recorder.stopped;
    this.recorder.stop();
    if (!wasStopped && this.recorder.captureError) {
      this.host.toast(`capture failed: ${this.recorder.captureError}`, "failed");
    }
  }

  private clearLiveTick() {
    if (this.liveTick) {
      clearInterval(this.liveTick);
      this.liveTick = null;
    }
  }

  private presentFrame() {
    if (this.presentTimer) return;
    // we probably just want to sync to display refresh rate
    const wait = 8 - (Date.now() - this.presentAt);
    if (wait <= 0) {
      this.presentNow();
      return;
    }
    this.presentTimer = setTimeout(() => {
      this.presentTimer = null;
      this.presentNow();
    }, wait);
  }

  private presentNow() {
    const index = this.scrub;
    if (index == null || this.closed) return;
    this.presentAt = Date.now();
    try {
      const frame = this.recorder.bitmap(index);
      this.surface.present({ bgra: frame.bgra, width: frame.width, height: frame.height });
    } catch {}
  }

  private complete() {
    if (this.completing) return;
    this.pausePlayback();
    if (!this.ensureFrames()) return;
    this.completing = true;
    this.commitEditing();
    const host = this.host;
    const page = host.page();
    const dir = this.recorder.dir;
    const manifestPath = writeProcessingManifest(dir, page);
    host.setClipboard(manifestPath);
    host.toast("copied to clipboard", "done", manifestPath.replace(os.homedir(), "~"));
    compositeRecording({
      recorder: this.recorder,
      markup: this.markup,
      page,
      fontFile: host.fontFile(),
      shots: this.shots,
      trim: this.trimRange,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        writeFailedManifest(dir, page, message);
      } catch {}
      host.toast(`recording failed: ${message}`, "failed");
    });
    this.finish();
  }

  private discard() {
    this.recorder.stop();
    void this.recorder.deleteAll();
    this.finish();
  }

  private finish() {
    const wasReviewing = this.scrub != null;
    this.dispose();
    this.host.setKeyCapture([]);
    if (wasReviewing) this.host.refocusPage();
    this.host.finished();
  }

  private toLocal(p: Vec): Vec {
    const rect = this.host.canvasRect();
    return { x: p.x - rect.x, y: p.y - rect.y };
  }

  private toFrame(local: Vec): Vec {
    const transform = this.transform;
    if (!transform) return local;
    return { x: (local.x - transform.tx) / transform.scale, y: (local.y - transform.ty) / transform.scale };
  }

  private currentObject(id: number): MarkupObject | null {
    if (this.scrub == null) return null;
    return this.markup.objects(this.stateKey()).find((object) => object.id === id) ?? null;
  }

  private canvasMove(event: MouseMoveEvent) {
    this.pointerLocal = this.toLocal({ x: event.x, y: event.y });
  }

  private samples(): number[] {
    if (!this.sampleTimes) {
      this.sampleTimes = buildSampleTimes({
        frameTimes: this.recorder.frames.map((frame) => Math.round(frame.tMs)),
        pointer: this.recorder.pointerTrail,
        clicks: this.recorder.clicks,
        links: this.recorder.links,
        durationMs: Math.round(this.recorder.durationMs()),
      });
    }
    return this.sampleTimes;
  }

  private sampleIndexAt(tMs: number): number {
    return Math.max(0, lastIndexAtOrBefore(this.samples(), Math.round(tMs), (t) => t));
  }

  private stateKey(): number {
    return this.samples()[this.sampleIndexAt(this.scrubMs)];
  }

  private shotsView(): RecordShot[] {
    return this.shots.map((shot) => ({ tMs: shot.tMs }));
  }

  private onShotNow(): boolean {
    return this.scrub != null && this.shots.some((shot) => shot.tMs === this.stateKey());
  }

  private defaultToolbarPos(rect: Rect, rem: number): Vec {
    const size = toolbarSize(rem, !this.onShotNow());
    return {
      x: Math.max(4, (rect.width - size.width) / 2),
      y: Math.max(4, rect.height - size.height - rem * 0.6),
    };
  }

  private canvasDrag(event: DragEvent) {
    if (this.scrub == null || this.completing || !this.transform) return;
    const frame = this.stateKey();
    const local = this.toLocal({ x: event.x, y: event.y });
    const fp = this.toFrame(local);
    // where is the conditional on the tool being used?
    if (event.phase === "start") this.dragStart(frame, local, fp);
    else if (event.phase === "move") this.dragMove(frame, local, fp, event);
    else this.dragEnd(frame, local, fp);
    this.host.requestRender();
  }

  private dragStart(frame: number, local: Vec, fp: Vec) {
    const wasPlaying = this.playing;
    this.pausePlayback();
    this.commitEditing();
    this.scrubMs = frame;
    const scale = this.transform!.scale;
    const meta = this.recorder.frames[this.scrub!];
    switch (this.tool) {
      case "select": {
        const handle = this.handleAt(local);
        if (handle && this.selection.length === 1) {
          const object = this.currentObject(this.selection[0]);
          if (object) {
            this.markup.begin(frame);
            this.gesture = { type: "resize", id: this.selection[0], handle, start: structuredClone(object) };
            return;
          }
        }
        const hit = hitTest(this.markup.objects(frame), fp, 6 / scale);
        if (hit != null) {
          this.markup.begin(frame);
          if (!this.selection.includes(hit)) this.selection = [hit];
          this.gesture = { type: "move", ids: [...this.selection], primary: hit, last: fp, moved: 0 };
        } else if (this.insideSelectionBounds(fp)) {
          this.markup.begin(frame);
          this.gesture = {
            type: "move",
            ids: [...this.selection],
            primary: this.selection[0],
            last: fp,
            moved: 0,
            viaBounds: true,
          };
        } else {
          this.gesture = {
            type: "marquee",
            anchor: fp,
            rect: { x: fp.x, y: fp.y, width: 0, height: 0 },
            hadSelection: this.selection.length > 0,
            wasPlaying,
          };
          this.selection = [];
        }
        return;
      }
      case "pen": {
        this.markup.begin(frame);
        const width = Math.max(2, Math.min(10, Math.round(meta.height * 0.004)));
        const object: MarkupObject = {
          kind: "pen",
          id: this.markup.allocId(),
          color: this.color,
          width,
          points: [fp],
        };
        this.markup.replace(frame, [...this.markup.objects(frame), object]);
        this.gesture = { type: "pen", id: object.id, last: fp };
        return;
      }
      case "arrow": {
        this.markup.begin(frame);
        const width = Math.max(2, Math.min(10, Math.round(meta.height * 0.005)));
        const object: MarkupObject = {
          kind: "arrow",
          id: this.markup.allocId(),
          color: this.color,
          width,
          from: fp,
          to: fp,
        };
        this.markup.replace(frame, [...this.markup.objects(frame), object]);
        this.gesture = { type: "arrow", id: object.id, from: fp };
        return;
      }
      case "oval": {
        this.markup.begin(frame);
        const width = Math.max(2, Math.min(10, Math.round(meta.height * 0.005)));
        const object: MarkupObject = {
          kind: "oval",
          id: this.markup.allocId(),
          color: this.color,
          width,
          rect: { x: fp.x, y: fp.y, width: 0, height: 0 },
        };
        this.markup.replace(frame, [...this.markup.objects(frame), object]);
        this.gesture = { type: "oval", id: object.id, anchor: fp };
        return;
      }
      case "text": {
        this.gesture = { type: "text", start: local, moved: 0 };
        return;
      }
      case "crop": {
        this.markup.begin(frame);
        if (this.cropScope === "video") this.markup.removeVideoCrops();
        const withoutCrop = this.markup
          .objects(frame)
          .filter((object) => !(object.kind === "crop" && object.scope === this.cropScope));
        const object: MarkupObject = {
          kind: "crop",
          id: this.markup.allocId(),
          rect: { x: fp.x, y: fp.y, width: 0, height: 0 },
          scope: this.cropScope,
        };
        this.markup.replace(frame, [...withoutCrop, object]);
        this.gesture = { type: "crop", id: object.id, anchor: fp };
        return;
      }
    }
  }

  private dragMove(frame: number, local: Vec, fp: Vec, event: DragEvent) {
    const gesture = this.gesture;
    if (!gesture) return;
    const scale = this.transform!.scale;
    switch (gesture.type) {
      case "marquee": {
        gesture.rect = rectFromPoints(gesture.anchor, fp);
        return;
      }
      case "move": {
        const dx = fp.x - gesture.last.x;
        const dy = fp.y - gesture.last.y;
        gesture.moved += Math.hypot(dx, dy) * scale;
        for (const id of gesture.ids) {
          const object = this.currentObject(id);
          if (object) this.markup.update(frame, moveObject(object, dx, dy));
        }
        gesture.last = fp;
        return;
      }
      case "resize": {
        this.markup.update(frame, resizeObject(gesture.start, gesture.handle, fp));
        return;
      }
      case "pen": {
        const object = this.currentObject(gesture.id);
        if (!object || object.kind !== "pen") return;
        if (Math.hypot(fp.x - gesture.last.x, fp.y - gesture.last.y) < 1.5 / scale) return;
        gesture.last = fp;
        this.markup.update(frame, { ...object, points: [...object.points, fp] });
        return;
      }
      case "arrow": {
        const object = this.currentObject(gesture.id);
        if (!object || object.kind !== "arrow") return;
        let to = fp;
        if (event.mods.shift) {
          const angle = Math.atan2(fp.y - gesture.from.y, fp.x - gesture.from.x);
          const snapped = (Math.round(angle / (Math.PI / 4)) * Math.PI) / 4;
          const length = Math.hypot(fp.x - gesture.from.x, fp.y - gesture.from.y);
          to = {
            x: gesture.from.x + length * Math.cos(snapped),
            y: gesture.from.y + length * Math.sin(snapped),
          };
        }
        this.markup.update(frame, { ...object, to });
        return;
      }
      case "oval": {
        const object = this.currentObject(gesture.id);
        if (!object || object.kind !== "oval") return;
        let rect = rectFromPoints(gesture.anchor, fp);
        if (event.mods.shift) {
          const side = Math.max(rect.width, rect.height);
          rect = {
            x: fp.x < gesture.anchor.x ? gesture.anchor.x - side : gesture.anchor.x,
            y: fp.y < gesture.anchor.y ? gesture.anchor.y - side : gesture.anchor.y,
            width: side,
            height: side,
          };
        }
        this.markup.update(frame, { ...object, rect });
        return;
      }
      // will need to think about how much i love the croppoing implementation
      case "crop": {
        const object = this.currentObject(gesture.id);
        if (!object || object.kind !== "crop") return;
        this.markup.update(frame, { ...object, rect: rectFromPoints(gesture.anchor, fp) });
        return;
      }
      case "text": {
        gesture.moved += Math.hypot(local.x - gesture.start.x, local.y - gesture.start.y);
        return;
      }
    }
  }

  private dragEnd(frame: number, local: Vec, fp: Vec) {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    const scale = this.transform!.scale;
    switch (gesture.type) {
      case "marquee": {
        if (gesture.rect.width * scale < 3 && gesture.rect.height * scale < 3) {
          if (!gesture.hadSelection && !gesture.wasPlaying) this.playToggle();
          return;
        }
        this.selection = this.markup
          .objects(frame)
          .filter((object) => rectsIntersect(bboxOf(object), gesture.rect))
          .map((object) => object.id);
        return;
      }
      case "move": {
        if (gesture.moved < 3) {
          if (gesture.viaBounds) {
            this.selection = [];
          } else {
            this.selection = [gesture.primary];
            this.registerClick(local, gesture.primary);
          }
        }
        return;
      }
      case "pen": {
        const object = this.currentObject(gesture.id);
        if (object?.kind === "pen" && object.points.length < 2) {
          this.markup.remove(frame, gesture.id);
        }
        return;
      }
      case "arrow": {
        const object = this.currentObject(gesture.id);
        if (
          object?.kind === "arrow" &&
          Math.hypot(object.to.x - object.from.x, object.to.y - object.from.y) < 8 / scale
        ) {
          this.markup.remove(frame, gesture.id);
        }
        return;
      }
      case "oval": {
        const object = this.currentObject(gesture.id);
        if (object?.kind === "oval" && (object.rect.width < 8 / scale) && (object.rect.height < 8 / scale)) {
          this.markup.remove(frame, gesture.id);
        } else {
          this.selection = [gesture.id];
          this.tool = "select";
        }
        return;
      }
      case "crop": {
        const object = this.currentObject(gesture.id);
        if (object?.kind === "crop" && (object.rect.width < 12 || object.rect.height < 12)) {
          this.markup.remove(frame, gesture.id);
        } else {
          this.selection = [gesture.id];
          this.tool = "select";
        }
        return;
      }
      case "text": {
        if (gesture.moved < 5) this.createText(frame, this.toFrame(gesture.start));
        return;
      }
      default:
        return;
    }
  }

  private registerClick(local: Vec, id: number) {
    const now = Date.now();
    const isDouble =
      now - this.lastClick.at < 450 &&
      Math.hypot(local.x - this.lastClick.x, local.y - this.lastClick.y) < 8;
    this.lastClick = { at: now, x: local.x, y: local.y };
    if (!isDouble) return;
    const object = this.currentObject(id);
    if (object?.kind === "text") this.startEditing(object);
  }

  private createText(frame: number, fp: Vec) {
    const meta = this.recorder.frames[this.scrub!];
    this.markup.begin(frame);
    const fontPx = Math.max(14, Math.min(64, Math.round(meta.height * 0.028)));
    const object: MarkupObject = {
      kind: "text",
      id: this.markup.allocId(),
      color: this.color,
      text: "",
      pos: fp,
      fontPx,
    };
    this.markup.replace(frame, [...this.markup.objects(frame), object]);
    this.selection = [object.id];
    this.editing = { id: object.id, draft: "" };
    this.host.setKeyCapture(["enter"]);
  }

  private startEditing(object: Extract<MarkupObject, { kind: "text" }>) {
    if (this.scrub == null) return;
    this.markup.begin(this.stateKey());
    this.selection = [object.id];
    this.editing = { id: object.id, draft: object.text };
    this.host.setKeyCapture(["enter"]);
    this.host.requestRender();
  }

  private textChange(text: string) {
    if (this.scrub == null || !this.editing) return;
    this.editing.draft = text;
    const object = this.currentObject(this.editing.id);
    if (object?.kind === "text") this.markup.update(this.stateKey(), { ...object, text });
    this.host.requestRender();
  }

  private textSubmit(text: string) {
    if (!this.editing) return;
    this.editing.draft = text;
    this.commitEditing();
    this.host.requestRender();
  }

  private commitEditing() {
    if (this.scrub == null || !this.editing) return;
    const { id, draft } = this.editing;
    this.editing = null;
    this.host.setKeyCapture([]);
    this.tool = "select";
    const object = this.currentObject(id);
    if (object?.kind !== "text") return;
    const text = draft.trimEnd();
    if (!text) {
      this.markup.remove(this.stateKey(), id);
      this.selection = this.selection.filter((selected) => selected !== id);
    } else {
      this.markup.update(this.stateKey(), { ...object, text });
    }
  }

  private insideSelectionBounds(fp: Vec): boolean {
    if (this.selection.length === 0 || this.scrub == null) return false;
    const objects = this.selection
      .map((id) => this.currentObject(id))
      .filter((object): object is MarkupObject => object != null);
    if (objects.length === 0) return false;
    return pointInRect(fp, unionRects(objects.map(bboxOf)));
  }

  private handleAt(local: Vec): HandleId | null {
    if (this.scrub == null || this.selection.length !== 1 || !this.transform) return null;
    const object = this.currentObject(this.selection[0]);
    if (!object) return null;
    const { scale, tx, ty } = this.transform;
    for (const handle of handlesFor(object)) {
      const view = { x: tx + handle.pos.x * scale, y: ty + handle.pos.y * scale };
      if (Math.hypot(local.x - view.x, local.y - view.y) <= 8) return handle.id;
    }
    return null;
  }

  private canvasWheel(event: WheelEvent) {
    if (this.scrub == null || this.completing || !this.transform) return;
    if (event.mods.ctrl && event.precise) {
      const factor = 1 - event.deltaY / 100;
      if (factor <= 0) return;
      const rect = this.host.canvasRect();
      this.zoomAt(this.pointerLocal ?? { x: rect.width / 2, y: rect.height / 2 }, factor);
    } else {
      this.transform.tx -= event.deltaX;
      this.transform.ty -= event.deltaY;
      this.clampPan();
    }
    this.host.requestRender();
  }

  private zoomAt(anchor: Vec, factor: number) {
    const transform = this.transform;
    if (!transform) return;
    const next = Math.max(transform.fit, Math.min(transform.fit * 12, transform.scale * factor));
    const applied = next / transform.scale;
    transform.tx = anchor.x - (anchor.x - transform.tx) * applied;
    transform.ty = anchor.y - (anchor.y - transform.ty) * applied;
    transform.scale = next;
    this.clampPan();
  }

  private clampPan() {
    const transform = this.transform;
    if (!transform || this.scrub == null) return;
    const meta = this.recorder.frames[this.scrub];
    const rect = this.host.canvasRect();
    const display = meta;
    const width = display.width * transform.scale;
    const height = display.height * transform.scale;
    transform.tx =
      width <= rect.width
        ? (rect.width - width) / 2
        : Math.min(0, Math.max(rect.width - width, transform.tx));
    transform.ty =
      height <= rect.height
        ? (rect.height - height) / 2
        : Math.min(0, Math.max(rect.height - height, transform.ty));
  }
  private toolbarDrag(event: DragEvent) {
    const layout = this.host.layout();
    if (!layout) return;
    const rect = this.host.canvasRect();
    const size = toolbarSize(layout.rem, !this.onShotNow());
    const local = this.toLocal({ x: event.x, y: event.y });
    if (event.phase === "start") {
      const current = this.toolbarPos ?? this.defaultToolbarPos(rect, layout.rem);
      this.toolbarGrab = { x: local.x - current.x, y: local.y - current.y };
      return;
    }
    if (!this.toolbarGrab) return;
    this.toolbarPos = {
      x: Math.max(2, Math.min(rect.width - size.width - 2, local.x - this.toolbarGrab.x)),
      y: Math.max(2, Math.min(rect.height - size.height - 2, local.y - this.toolbarGrab.y)),
    };
    if (event.phase === "end") this.toolbarGrab = null;
    this.host.requestRender();
  }

}

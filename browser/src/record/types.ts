import type { DragEvent, MouseMoveEvent, Surface, WheelEvent } from "@zenbu-labs/pixel";
import type { CropScope, MarkupObject, Rect, Tool, Vec } from "./model";

export type InteractionKind = "click" | "link" | "reload" | "load";

export interface RecordInteraction {
  tMs: number;
  kind: InteractionKind;
}

export interface RecordShot {
  tMs: number;
}

export interface RecordMarker {
  atMs: number;
}

export interface RecordDrop {
  tMs: number;
  count: number;
}

export interface RecordGap {
  startFrac: number;
  endFrac: number;
}

export interface MarkupCanvasView {
  rect: Rect;
  frame: Rect;
  scale: number;
  objects: MarkupObject[];
  cursor: Vec | null;
  clickPulses: { x: number; y: number; progress: number }[];
  linkToast: { url: string; fade: number } | null;
  selection: number[];
  marquee: Rect | null;
  tool: Tool;
  color: string;
  editing: { id: number; draft: string } | null;
  cropMenu: { focus: number | null } | null;
  toolbar: Vec;
  onShot: boolean;
  flash: number;
}

export interface RecordView {
  stopped: boolean;
  playing: boolean;
  thumbFrac: number;
  onMarkup: boolean;
  onShot: boolean;
  scrubbing: boolean;
  markers: RecordMarker[];
  gaps: RecordGap[];
  interactions: RecordInteraction[];
  drops: readonly RecordDrop[];
  timeMs: number;
  durationMs: number;
  currentKey: number | null;
  pageUrl: string;
  recordKey: string;
  agent: boolean;
  shots: RecordShot[];
  shotThumb: Surface | null;
  keyframeCount: number;
  filmstrip: Surface | null;
  trim: { startMs: number; endMs: number } | null;
  frameAspect: number;
  canvas: MarkupCanvasView | null;
}

export interface RecordActions {
  trackDrag(event: DragEvent): void;
  trimDrag(edge: "start" | "end", event: DragEvent): void;
  seek(tMs: number): void;
  playToggle(): void;
  stop(): void;
  complete(): void;
  discard(): void;
  canvasDrag(event: DragEvent): void;
  canvasWheel(event: WheelEvent): void;
  canvasMove(event: MouseMoveEvent): void;
  toolbarDrag(event: DragEvent): void;
  setTool(tool: Tool): void;
  setColor(color: string): void;
  beginCrop(scope: CropScope): void;
  toggleCropMenu(): void;
  closeCropMenu(): void;
  snapshot(): void;
  dismissShot(tMs: number): void;
  textChange(text: string): void;
  textSubmit(text: string): void;
}

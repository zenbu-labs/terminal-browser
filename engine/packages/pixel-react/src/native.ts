export interface DamageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One plane of a dmabuf-backed shared texture, as Electron reports it on Linux. */
export interface SurfacePixmap {
  fd: number;
  width: number;
  height: number;
  stride: number;
  offset: number;
  size: number;
}

export interface NativeEngine {
  info(): string;
  applyOps(ops: string): void;
  updateSurface(
    id: number,
    bgra: Buffer,
    width: number,
    height: number,
    damage?: DamageRect,
  ): void;
  updateSurfaceTexture?(id: number, handle: Buffer, damage?: DamageRect): void;
  updateSurfacePixmap?(id: number, pixmap: SurfacePixmap, damage?: DamageRect): void;
  removeSurface(id: number): void;
  surfaceStats(): string;
  setKeyEventTypes(enabled: boolean): void;
  start(callback: (err: unknown, event: string) => void): void;
  stop(): void;
}

export type Rgba = [number, number, number, number];

export type TerminalColors = {
  foreground: Rgba | null;
  background: Rgba | null;
  palette: (Rgba | null)[];
};

/**
 * fixme: this is a very weird name to export
 */
export interface EngineInfo {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  basePx: number;
  colors: TerminalColors;
}

export interface HighlightSpan {
  start: number;
  end: number;
  capture: number;
}

export interface MarkdownSpan {
  start: number;
  end: number;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link?: string;
  incompleteLink: boolean;
}

export interface MarkdownCell {
  text: string;
  spans: MarkdownSpan[];
}

export interface MarkdownRow {
  cells: MarkdownCell[];
}

export interface MarkdownBlock {
  kind: "paragraph" | "heading" | "code" | "rule" | "image" | "table";
  text: string;
  spans: MarkdownSpan[];
  level: number;
  language: string;
  closed: boolean;
  quote: number;
  listDepth?: number;
  ordinal?: number;
  task?: boolean;
  itemStart: boolean;
  src: string;
  rows: MarkdownRow[];
  aligns: ("left" | "center" | "right" | "none")[];
  /** byte range of this block in the parsed source */
  sourceStart: number;
  sourceEnd: number;
}

export interface DiffEmphasis {
  start: number;
  end: number;
}

export interface DiffRow {
  kind: "context" | "del" | "add" | "gap";
  oldLine?: number;
  newLine?: number;
  text: string;
  sideStart: number;
  emphasis: DiffEmphasis[];
  count?: number;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const binding = require("../native/pixel.node") as {
  PixelEngine: new (tty?: string, tmux?: boolean) => NativeEngine;
  highlight(source: string, language: string): HighlightSpan[];
  highlightCaptures(): string[];
  diff(oldSource: string, newSource: string, contextLines?: number): DiffRow[];
  parseMarkdown(source: string, streaming?: boolean): MarkdownBlock[];
};

export function createNativeEngine(tty?: string, tmux?: boolean): NativeEngine {
  const pixelEngine =  new binding.PixelEngine(tty, tmux);

  return pixelEngine
}

export function highlight(source: string, language: string): HighlightSpan[] {
  return binding.highlight(source, language);
}

export const HIGHLIGHT_CAPTURES: readonly string[] = binding.highlightCaptures();

export function diff(oldSource: string, newSource: string, contextLines?: number): DiffRow[] {
  return binding.diff(oldSource, newSource, contextLines);
}

export function parseMarkdown(source: string, streaming?: boolean): MarkdownBlock[] {
  return binding.parseMarkdown(source, streaming);
}

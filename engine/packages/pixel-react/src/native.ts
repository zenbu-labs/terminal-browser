export interface DamageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceShm {
  fd: number;
  width: number;
  height: number;
  stride: number;
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
  updateSurfaceShm?(
    id: number,
    shm: SurfaceShm,
    damage?: DamageRect,
    released?: (...args: unknown[]) => void,
  ): void;
  removeSurface(id: number): void;
  surfaceStats(): string;
  startSurfaceCapture(surfaceId: number, dir: string): number;
  stopSurfaceCapture(captureId: number): string;
  captureIndex(captureId: number): string;
  captureFrame(captureId: number, index: number): Buffer;
  releaseCapture(captureId: number): void;
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
  kittyKeyboard: boolean;
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
  PixelEngine: new (
    tty?: string,
    wrapper?: string,
    sessionEnv?: Record<string, string>,
  ) => NativeEngine;
  highlight(source: string, language: string): HighlightSpan[];
  highlightCaptures(): string[];
  diff(oldSource: string, newSource: string, contextLines?: number): DiffRow[];
  parseMarkdown(source: string, streaming?: boolean): MarkdownBlock[];
  encodeRecording(
    jobJson: string,
    onProgress?: (err: unknown, percent: number) => void,
  ): Promise<void>;
  captureFilmstrip(
    dir: string,
    frames: number[],
    tileWidth: number,
    width: number,
    height: number,
  ): Promise<Buffer>;
  // Absent off macOS: `mod keychain` is gated out of the native library there.
  chromiumSafeStorageSecret?(browser: string): string;
};

export function createNativeEngine(
  tty?: string,
  wrapper?: string,
  sessionEnv?: NodeJS.ProcessEnv,
): NativeEngine {
  const env = sessionEnv
    ? Object.fromEntries(
        Object.entries(sessionEnv).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  const pixelEngine = new binding.PixelEngine(tty, wrapper, env);

  return pixelEngine
}

export function highlight(source: string, language: string): HighlightSpan[] {
  return binding.highlight(source, language);
}

export const HIGHLIGHT_CAPTURES: readonly string[] = binding.highlightCaptures();

export function diff(oldSource: string, newSource: string, contextLines?: number): DiffRow[] {
  return binding.diff(oldSource, newSource, contextLines);
}

export function encodeRecording(
  jobJson: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return binding.encodeRecording(
    jobJson,
    onProgress &&
      ((err, percent) => {
        if (err == null) onProgress(percent);
      }),
  );
}

export function captureFilmstrip(
  dir: string,
  frames: number[],
  tileWidth: number,
  width: number,
  height: number,
): Promise<Buffer> {
  return binding.captureFilmstrip(dir, frames, tileWidth, width, height);
}

export function parseMarkdown(source: string, streaming?: boolean): MarkdownBlock[] {
  return binding.parseMarkdown(source, streaming);
}

/**
 * Reads a known Chromium-family browser's Safe Storage secret, named by the browser slug the
 * cookie import detects. Deliberately not re-exported from the package index: this is not a
 * general keychain read, and nothing outside the cookie import should reach it.
 */
export function chromiumSafeStorageSecret(browser: string): string {
  const read = binding.chromiumSafeStorageSecret;
  if (!read) throw new Error("reading a browser's Safe Storage key is only supported on macOS");
  return read(browser);
}

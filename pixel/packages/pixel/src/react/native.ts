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
  updateSurfaceTexture?(
    id: number,
    handle: number,
    damageX: number,
    damageY: number,
    damageWidth: number,
    damageHeight: number,
  ): void;
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
  setFocusClick(enabled: boolean): void;
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
  hosted: boolean;
  colors: TerminalColors;
}

export interface HostOptions {
  socket: string;
  pane: string;
  name: string;
  tty?: string;
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

const NATIVE_PACKAGE = `@zenbu-labs/pixel-native-${process.platform}-${process.arch}`;

function loadBinding(): unknown {
  try {
    return require(`${NATIVE_PACKAGE}/pixel.node`);
  } catch (error) {
    const target = `${process.platform}-${process.arch} (${NATIVE_PACKAGE})`;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
        ? `no native build for ${target}: ${message}]`
        : `failed to load: ${message}]`,
    );
  }
}

if (process.platform === "darwin" && !process.env.NATIVE_SCROLL_HELPER) {
  try {
    process.env.NATIVE_SCROLL_HELPER = require.resolve(`${NATIVE_PACKAGE}/native-scroll-helper`);
  } catch {}
}

const binding = loadBinding() as {
  PixelEngine: new (
    tty?: string,
    wrapper?: string,
    sessionEnv?: Record<string, string>,
    host?: HostOptions,
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
};

export function createNativeEngine(
  tty?: string,
  wrapper?: string,
  sessionEnv?: NodeJS.ProcessEnv,
  host?: HostOptions,
): NativeEngine {
  const env = sessionEnv
    ? Object.fromEntries(
        Object.entries(sessionEnv).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  const pixelEngine = new binding.PixelEngine(tty, wrapper, env, host);

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

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
  socketPeerUid(fd: number): number;
  renameBeneath(root: string, from: string, to: string): void;
  openBeneath(dirFd: number, relative: string, ownerLinked?: boolean): number;
  openDirectoryAt(dirFd: number, name: string, create: boolean): number;
  readLinkAt(dirFd: number, name: string): SymbolicLink | null;
  aclGrantsOthers(fd: number, uid: number): "read" | "write" | null;
  clearAcl(fd: number): void;
  groupIsPrivateTo(gid: number, uid: number): boolean;
  quarantineFile(path: string, source: string, referrer: string, agent: string): void;
  quarantined(path: string): boolean | null;
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

export function socketPeerUid(fd: number): number {
  return binding.socketPeerUid(fd);
}

// Renames `from` to `to` (both relative to `root`, "/"-separated) without
// following a symlink in any directory below `root`; `from` must be a regular file.
export function renameBeneath(root: string, from: string, to: string): void {
  binding.renameBeneath(root, from, to);
}

// Native errors start with the errno name; copy it onto `code` like Node's fs errors.
function withErrnoCode<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    const code = /^(E[A-Z]+):/.exec((error as Error).message)?.[1];
    if (code) (error as NodeJS.ErrnoException).code = code;
    throw error;
  }
}

// Opens the regular file at `relative` ("/"-separated) below the directory
// `dirFd` without following a symlink at any step, and returns its descriptor.
// With `ownerLinked`, a file with more than one hard link is refused with EPERM
// unless nobody but its owner could have linked it into its folder.
export function openBeneath(dirFd: number, relative: string, ownerLinked = false): number {
  return withErrnoCode(() => binding.openBeneath(dirFd, relative, ownerLinked));
}

// Opens (and with `create`, first makes, mode 0700) the directory `name` inside
// `dirFd`, refusing a symlink with ELOOP.
export function openDirectoryAt(dirFd: number, name: string, create: boolean): number {
  return withErrnoCode(() => binding.openDirectoryAt(dirFd, name, create));
}

export interface SymbolicLink {
  target: string;
  owner: number;
}

// The symlink `name` inside `dirFd`, or null if it isn't one.
export function readLinkAt(dirFd: number, name: string): SymbolicLink | null {
  return withErrnoCode(() => binding.readLinkAt(dirFd, name));
}

// What an ACL on `fd` lets users other than `uid` and root do beyond its mode
// bits: "write" covers adding, removing or changing entries, contents or access.
export function aclGrantsOthers(fd: number, uid: number): "read" | "write" | null {
  return withErrnoCode(() => binding.aclGrantsOthers(fd, uid));
}

// Removes every ACL entry from `fd`, inherited and inheritable ones included.
export function clearAcl(fd: number): void {
  withErrnoCode(() => binding.clearAcl(fd));
}

export function groupIsPrivateTo(gid: number, uid: number): boolean {
  return binding.groupIsPrivateTo(gid, uid);
}

// Marks a downloaded file with where it came from, like a browser does: the
// quarantine flag on macOS, origin attributes on Linux. Throws if that fails.
export function quarantineFile(path: string, source: string, referrer: string, agent: string): void {
  binding.quarantineFile(path, source, referrer, agent);
}

// Whether macOS has the file quarantined; null on systems without quarantine.
export function quarantined(path: string): boolean | null {
  return binding.quarantined(path);
}

export function parseMarkdown(source: string, streaming?: boolean): MarkdownBlock[] {
  return binding.parseMarkdown(source, streaming);
}

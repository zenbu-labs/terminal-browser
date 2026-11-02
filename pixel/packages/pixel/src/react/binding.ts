import type { DiffRow, HighlightSpan, HostOptions, MarkdownBlock, NativeEngine } from "./native";

export interface NativeBinding {
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
}

let installed: NativeBinding | null = null;

export function setBinding(binding: NativeBinding): void {
  installed = binding;
}

export function installedBinding(): NativeBinding | null {
  return installed;
}

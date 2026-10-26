/// <reference path="../electron/electron.d.ts" preserve="true" />
export { createRoot } from "./root";
export type { LoadOptions, Root, RootOptions } from "./root";
export type { Instance } from "./instances";
export { findOwner, listInstances } from "./instances";
export { WebView } from "./webview";
export type {
  DownloadProgress,
  OpenWindowDecision,
  OpenWindowPolicy,
  BrowserWindowOptions,
  WebViewHandle,
  WebViewProps,
  WebViewRecording,
  WebViewState,
} from "./webview";
export { DevTools } from "./devtools";
export { useRect } from "./layout";
export type { Rect } from "./devtools-layout";
export type { DevToolsProps } from "./devtools";
export type { DevtoolsDock } from "./web/types";
export type { ZoomDirection } from "./web/zoom";
export type { TerminalTheme } from "./web/session";
export { QUIT_URL, defaultOpenWindow } from "./web/host";

export {
  Box,
  Text,
  Input,
  Image,
  MarkedText,
  Path,
  Markdown,
  Link,
  appLog,
  useTerminalColors,
  setClipboard,
  requestClipboardImage,
  highlight,
  diff,
  parseMarkdown,
  HIGHLIGHT_CAPTURES,
  Surface,
  SurfaceCapture,
  captureFilmstrip,
  encodeRecording,
  engineLogs,
  useStore,
} from "./react";
export type { LogRow, LogBuffer } from "./react";
export type {
  BoxProps,
  TextProps,
  TextSpan,
  InputProps,
  InputGutter,
  ImageProps,
  ImageAdvancedProps,
  MarkedTextProps,
  MarkRef,
  PathProps,
  ShapeStroke,
  ClickEvent,
  DragEvent,
  EventMods,
  MouseMoveEvent,
  ScrollEvent,
  WheelEvent,
  PointerEvent,
  PastedImage,
  PasteSource,
  CaretInfo,
  CaretShape,
  ChangeInfo,
  ChangeSource,
  ContainerSelection,
  SelectionPart,
  NodeHandle,
  Color,
  Edges,
  InsetEdges,
  InsetValue,
  PointerShape,
  ScrollbarStyle,
  Style,
  FontFace,
  FontFamily,
  EngineInfo,
  EngineKeyEvent,
  KeyMods,
  Rgba,
  TerminalColors,
  SurfaceFrame,
  SurfaceTexture,
  CaptureStats,
  CaptureFrameMeta,
  CaptureIndex,
  MarkdownProps,
  MarkdownTheme,
  LinkProps,
  MarkdownBlock,
  HighlightSpan,
  DiffRow,
} from "./react";
export { makeTheme } from "./theme";
export type { Theme } from "./theme";

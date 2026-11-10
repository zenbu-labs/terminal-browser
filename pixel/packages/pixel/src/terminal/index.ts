/// <reference path="../../electron/electron.d.ts" preserve="true" />
export type { Detect, Direction, ListPanesOptions, Pane, PaneContext, PaneDetails, SplitRequest, Terminal } from "./terminal";
export { canSplit } from "./terminal";
export type { Run } from "./run";
export { shellIn } from "./run";
export { bracketedPaste, callerTty, PASTE_KEY, shellLiteral } from "./shared";
export type { TerminalCheck } from "./detect";
export { cannotOpenPanes, checkTerminal, detect } from "./detect";
export type { GraphicsSupport } from "./graphics";
export type { Instance } from "../instances";
export { findOwner, listInstances, PROTOCOL as EMBED_PROTOCOL } from "../instances";
export { probeGraphics, SKIP_ENV as GRAPHICS_SKIP_ENV, UNSUPPORTED_ENV } from "./graphics";

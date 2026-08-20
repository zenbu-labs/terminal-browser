import type { Run } from "./run";

export type Direction = "right" | "left" | "down" | "up";

export interface Pane {
  id: string;
  tab: string;
}

export interface PaneContext {
  tty: string | null;
  cwd: string;
}

export interface SplitRequest {
  from: Pane;
  direction: Direction;
  command: string[];
  size: number | null;
  tty: string | null;
}

export interface TerminalKeybinding {
  action: string;
  binding: string;
  delivery: "consumed" | "conditional";
}

export interface Terminal {
  readonly name: string;
  /**
   * When terminal-browser tries to write to the TTY to render graphics using the
   * kitty graphics protocol, tmux will by default not forward those escape
   * codes to the outer TTY. But, tmux supports a passthrough mode if the content
   * is wrapped in tmux specific escape codes. We implement this "wrapping" functionality
   * internally, and allow a backend to configure what kind of wrapping should be applied (if any)
   */
  readonly wrapper?: "tmux";
  /**
   * When terminal-browser is rendered, it is scaled by the DPI of the display
   * Terminals that report css based pixels when queried already perform that normalization, so we need an explicit flag to avoid rescaling
   */
  readonly reportsCssPixels?: boolean;
  /**
   * Allows code to be ran at startup, useful for preparing the terminal environment for terminal-browser
   */
  prepare?(): void | Promise<void>;
  keybindings?(): Promise<TerminalKeybinding[]>;
  /**
   * Allows terminal-browser to know which pane its being called from inside the terminal.
   * This gives terminal-browser the ability to know if a terminal-browser instance
   * is open inside the terminal-pane, and powers features such as:
   * - terminal-browser ls lists the browers inside the current terminal tab
   * - terminal-browser new-tab [url] will open in the browser inside the current terminal tab by default
   */
  getCurrentPane?(context: PaneContext): Promise<Pane | null>;
  /**
   * This powers terminal-browser's --split argument. This is useful when using terminal-browser w/ coding agents
   * since it allows agents to open a browser next to their TUI without having to know how to
   * script the current terminal they are running in
   *
   */
  split?(request: SplitRequest): Promise<void>;
}

export type Detect = (env: NodeJS.ProcessEnv, run: Run) => Terminal | null;

export function canSplit(terminal: Terminal | null): boolean {
  return Boolean(terminal?.split);
}

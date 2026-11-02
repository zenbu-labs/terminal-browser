import type { Detect } from "../terminal";
import { cmux } from "./cmux";
import { ghostty } from "./ghostty";
import { herdr } from "./herdr";
import { iterm2 } from "./iterm2";
import { kitty } from "./kitty";
import { rex } from "./rex";
import { supacode } from "./supacode";
import { tmux } from "./tmux";
import { tty7 } from "./tty7";
import { vscode } from "./vscode";
import { wezterm } from "./wezterm";

/**
 * not fantastic, but ordering does matter
 */
export const TERMINALS: Detect[] = [
  herdr,
  tmux,
  tty7,
  rex,
  wezterm,
  kitty,
  cmux,
  supacode,
  iterm2,
  ghostty,
  vscode,
];

import type { Detect } from "../terminal";
import { cmux } from "./cmux";
import { ghostty } from "./ghostty";
import { herdr } from "./herdr";
import { kitty } from "./kitty";
import { supacode } from "./supacode";
import { tmux } from "./tmux";
import { tty7 } from "./tty7";
import { vscode } from "./vscode";
import { wezterm } from "./wezterm";
import { zellij } from "./zellij";

/**
 * not fantastic, but ordering does matter
 */
export const TERMINALS: Detect[] = [
  herdr,
  tmux,
  zellij,
  tty7,
  wezterm,
  kitty,
  cmux,
  supacode,
  ghostty,
  vscode,
];

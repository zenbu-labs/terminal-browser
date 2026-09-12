import type { Detect } from "../terminal";
import { rune } from "./rune";
import { cmux } from "./cmux";
import { ghostty } from "./ghostty";
import { herdr } from "./herdr";
import { kitty } from "./kitty";
import { supacode } from "./supacode";
import { tmux } from "./tmux";
import { tty7 } from "./tty7";
import { vscode } from "./vscode";
import { wezterm } from "./wezterm";

/**
 * not fantastic, but ordering does matter
 */
export const TERMINALS: Detect[] = [
  rune,
  herdr,
  tmux,
  tty7,
  wezterm,
  kitty,
  cmux,
  supacode,
  ghostty,
  vscode,
];

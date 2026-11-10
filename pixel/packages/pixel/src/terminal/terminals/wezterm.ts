import { adjacentPane, paneById, PASTE_KEY } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

interface WeztermPane {
  window_id: number;
  tab_id: number;
  pane_id: number;
  tty_name?: string | null;
  left_col?: number;
  top_row?: number;
  size?: { rows: number; cols: number };
}

const SPLIT_FLAG = { right: "--right", left: "--left", down: "--bottom", up: "--top" } as const;

export const wezterm: Detect = (env, run) => {
  if (env.TERM_PROGRAM !== "WezTerm" && !env.WEZTERM_PANE) return null;

  const wezterm = (args: string[], input?: string) => run("wezterm", args, input);

  async function panes(): Promise<Pane[]> {
    const list = JSON.parse(await wezterm(["cli", "list", "--format", "json"])) as WeztermPane[];
    return list.map((pane) => ({
      id: String(pane.pane_id),
      tab: `${pane.window_id}:${pane.tab_id}`,
    }));
  }

  async function listPanes(): Promise<PaneDetails[]> {
    const list = JSON.parse(await wezterm(["cli", "list", "--format", "json"])) as WeztermPane[];
    return list.map((pane) => ({
      id: String(pane.pane_id),
      tab: `${pane.window_id}:${pane.tab_id}`,
      tty: pane.tty_name || null,
      command: null,
    }));
  }

  async function neighbor(from: Pane, direction: "right" | "left" | "down" | "up"): Promise<Pane | null> {
    const list = JSON.parse(await wezterm(["cli", "list", "--format", "json"])) as WeztermPane[];
    const rects = list
      .filter((pane) => `${pane.window_id}:${pane.tab_id}` === from.tab && pane.size && pane.left_col != null && pane.top_row != null)
      .map((pane) => ({
        id: String(pane.pane_id),
        left: pane.left_col!,
        top: pane.top_row!,
        right: pane.left_col! + pane.size!.cols - 1,
        bottom: pane.top_row! + pane.size!.rows - 1,
      }));
    const self = rects.find((rect) => rect.id === from.id);
    if (!self) return null;
    const found = adjacentPane(self, rects, direction);
    return found ? { id: found.id, tab: from.tab } : null;
  }

  return {
    name: "wezterm",
    getCurrentPane: () => paneById(panes, env.WEZTERM_PANE),
    listPanes,
    neighbor,
    async sendText(pane, text) {
      await wezterm(["cli", "send-text", "--pane-id", pane], text);
    },
    async pasteKey(pane) {
      await wezterm(["cli", "send-text", "--no-paste", "--pane-id", pane], PASTE_KEY);
    },
    async focusPane(pane) {
      await wezterm(["cli", "activate-pane", "--pane-id", pane]);
    },
    async split({ direction, command }) {
      await wezterm(["cli", "split-pane", SPLIT_FLAG[direction], "--", ...command]);
    },
  };
};

import { paneById } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

interface WeztermPane {
  window_id: number;
  tab_id: number;
  pane_id: number;
  tty_name?: string | null;
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

  return {
    name: "wezterm",
    getCurrentPane: () => paneById(panes, env.WEZTERM_PANE),
    listPanes,
    async sendText(pane, text) {
      await wezterm(["cli", "send-text", "--pane-id", pane], text);
    },
    async focusPane(pane) {
      await wezterm(["cli", "activate-pane", "--pane-id", pane]);
    },
    async split({ direction, command }) {
      await wezterm(["cli", "split-pane", SPLIT_FLAG[direction], "--", ...command]);
    },
  };
};

import { paneById } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

interface WeztermPane {
  window_id: number;
  tab_id: number;
  pane_id: number;
  title: string;
  tty_name?: string | null;
  is_active?: boolean;
}

interface WeztermClient {
  focused_pane_id?: number | null;
  idle_time?: { secs: number; nanos: number };
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

  // `list` only says which pane is active within each tab; the pane the user is in comes
  // from the most recently active GUI client
  async function focusedPaneId(): Promise<number | null> {
    const clients = JSON.parse(
      await wezterm(["cli", "list-clients", "--format", "json"]).catch(() => "[]"),
    ) as WeztermClient[];
    const idle = (client: WeztermClient) =>
      (client.idle_time?.secs ?? Infinity) + (client.idle_time?.nanos ?? 0) / 1e9;
    const focused = clients
      .filter((client) => client.focused_pane_id != null)
      .sort((a, b) => idle(a) - idle(b))[0];
    return focused?.focused_pane_id ?? null;
  }

  async function listPanes(): Promise<PaneDetails[]> {
    const [list, focused] = await Promise.all([
      wezterm(["cli", "list", "--format", "json"]).then((out) => JSON.parse(out) as WeztermPane[]),
      focusedPaneId(),
    ]);
    return list.map((pane) => ({
      id: String(pane.pane_id),
      tab: `${pane.window_id}:${pane.tab_id}`,
      tty: pane.tty_name || null,
      title: pane.title || null,
      command: null,
      agent: null,
      focused: pane.pane_id === focused,
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

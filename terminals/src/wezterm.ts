import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Backend } from "./shared";

const run = promisify(execFile);

interface WeztermPane {
  window_id: number;
  tab_id: number;
  pane_id: number;
  title: string;
}

export function createWezterm(env: NodeJS.ProcessEnv = process.env): Backend {
  function wezterm(args: string[]) {
    return run("wezterm", args, { env, maxBuffer: 4 * 1024 * 1024, timeout: 8000 });
  }

  const backend: Backend = {
    app: "wezterm",
    async panes() {
      const selfId = Number(env.WEZTERM_PANE ?? -1);
      const { stdout } = await wezterm(["cli", "list", "--format", "json"]);
      const list = JSON.parse(stdout) as WeztermPane[];
      return list.map((pane) => ({
        window: String(pane.window_id),
        tab: String(pane.tab_id),
        pane: String(pane.pane_id),
        title: pane.title,
        self: pane.pane_id === selfId,
      }));
    },
    async split(direction, command, cwd) {
      const flag = { right: "--right", left: "--left", down: "--bottom", up: "--top" }[direction];
      await wezterm(["cli", "split-pane", flag, "--cwd", cwd, "--", ...command]);
    },
    async listAll() {
      return backend.panes();
    },
    async sendText(paneId, text) {
      await wezterm(["cli", "send-text", "--pane-id", paneId, "--no-paste", text]);
      await wezterm(["cli", "activate-pane", "--pane-id", paneId]);
      return true;
    },
    async focusPane(titleNeedle) {
      const target = (await backend.panes()).find((pane) => pane.title.includes(titleNeedle));
      if (!target) return false;
      await wezterm(["cli", "activate-pane", "--pane-id", target.pane]);
      return true;
    },
    async focusSelf() {
      const selfId = env.WEZTERM_PANE;
      if (!selfId) return false;
      await wezterm(["cli", "activate-pane", "--pane-id", selfId]);
      return true;
    },
  };
  return backend;
}

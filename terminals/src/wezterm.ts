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

export const wezterm: Backend = {
  app: "wezterm",
  async panes() {
    const selfId = Number(process.env.WEZTERM_PANE ?? -1);
    const { stdout } = await run("wezterm", ["cli", "list", "--format", "json"], {
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
    });
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
    await run("wezterm", ["cli", "split-pane", flag, "--cwd", cwd, "--", ...command], {
      env: process.env,
      timeout: 8000,
    });
  },
  async listAll() {
    return wezterm.panes();
  },
  async sendText(paneId, text) {
    await run("wezterm", ["cli", "send-text", "--pane-id", paneId, "--no-paste", text], {
      env: process.env,
      timeout: 8000,
    });
    await run("wezterm", ["cli", "activate-pane", "--pane-id", paneId], {
      env: process.env,
      timeout: 8000,
    });
    return true;
  },
  async focusPane(titleNeedle) {
    const target = (await wezterm.panes()).find((pane) => pane.title.includes(titleNeedle));
    if (!target) return false;
    await run("wezterm", ["cli", "activate-pane", "--pane-id", target.pane], {
      env: process.env,
      timeout: 8000,
    });
    return true;
  },
  async focusSelf() {
    const selfId = process.env.WEZTERM_PANE;
    if (!selfId) return false;
    await run("wezterm", ["cli", "activate-pane", "--pane-id", selfId], { env: process.env, timeout: 8000 });
    return true;
  },
};

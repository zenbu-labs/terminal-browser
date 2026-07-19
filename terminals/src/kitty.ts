import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Backend, Pane } from "./shared";

const run = promisify(execFile);

interface KittyWindow {
  id: number;
  title: string;
}

interface KittyTab {
  id: number;
  windows: KittyWindow[];
}

interface KittyOsWindow {
  id: number;
  tabs: KittyTab[];
}

async function kittyCmd(args: string[]): Promise<string> {
  const to = process.env.KITTY_LISTEN_ON;
  const { stdout } = await run(
    "kitty",
    ["@", ...(to ? ["--to", to] : []), ...args],
    { env: process.env, maxBuffer: 4 * 1024 * 1024, timeout: 8000 },
  );
  return stdout;
}

export const kitty: Backend = {
  app: "kitty",
  async panes() {
    const selfId = Number(process.env.KITTY_WINDOW_ID ?? -1);
    const osWindows = JSON.parse(await kittyCmd(["ls"])) as KittyOsWindow[];
    const panes: Pane[] = [];
    for (const osWindow of osWindows) {
      for (const tab of osWindow.tabs) {
        for (const window of tab.windows) {
          panes.push({
            window: String(osWindow.id),
            tab: String(tab.id),
            pane: String(window.id),
            title: window.title,
            self: window.id === selfId,
          });
        }
      }
    }
    return panes;
  },
  async split(direction, command, cwd) {
    const location = direction === "right" || direction === "left" ? "vsplit" : "hsplit";
    await kittyCmd(["launch", `--location=${location}`, `--cwd=${cwd}`, "--", ...command]);
  },
  async listAll() {
    return kitty.panes();
  },
  async sendText(paneId, text) {
    await kittyCmd(["send-text", "--match", `id:${paneId}`, "--", text]);
    await kittyCmd(["focus-window", "--match", `id:${paneId}`]);
    return true;
  },
  async focusPane(titleNeedle) {
    const target = (await kitty.panes()).find((pane) => pane.title.includes(titleNeedle));
    if (!target) return false;
    await kittyCmd(["focus-window", "--match", `id:${target.pane}`]);
    return true;
  },
  async focusSelf() {
    const selfId = process.env.KITTY_WINDOW_ID;
    if (!selfId) return false;
    await kittyCmd(["focus-window", "--match", `id:${selfId}`]);
    return true;
  },
};

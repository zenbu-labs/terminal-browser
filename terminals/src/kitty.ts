import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { Backend, Pane } from "./shared";

const run = promisify(execFile);

const SETUP_HINT = [
  "kitty has remote control switched off, and pixel needs it to script this terminal.",
  "Add these two lines to kitty.conf (usually ~/.config/kitty/kitty.conf), then fully quit and reopen kitty:",
  "  allow_remote_control socket-only",
  "  listen_on unix:/tmp/kitty",
].join("\n");

interface KittyWindow {
  id: number;
  title: string;
}

interface KittyTab {
  id: number;
  is_active: boolean;
  layout: string;
  enabled_layouts: string[];
  windows: KittyWindow[];
}

interface KittyOsWindow {
  id: number;
  tabs: KittyTab[];
}

function findKitten(env: NodeJS.ProcessEnv): string | null {
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, "kitten")),
    "/Applications/kitty.app/Contents/MacOS/kitten",
    path.join(env.HOME ?? "/", "Applications/kitty.app/Contents/MacOS/kitten"),
    ...pathDirs.map((dir) => path.join(dir, "kitty")),
  ];
  return (
    candidates.find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? null
  );
}

export function createKitty(env: NodeJS.ProcessEnv = process.env): Backend {
  let cachedBin: string | null | undefined;

  async function kittyCmd(args: string[]): Promise<string> {
    if (cachedBin === undefined) cachedBin = findKitten(env);
    if (!cachedBin) {
      throw new Error(
        "kitty's `kitten` command was not found — install kitty, or add kitten to PATH",
      );
    }
    const to = env.KITTY_LISTEN_ON;
    try {
      const { stdout } = await run(
        cachedBin,
        ["@", ...(to ? ["--to", to] : []), ...args],
        { env: process.env, maxBuffer: 4 * 1024 * 1024, timeout: 8000 },
      );
      return stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (stderr.includes("Remote control is disabled")) throw new Error(SETUP_HINT);
      throw error;
    }
  }

  async function osWindows(): Promise<KittyOsWindow[]> {
    return JSON.parse(await kittyCmd(["ls"])) as KittyOsWindow[];
  }

  const selfId = () => Number(env.KITTY_WINDOW_ID ?? -1);

  async function ensureSplitsLayout(): Promise<void> {
    const self = selfId();
    const tabs = (await osWindows()).flatMap((osWindow) => osWindow.tabs);
    const tab =
      tabs.find((candidate) => candidate.windows.some((window) => window.id === self)) ??
      tabs.find((candidate) => candidate.is_active);
    if (!tab || tab.layout === "splits") return;
    const hasSplits = tab.enabled_layouts.some(
      (layout) => layout === "splits" || layout.startsWith("splits:"),
    );
    if (!hasSplits) return;
    const match = self > 0 ? ["--match", `id:${self}`] : [];
    await kittyCmd(["goto-layout", ...match, "splits"]);
  }

  const backend: Backend = {
    app: "kitty",
    async panes() {
      const self = selfId();
      const panes: Pane[] = [];
      for (const osWindow of await osWindows()) {
        for (const tab of osWindow.tabs) {
          for (const window of tab.windows) {
            panes.push({
              window: String(osWindow.id),
              tab: String(tab.id),
              pane: String(window.id),
              title: window.title,
              self: window.id === self,
            });
          }
        }
      }
      return panes;
    },
    async split(direction, command, cwd, size) {
      await ensureSplitsLayout();
      const location = direction === "right" || direction === "left" ? "vsplit" : "hsplit";
      const bias = size ? [`--bias=${Math.round(size * 100)}`] : [];
      await kittyCmd([
        "launch",
        `--location=${location}`,
        `--cwd=${cwd}`,
        ...bias,
        "--",
        ...command,
      ]);
      if (direction === "left" || direction === "up") {
        await kittyCmd(["action", "move_window", direction]);
      }
    },
    async listAll() {
      return backend.panes();
    },
    async sendText(paneId, text) {
      await kittyCmd(["send-text", "--match", `id:${paneId}`, "--", text]);
      await kittyCmd(["focus-window", "--match", `id:${paneId}`]);
      return true;
    },
    async focusPane(titleNeedle) {
      const target = (await backend.panes()).find((pane) => pane.title.includes(titleNeedle));
      if (!target) return false;
      await kittyCmd(["focus-window", "--match", `id:${target.pane}`]);
      return true;
    },
    async focusSelf() {
      const self = selfId();
      if (self < 0) return false;
      await kittyCmd(["focus-window", "--match", `id:${self}`]);
      return true;
    },
    async closePane(titleNeedle) {
      const target = (await backend.panes()).find((pane) => pane.title.includes(titleNeedle));
      if (!target) return false;
      await kittyCmd(["close-window", "--match", `id:${target.pane}`]);
      return true;
    },
    async zoomPane(titleNeedle) {
      const target = (await backend.panes()).find((pane) => pane.title.includes(titleNeedle));
      if (!target) return false;
      await kittyCmd(["focus-window", "--match", `id:${target.pane}`]);
      await kittyCmd(["action", "toggle_layout", "stack"]);
      return true;
    },
  };
  return backend;
}

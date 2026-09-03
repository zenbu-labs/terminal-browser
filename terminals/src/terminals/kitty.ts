import fs from "node:fs";
import path from "node:path";

import { paneById } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

// todo: do this automatically
const SETUP_HINT = [
  "kitty has remote control switched off, and terminal-browser needs it to script this terminal.",
  "Add these two lines to kitty.conf (usually ~/.config/kitty/kitty.conf), then fully quit and reopen kitty:",
  "  allow_remote_control socket-only",
  "  listen_on unix:/tmp/kitty",
].join("\n");

interface KittyWindow {
  id: number;
  title: string;
  pid?: number | null;
  is_active?: boolean;
  is_focused?: boolean;
  foreground_processes?: { pid?: number; cmdline?: string[] }[];
}

interface KittyTab {
  id: number;
  is_active: boolean;
  is_focused?: boolean;
  layout: string;
  enabled_layouts: string[];
  windows: KittyWindow[];
}

interface KittyOsWindow {
  id: number;
  is_active?: boolean;
  is_focused?: boolean;
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

export const kitty: Detect = (env, run) => {
  const looksLikeKitty =
    (env.TERM ?? "").includes("kitty") || env.KITTY_WINDOW_ID || env.KITTY_PID;
  if (!looksLikeKitty) return null;

  let cachedBin: string | null | undefined;

  async function kitten(args: string[], input?: string): Promise<string> {
    if (cachedBin === undefined) cachedBin = findKitten(env);
    if (!cachedBin) {
      throw new Error("kitty's `kitten` command was not found — install kitty, or add kitten to PATH");
    }
    const listenOn = env.KITTY_LISTEN_ON && !env.KITTY_LISTEN_ON.startsWith("fd:") ? env.KITTY_LISTEN_ON : null;
    const to = listenOn ? ["--to", listenOn] : [];
    try {
      return await run(cachedBin, ["@", ...to, ...args], input);
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (stderr.includes("Remote control is disabled")) throw new Error(SETUP_HINT);
      throw error;
    }
  }

  const osWindows = async () => JSON.parse(await kitten(["ls"])) as KittyOsWindow[];

  async function panes(): Promise<Pane[]> {
    const panes: Pane[] = [];
    for (const osWindow of await osWindows()) {
      for (const tab of osWindow.tabs) {
        for (const window of tab.windows) {
          panes.push({
            id: String(window.id),
            tab: `${osWindow.id}:${tab.id}`,
          });
        }
      }
    }
    return panes;
  }

  async function listPanes(): Promise<PaneDetails[]> {
    const listed: { pane: PaneDetails; pid: number | null }[] = [];
    for (const osWindow of await osWindows()) {
      for (const tab of osWindow.tabs) {
        for (const window of tab.windows) {
          const pid = window.pid ?? window.foreground_processes?.[0]?.pid ?? null;
          listed.push({
            pid,
            pane: {
              id: String(window.id),
              tab: `${osWindow.id}:${tab.id}`,
              tty: null,
              title: window.title || null,
              command:
                (window.foreground_processes ?? [])
                  .map((process) => (process.cmdline ?? []).join(" "))
                  .join("\n") || null,
              agent: null,
              focused:
                window.is_focused === true ||
                (osWindow.is_active === true && tab.is_active && window.is_active === true),
            },
          });
        }
      }
    }
    const pids = listed.map((entry) => entry.pid).filter((pid): pid is number => pid != null);
    if (pids.length > 0) {
      const byPid = new Map<number, string>();
      const out = await run("ps", ["-o", "pid=,tty=", "-p", pids.join(",")]).catch(() => "");
      for (const line of out.split("\n")) {
        const [pid, tty] = line.trim().split(/\s+/);
        if (pid && tty && tty !== "??") byPid.set(Number(pid), `/dev/${tty}`);
      }
      for (const entry of listed) {
        if (entry.pid != null) entry.pane.tty = byPid.get(entry.pid) ?? null;
      }
    }
    return listed.map((entry) => entry.pane);
  }

  /** kitty can only place splits in a layout that has them. */
  async function ensureSplitsLayout(paneId: string): Promise<void> {
    const self = Number(paneId);
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
    await kitten(["goto-layout", ...match, "splits"]);
  }

  return {
    name: "kitty",
    getCurrentPane: () => paneById(panes, env.KITTY_WINDOW_ID),
    listPanes,
    async sendText(pane, text) {
      const target = ["send-text", "--match", `id:${pane}`, "--stdin"];
      try {
        await kitten([...target, "--bracketed-paste", "auto"], text);
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        if (!/bracketed-paste/.test(stderr)) throw error;
        await kitten(target, text);
      }
    },
    async focusPane(pane) {
      await kitten(["focus-window", "--match", `id:${pane}`]);
    },
    async split({ from, direction, command, size }) {
      await ensureSplitsLayout(from.id);
      const location = direction === "right" || direction === "left" ? "vsplit" : "hsplit";
      const bias = size ? [`--bias=${Math.round(size * 100)}`] : [];
      await kitten(["launch", `--location=${location}`, ...bias, "--", ...command]);
      if (direction === "left" || direction === "up") {
        await kitten(["action", "move_window", direction]);
      }
    },
  };
};

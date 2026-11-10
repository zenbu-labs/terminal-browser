import fs from "node:fs";
import path from "node:path";

import { adjacentPane, paneById, PASTE_KEY } from "../shared";
import type { PaneRect } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

// todo: do this automatically
const SETUP_HINT = [
  "kitty has remote control switched off, which is required for this feature",
  "Add these two lines to kitty.conf (usually ~/.config/kitty/kitty.conf), then fully quit and reopen kitty:",
  "  allow_remote_control socket-only",
  "  listen_on unix:/tmp/kitty",
].join("\n");

interface KittyWindow {
  id: number;
  pid?: number | null;
  foreground_processes?: { pid?: number; cmdline?: string[] }[];
}

interface KittyPair {
  horizontal?: boolean;
  bias?: number;
  one?: number | KittyPair;
  two?: number | KittyPair;
}

interface KittyTab {
  id: number;
  is_active: boolean;
  layout: string;
  layout_state?: { pairs?: KittyPair };
  enabled_layouts: string[];
  windows: KittyWindow[];
  groups?: { id: number; windows: number[] }[];
}


const GRID = 10000;

function pairRects(tab: KittyTab): PaneRect[] {
  const pairs = tab.layout_state?.pairs;
  if (tab.layout !== "splits" || !pairs) return [];
  const groups = new Map((tab.groups ?? []).map((group) => [group.id, group.windows[0]]));
  const windowIds = new Set(tab.windows.map((window) => window.id));
  const rects: PaneRect[] = [];
  const walk = (node: number | KittyPair | undefined, left: number, top: number, width: number, height: number) => {
    if (node === undefined) return;
    if (typeof node === "number") {
      const id = windowIds.has(node) ? node : groups.get(node);
      if (id !== undefined) rects.push({ id: String(id), left, top, right: left + width - 1, bottom: top + height - 1 });
      return;
    }
    const bias = node.bias ?? 0.5;
    if (node.one === undefined || node.two === undefined) {
      walk(node.one ?? node.two, left, top, width, height);
      return;
    }
    if (node.horizontal ?? true) {
      const first = Math.round(width * bias);
      walk(node.one, left, top, first, height);
      walk(node.two, left + first, top, width - first, height);
    } else {
      const first = Math.round(height * bias);
      walk(node.one, left, top, width, first);
      walk(node.two, left, top + first, width, height - first);
    }
  };
  walk(pairs, 0, 0, GRID, GRID);
  return rects;
}

interface KittyOsWindow {
  id: number;
  tabs: KittyTab[];
}

function findKitten(env: NodeJS.ProcessEnv): string | null {
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const appBundles =
    process.platform === "darwin"
      ? [
          "/Applications/kitty.app/Contents/MacOS/kitten",
          path.join(env.HOME ?? "/", "Applications/kitty.app/Contents/MacOS/kitten"),
        ]
      : [];
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, "kitten")),
    ...appBundles,
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
              command:
                (window.foreground_processes ?? [])
                  .map((process) => (process.cmdline ?? []).join(" "))
                  .join("\n") || null,
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

  async function neighbor(from: Pane, direction: "right" | "left" | "down" | "up"): Promise<Pane | null> {
    const self = Number(from.id);
    const tab = (await osWindows())
      .flatMap((osWindow) => osWindow.tabs)
      .find((candidate) => candidate.windows.some((window) => window.id === self));
    if (!tab) return null;
    const rects = pairRects(tab);
    const own = rects.find((rect) => rect.id === from.id);
    if (!own) return null;
    const found = adjacentPane(own, rects, direction, 1);
    return found ? { id: found.id, tab: from.tab } : null;
  }

  return {
    name: "kitty",
    getCurrentPane: () => paneById(panes, env.KITTY_WINDOW_ID),
    listPanes,
    neighbor,
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
    async pasteKey(pane) {
      await kitten(["send-text", "--match", `id:${pane}`, "--stdin"], PASTE_KEY);
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

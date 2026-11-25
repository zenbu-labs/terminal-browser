import path from "node:path";

import { adjacentPane, paneById, sleep } from "../shared";
import type { PaneRect } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

interface ThurmPane {
  id: number;
  pid: number | null;
  alive: boolean;
}

type ThurmNode =
  | { type: "pane"; id: number; host?: string }
  | { type: "split"; dir: "right" | "down" | "left" | "up"; ratio: number; first: ThurmNode; second: ThurmNode };

interface ThurmTab {
  root: ThurmNode;
  floating?: { id: number; host?: string }[];
}

interface ThurmLayout {
  windows: { tabs: ThurmTab[] }[];
  workspaces?: { tabs: ThurmTab[] }[];
  quick?: ThurmTab;
}

const LAYOUT_UNITS = 10_000;
const LAYOUT_SAVE_MS = 600;

function localPaneIds(node: ThurmNode, into: number[] = []): number[] {
  if (node.type === "pane") {
    if (!node.host) into.push(node.id);
  } else {
    localPaneIds(node.first, into);
    localPaneIds(node.second, into);
  }
  return into;
}

function tabPanes(tab: ThurmTab): number[] {
  return [...localPaneIds(tab.root), ...(tab.floating ?? []).filter((f) => !f.host).map((f) => f.id)];
}

function tabId(tab: ThurmTab): string | null {
  const ids = tabPanes(tab);
  return ids.length ? `tab:${Math.min(...ids)}` : null;
}

function layoutRects(node: ThurmNode, x: number, y: number, w: number, h: number, into: PaneRect[] = []): PaneRect[] {
  if (node.type === "pane") {
    if (!node.host) into.push({ id: String(node.id), left: x, top: y, right: x + w - 1, bottom: y + h - 1 });
    return into;
  }
  if (node.dir === "right" || node.dir === "left") {
    const first = Math.round(w * node.ratio);
    layoutRects(node.first, x, y, first, h, into);
    layoutRects(node.second, x + first, y, w - first, h, into);
  } else {
    const first = Math.round(h * node.ratio);
    layoutRects(node.first, x, y, w, first, into);
    layoutRects(node.second, x, y + first, w, h - first, into);
  }
  return into;
}

export const thurm: Detect = (env, run) => {
  if (!env.THURM_PANE_ID || env.GHOSTTY_RESOURCES_DIR) return null;

  const bin = env.THURM_BIN_DIR ? path.join(env.THURM_BIN_DIR, "thurm") : "thurm";
  const thurm = (args: string[], input?: string) => run(bin, args, input);

  async function tabs(): Promise<ThurmTab[]> {
    const layout = JSON.parse(await thurm(["layout", "--json"])) as ThurmLayout;
    const all = [...layout.windows, ...(layout.workspaces ?? [])].flatMap((window) => window.tabs);
    return layout.quick ? [...all, layout.quick] : all;
  }

  async function listed(): Promise<ThurmPane[]> {
    return JSON.parse(await thurm(["list", "--json"])) as ThurmPane[];
  }

  async function livePanes(): Promise<(Pane & { pid: number | null })[]> {
    const tabOf = new Map<string, string>();
    for (const tab of await tabs()) {
      const id = tabId(tab);
      if (id) for (const pane of tabPanes(tab)) tabOf.set(String(pane), id);
    }
    return (await listed())
      .filter((pane) => pane.alive && tabOf.has(String(pane.id)))
      .map((pane) => ({ id: String(pane.id), tab: tabOf.get(String(pane.id))!, pid: pane.pid }));
  }

  async function panes(): Promise<Pane[]> {
    return (await livePanes()).map(({ id, tab }) => ({ id, tab }));
  }

  async function ttys(pids: number[]): Promise<Map<number, string>> {
    const found = new Map<number, string>();
    if (pids.length === 0) return found;
    const out = await run("ps", ["-o", "pid=,tty=", "-p", pids.join(",")]).catch(() => "");
    for (const line of out.split("\n")) {
      const [pid, tty] = line.trim().split(/\s+/);
      if (pid && tty && !tty.startsWith("?")) found.set(Number(pid), `/dev/${tty}`);
    }
    return found;
  }

  async function currentPane(): Promise<Pane | null> {
    const id = env.THURM_PANE_ID;
    const pane = await paneById(panes, id);
    if (pane || !(await listed()).some((live) => live.alive && String(live.id) === id)) return pane;
    await sleep(LAYOUT_SAVE_MS);
    return paneById(panes, id);
  }

  async function listPanes(): Promise<PaneDetails[]> {
    const all = await livePanes();
    const ttyOf = await ttys(all.flatMap((pane) => (pane.pid == null ? [] : [pane.pid])));
    return all.map(({ id, tab, pid }) => ({ id, tab, tty: (pid != null && ttyOf.get(pid)) || null, command: null }));
  }

  async function neighbor(from: Pane, direction: "right" | "left" | "down" | "up"): Promise<Pane | null> {
    const tab = (await tabs()).find((candidate) => tabId(candidate) === from.tab);
    if (!tab) return null;
    const rects = layoutRects(tab.root, 0, 0, LAYOUT_UNITS, LAYOUT_UNITS);
    const self = rects.find((rect) => rect.id === from.id);
    if (!self) return null;
    const found = adjacentPane(self, rects, direction);
    return found ? { id: found.id, tab: from.tab } : null;
  }

  return {
    name: "thurm",
    getCurrentPane: currentPane,
    listPanes,
    neighbor,
    async sendText(pane, text) {
      if (text === "") return;
      const paste = text.includes("\n") ? ["--paste"] : [];
      await thurm(["send", "--pane", pane, "--no-enter", ...paste, "-"], text);
    },
    async pasteKey(pane) {
      await thurm(["send-keys", "--pane", pane, "C-v"]);
    },
    async focusPane(pane) {
      await thurm(["focus", pane]);
    },
    async split({ from, direction, command, size }) {
      const share = size ? ["--size", String(Math.round(size * 100))] : [];
      await thurm(["split", "--pane", from.id, "--dir", direction, ...share, "--", ...command]);
    },
  };
};

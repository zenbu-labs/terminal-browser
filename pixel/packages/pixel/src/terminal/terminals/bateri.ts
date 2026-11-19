import { adjacentPane, bracketedPaste, callerTty } from "../shared";
import type { PaneRect } from "../shared";
import type { Detect, Pane, PaneContext, PaneDetails } from "../terminal";

type BateriTree =
  | { id: string }
  | { axis: "side_by_side" | "stacked"; ratio: number; first: BateriTree; second: BateriTree };

interface BateriListing {
  caller: string | null;
  windows: { tabs: { id: string; tree: BateriTree }[] }[];
  terminals: { id: string; tab: string | null; program: string | null; state: string }[];
}

const SIDE = { right: "--right", left: "--left", down: "--below", up: "--above" } as const;

const LAYOUT_UNITS = 10_000;

function treeRects(tree: BateriTree, x = 0, y = 0, w = 1, h = 1, into: PaneRect[] = []): PaneRect[] {
  if ("id" in tree) {
    const left = Math.round(x * LAYOUT_UNITS);
    const top = Math.round(y * LAYOUT_UNITS);
    const right = Math.round((x + w) * LAYOUT_UNITS) - 1;
    const bottom = Math.round((y + h) * LAYOUT_UNITS) - 1;
    into.push({ id: tree.id, left, top, right, bottom });
  } else if (tree.axis === "side_by_side") {
    treeRects(tree.first, x, y, w * tree.ratio, h, into);
    treeRects(tree.second, x + w * tree.ratio, y, w * (1 - tree.ratio), h, into);
  } else {
    treeRects(tree.first, x, y, w, h * tree.ratio, into);
    treeRects(tree.second, x, y + h * tree.ratio, w, h * (1 - tree.ratio), into);
  }
  return into;
}

export const bateri: Detect = (env, run) => {
  if (env.TERM_PROGRAM !== "bateri") return null;

  const bateri = (args: string[], input?: string) => run("bateri", args, input);

  async function listing(): Promise<BateriListing> {
    return JSON.parse(await bateri(["ls", "--json"])) as BateriListing;
  }

  // bateri names the caller by the pane this process runs in, which only answers for a tty that is ours
  async function getCurrentPane({ tty }: PaneContext): Promise<Pane | null> {
    if (tty && tty !== callerTty().path) return null;
    const { caller, terminals } = await listing();
    const own = terminals.find((terminal) => terminal.id === caller);
    return own?.tab ? { id: own.id, tab: own.tab } : null;
  }

  async function listPanes(): Promise<PaneDetails[]> {
    const { terminals } = await listing();
    return terminals.flatMap((terminal) =>
      terminal.tab && terminal.state === "running"
        ? [{ id: terminal.id, tab: terminal.tab, tty: null, command: terminal.program }]
        : [],
    );
  }

  async function neighbor(from: Pane, direction: "right" | "left" | "down" | "up"): Promise<Pane | null> {
    const { windows } = await listing();
    const tab = windows.flatMap((window) => window.tabs).find((tab) => tab.id === from.tab);
    if (!tab) return null;
    const rects = treeRects(tab.tree);
    const self = rects.find((rect) => rect.id === from.id);
    if (!self) return null;
    const found = adjacentPane(self, rects, direction);
    return found ? { id: found.id, tab: from.tab } : null;
  }

  return {
    name: "bateri",
    getCurrentPane,
    listPanes,
    neighbor,
    async sendText(pane, text) {
      if (text === "") return;
      await bateri(["send", pane, "-"], bracketedPaste(text));
    },
    async pasteKey(pane) {
      await bateri(["send-key", pane, "ctrl+v"]);
    },
    async focusPane(pane) {
      await bateri(["focus", "pane", pane]);
    },
    async split({ from, direction, command, size }) {
      const ratio = size ? ["--ratio", String(Math.round(size * 100))] : [];
      await bateri(["split", from.id, SIDE[direction], ...ratio, "--", ...command]);
    },
  };
};

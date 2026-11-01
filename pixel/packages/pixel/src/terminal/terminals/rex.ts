import { adjacentPane, bracketedPaste, paneById, PASTE_KEY } from "../shared";
import type { PaneRect } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

interface RexBlock {
  block_id: string;
  window_id: string;
}

interface RexLayout {
  rect: [number, number, number, number];
  block_id?: string;
  split?: { before: RexLayout; after: RexLayout };
}

interface RexWindow {
  layers: { kind: string; layout?: RexLayout }[];
}

const SPLIT_DIRECTION = { right: "right", left: "left", down: "below", up: "above" } as const;

const LAYOUT_UNITS = 10_000;

function layoutRects(layout: RexLayout | undefined, into: PaneRect[] = []): PaneRect[] {
  if (!layout) return into;
  if (layout.block_id) {
    const [x, y, w, h] = layout.rect.map((value) => Math.round(value * LAYOUT_UNITS));
    into.push({ id: layout.block_id, left: x, top: y, right: x + w - 1, bottom: y + h - 1 });
  }
  layoutRects(layout.split?.before, into);
  layoutRects(layout.split?.after, into);
  return into;
}

export const rex: Detect = (env, run) => {
  if (!env.REX_BLOCK && env.TERM_PROGRAM !== "rex") return null;

  const rex = (args: string[], input?: string) => run("rex", args, input);

  async function panes(): Promise<Pane[]> {
    const { blocks } = JSON.parse(await rex(["block", "ls", "--json"])) as {
      blocks: RexBlock[];
    };
    return blocks.map((block) => ({ id: block.block_id, tab: block.window_id }));
  }

  async function ttyOf(block: string): Promise<string | null> {
    const info = JSON.parse(await rex(["block", "call", "process", "--block", block])) as {
      child?: { pid: number };
    };
    if (!info.child) return null;
    const tty = (await run("ps", ["-o", "tty=", "-p", String(info.child.pid)])).trim();
    return tty && !tty.startsWith("?") ? `/dev/${tty}` : null;
  }

  async function listPanes(): Promise<PaneDetails[]> {
    return Promise.all(
      (await panes()).map(async (pane) => ({
        ...pane,
        tty: await ttyOf(pane.id).catch(() => null),
        command: null,
      })),
    );
  }

  async function neighbor(from: Pane, direction: "right" | "left" | "down" | "up"): Promise<Pane | null> {
    const window = JSON.parse(await rex(["window", "inspect", from.tab, "--json"])) as RexWindow;
    const rects = window.layers
      .filter((layer) => layer.kind === "tiled")
      .flatMap((layer) => layoutRects(layer.layout));
    const self = rects.find((rect) => rect.id === from.id);
    if (!self) return null;
    const found = adjacentPane(self, rects, direction);
    return found ? { id: found.id, tab: from.tab } : null;
  }

  return {
    name: "rex",
    getCurrentPane: () => paneById(panes, env.REX_BLOCK),
    listPanes,
    neighbor,
    async sendText(pane, text) {
      if (text === "") return;
      await rex(["send", "--block", pane], bracketedPaste(text));
    },
    async pasteKey(pane) {
      await rex(["send", "--block", pane], PASTE_KEY);
    },
    async focusPane(pane) {
      await rex(["focus", pane]);
    },
    async split({ from, direction, command, size }) {
      const ratio = size ? ["--ratio", String(Math.round(size * 100))] : [];
      await rex(["split", "--block", from.id, "--split", SPLIT_DIRECTION[direction], ...ratio, "--", ...command]);
    },
  };
};

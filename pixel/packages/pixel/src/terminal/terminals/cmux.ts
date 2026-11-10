import { adjacentPane, paneById, PASTE_KEY, shellQuote } from "../shared";
import type { PaneRect } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

interface Listed {
  id?: string;
  ref?: string;
  title?: string;
  focused?: boolean;
  selected?: boolean;
}

interface Frame {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface CmuxPaneRow {
  id?: string;
  ref?: string;
  pixel_frame?: Frame;
  frame?: Frame;
}

interface CmuxTree {
  windows?: {
    workspaces?: {
      id: string;
      panes?: {
        surfaces?: { id: string; type?: string; tty?: string | null }[];
      }[];
    }[];
  }[];
}

export const cmux: Detect = (env, run) => {
  if (!env.CMUX_SURFACE_ID) return null;

  const binary = env.CMUX_BUNDLED_CLI_PATH ?? "cmux";
  const cmux = (args: string[]) => run(binary, args);
  const asked = async (args: string[]) =>
    JSON.parse(await cmux([...args, "--json", "--id-format", "both"]));

  async function panes(): Promise<Pane[]> {
    const listed: Listed[] = (await asked(["list-panes"])).panes ?? [];
    const found: Pane[] = [];
    for (const pane of listed) {
      const paneId = pane.id ?? pane.ref;
      if (!paneId) continue;
      const surfaces: Listed[] = (await asked(["list-pane-surfaces", "--pane", paneId]))
        .surfaces ?? [];
      for (const surface of surfaces) {
        if (!surface.id) continue;
        found.push({ id: surface.id, tab: env.CMUX_WORKSPACE_ID ?? "" });
      }
    }
    return found;
  }

  async function listPanes(): Promise<PaneDetails[]> {
    const tree = (await asked(["tree", "--all"])) as CmuxTree;
    const found: PaneDetails[] = [];
    for (const window of tree.windows ?? []) {
      for (const workspace of window.workspaces ?? []) {
        for (const pane of workspace.panes ?? []) {
          for (const surface of pane.surfaces ?? []) {
            if (surface.type !== undefined && surface.type !== "terminal") continue;
            found.push({
              id: surface.id,
              tab: workspace.id,
              tty: surface.tty || null,
              command: null,
            });
          }
        }
      }
    }
    return found;
  }


  async function neighbor(from: Pane, direction: "right" | "left" | "down" | "up"): Promise<Pane | null> {
    const workspace = from.tab || env.CMUX_WORKSPACE_ID;
    const rows: CmuxPaneRow[] =
      (await asked(["rpc", "pane.list", JSON.stringify(workspace ? { workspace_id: workspace } : {})])).panes ?? [];
    const rects: PaneRect[] = [];
    const surfacesOf = new Map<string, Listed[]>();
    for (const row of rows) {
      const id = row.id ?? row.ref;
      const frame = row.pixel_frame ?? row.frame;
      if (!id || !frame || frame.x == null || frame.y == null || frame.width == null || frame.height == null) continue;
      rects.push({
        id,
        left: Math.round(frame.x),
        top: Math.round(frame.y),
        right: Math.round(frame.x + frame.width) - 1,
        bottom: Math.round(frame.y + frame.height) - 1,
      });
      surfacesOf.set(id, (await asked(["list-pane-surfaces", "--pane", id])).surfaces ?? []);
    }
    const own = rects.find((rect) => (surfacesOf.get(rect.id) ?? []).some((surface) => surface.id === from.id));
    if (!own) return null;
    const found = adjacentPane(own, rects, direction, 16);
    if (!found) return null;
    const surfaces = surfacesOf.get(found.id) ?? [];
    const shown = surfaces.find((surface) => surface.focused || surface.selected) ?? surfaces[0];
    return shown?.id ? { id: shown.id, tab: from.tab } : null;
  }

  return {
    name: "cmux",
    getCurrentPane: () => paneById(panes, env.CMUX_SURFACE_ID),
    listPanes,
    neighbor,
    async sendText(pane, text) {
      await cmux(["rpc", "terminal.paste", JSON.stringify({ text, surface_id: pane, submit_key: "none" })]);
    },
    async pasteKey(pane) {
      await cmux(["send", "--surface", pane, "--", PASTE_KEY]);
    },
    async focusPane(pane) {
      await cmux(["focus-panel", "--panel", pane]);
    },
    async split({ from, direction, command }) {
      const created = await asked(["new-split", direction, "--surface", from.id, "--focus", "true"]);
      const opened = created.surface_id ?? created.surface_ref;
      if (!opened) throw new Error("cmux opened a split but did not say which surface it is");
      await cmux(["send", "--surface", opened, "--", `${shellQuote(command)}\\n`]);
    },
  };
};

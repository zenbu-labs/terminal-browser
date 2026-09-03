import { paneById, shellQuote } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

interface Listed {
  id?: string;
  ref?: string;
  title?: string;
}

interface CmuxTree {
  active?: { surface_id?: string };
  windows?: {
    workspaces?: {
      id: string;
      panes?: {
        surfaces?: { id: string; type?: string; title?: string; tty?: string | null }[];
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
              title: surface.title || null,
              command: null,
              agent: null,
              focused: surface.id === tree.active?.surface_id,
            });
          }
        }
      }
    }
    return found;
  }

  return {
    name: "cmux",
    getCurrentPane: () => paneById(panes, env.CMUX_SURFACE_ID),
    listPanes,
    async sendText(pane, text) {
      await cmux(["send", "--surface", pane, "--", text]);
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

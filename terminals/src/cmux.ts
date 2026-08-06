import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Backend, Pane, shellQuote } from "./shared";

const run = promisify(execFile);

interface TreeSurface {
  ref: string;
  type: string;
  title: string | null;
  here: boolean;
}

interface TreeNode {
  ref: string;
  workspaces?: TreeNode[];
  panes?: TreeNode[];
  surfaces?: TreeSurface[];
}

interface Tree {
  windows?: TreeNode[];
}

interface CmuxPane extends Pane {
  surface: string;
}

export function createCmux(env: NodeJS.ProcessEnv = process.env): Backend {
  const bin = env.CMUX_BUNDLED_CLI_PATH ?? "cmux";

  async function cmux(args: string[]): Promise<string> {
    const { stdout } = await run(bin, args, {
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
    });
    return stdout;
  }

  // cmux nests surfaces under panes under workspaces; a workspace is what the
  // rest of terminal-browser calls a tab.
  async function list(): Promise<CmuxPane[]> {
    const tree = JSON.parse(await cmux(["tree", "--all", "--json"])) as Tree;
    const panes: CmuxPane[] = [];
    for (const window of tree.windows ?? []) {
      for (const workspace of window.workspaces ?? []) {
        for (const pane of workspace.panes ?? []) {
          for (const surface of pane.surfaces ?? []) {
            if (surface.type !== "terminal") continue;
            panes.push({
              window: window.ref,
              tab: workspace.ref,
              pane: pane.ref,
              surface: surface.ref,
              title: surface.title ?? "",
              self: surface.here,
            });
          }
        }
      }
    }
    return panes;
  }

  async function find(titleNeedle: string): Promise<CmuxPane | null> {
    return (await list()).find((pane) => pane.title.includes(titleNeedle)) ?? null;
  }

  const backend: Backend = {
    app: "cmux",
    async panes() {
      return list();
    },
    async listAll() {
      return list();
    },
    async split(direction, command) {
      const created = await cmux(["new-split", direction, "--focus", "true"]);
      const surface = /surface:\d+/.exec(created)?.[0];
      if (!surface) throw new Error(`cmux new-split reported no surface: ${created.trim()}`);
      await cmux(["send", "--surface", surface, shellQuote(command)]);
      await cmux(["send-key", "--surface", surface, "Enter"]);
    },
    async sendText(paneId, text) {
      const target = (await list()).find((pane) => pane.pane === paneId);
      if (!target) return false;
      await cmux(["send", "--surface", target.surface, text]);
      await cmux(["focus-pane", "--pane", target.pane]);
      return true;
    },
    async focusPane(titleNeedle) {
      const target = await find(titleNeedle);
      if (!target) return false;
      await cmux(["focus-pane", "--pane", target.pane]);
      return true;
    },
    async focusSelf() {
      const target = (await list()).find((pane) => pane.self);
      if (!target) return false;
      await cmux(["focus-pane", "--pane", target.pane]);
      return true;
    },
    async closePane(titleNeedle) {
      const target = await find(titleNeedle);
      if (!target) return false;
      await cmux(["close-surface", "--surface", target.surface]);
      return true;
    },
  };
  return backend;
}

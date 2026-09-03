import fs from "node:fs";

import { paneById, shellQuote } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

const BUNDLED_CLI = "/Applications/supacode.app/Contents/Resources/bin/supacode";

export const supacode: Detect = (env, run) => {
  if (!env.SUPACODE_SURFACE_ID && env.TERM_PROGRAM !== "supacode") return null;

  const binary = fs.existsSync(BUNDLED_CLI) && !env.SUPACODE_SURFACE_ID ? BUNDLED_CLI : "supacode";
  const supacode = (args: string[]) => run(binary, args);
  const lines = async (args: string[]) =>
    (await supacode(args))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

  async function panes(): Promise<Pane[]> {
    const found: Pane[] = [];
    for (const tab of await lines(["tab", "list"])) {
      for (const surface of await lines(["surface", "list", "--tab", tab])) {
        found.push({ id: surface, tab });
      }
    }
    return found;
  }
  const homes = new Map<string, { worktree: string; tab: string }>();

  async function listPanes(): Promise<PaneDetails[]> {
    const worktrees = env.SUPACODE_WORKTREE_ID ? [env.SUPACODE_WORKTREE_ID] : await lines(["worktree", "list"]);
    const found: PaneDetails[] = [];
    for (const worktree of worktrees) {
      const [tabs, focusedTabs] = await Promise.all([
        lines(["tab", "list", "-w", worktree]),
        lines(["tab", "list", "-w", worktree, "-f"]).catch(() => [] as string[]),
      ]);
      for (const tab of tabs) {
        for (const surface of await lines(["surface", "list", "-w", worktree, "-t", tab])) {
          homes.set(surface, { worktree, tab });
          found.push({
            id: surface,
            tab,
            tty: null,
            title: null,
            command: null,
            agent: null,
            focused: focusedTabs.includes(tab),
          });
        }
      }
    }
    return found;
  }

  async function home(surface: string): Promise<{ worktree: string; tab: string }> {
    if (!homes.has(surface)) await listPanes();
    const found = homes.get(surface);
    if (!found) throw new Error(`supacode has no surface ${surface}`);
    return found;
  }

  return {
    name: "supacode",
    getCurrentPane: () => paneById(panes, env.SUPACODE_SURFACE_ID),
    listPanes,
    async sendText(pane, text) {
      const { worktree, tab } = await home(pane);
      await supacode(["surface", "focus", "-w", worktree, "-t", tab, "-s", pane, "--input", text, "--timeout", "5"]);
    },
    async focusPane(pane) {
      const { worktree, tab } = await home(pane);
      await supacode(["surface", "focus", "-w", worktree, "-t", tab, "-s", pane, "--timeout", "5"]);
    },
    async split({ from, direction, command }) {
      if (direction !== "right" && direction !== "down") {
        throw new Error("supacode only splits right and down");
      }
      await supacode([
        "surface",
        "split",
        "--surface",
        from.id,
        "--direction",
        direction === "right" ? "horizontal" : "vertical",
        "--input",
        shellQuote(command),
      ]);
    },
  };
};

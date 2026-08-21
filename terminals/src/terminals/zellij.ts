import type { Detect, Direction } from "../terminal";

interface ZellijPane {
  id: number;
  tab_id: number;
}

const NATIVE_DIRECTION: Record<Direction, "right" | "down"> = {
  right: "right",
  left: "right",
  down: "down",
  up: "down",
};

const OPPOSITE: Record<"right" | "down", "left" | "up"> = { right: "left", down: "up" };

export const zellij: Detect = (env, run) => {
  if (!env.ZELLIJ) return null;

  const zellij = (args: string[]) => run("zellij", args);

  async function panes(): Promise<ZellijPane[]> {
    return JSON.parse(await zellij(["action", "list-panes", "-j"])) as ZellijPane[];
  }

  async function currentTab(): Promise<string | null> {
    const selfId = Number(env.ZELLIJ_PANE_ID);
    const pane = (await panes()).find((candidate) => candidate.id === selfId);
    return pane ? String(pane.tab_id) : null;
  }

  return {
    name: "zellij",
    async getCurrentPane() {
      if (!env.ZELLIJ_PANE_ID) return null;
      const tab = await currentTab();
      return tab ? { id: env.ZELLIJ_PANE_ID, tab } : null;
    },
    async split({ from, direction, command }) {
      const native = NATIVE_DIRECTION[direction];
      try {
        await zellij(["action", "focus-pane-id", from.id]);
      } catch {
      }
      const output = await zellij(["action", "new-pane", "-d", native, "--", ...command]);
      const created = output.match(/terminal_\d+/)?.[0];
      if (!created) return;
      if (direction === "left" || direction === "up") {
        await zellij(["action", "move-pane", "-p", created, OPPOSITE[native]]);
      }
    },
  };
};

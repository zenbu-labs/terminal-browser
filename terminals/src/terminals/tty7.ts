import { bracketedPaste, paneById, shellQuote } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

interface Tty7Pane {
  pane: number;
  workspace?: string | null;
  tab?: string;
  title?: string;
  live?: boolean | null;
}

export const tty7: Detect = (env, run) => {
  if (!env.TTY7_PANE && env.TERM_PROGRAM !== "tty7") return null;

  const tty7 = (args: string[]) => run("tty7", args);
  const list = async (args: string[]) =>
    (JSON.parse(await tty7(args)) as { panes: Tty7Pane[] }).panes;

  const selfId = () => (env.TTY7_PANE ?? "").replace(/^%/, "") || null;

  async function panes(): Promise<Pane[]> {
    const [placed, running] = await Promise.all([
      list(["pane", "ls", "--json"]),
      list(["pane", "ls", "--all", "--json"]),
    ]);
    const live = new Set(running.map((pane) => pane.pane));
    return placed
      .filter((pane) => live.has(pane.pane))
      .map((pane) => ({
        id: String(pane.pane),
        tab: `${pane.workspace ?? ""}:${pane.tab ?? ""}`,
      }));
  }

  async function listPanes(): Promise<PaneDetails[]> {
    const [placed, running] = await Promise.all([
      list(["pane", "ls", "--json"]),
      list(["pane", "ls", "--all", "--json"]),
    ]);
    // tty7 reports the foreground process name as the pane title
    const commands = new Map(running.filter((pane) => pane.live).map((pane) => [pane.pane, pane.title]));
    return placed
      .filter((pane) => commands.has(pane.pane))
      .map((pane) => ({
        id: String(pane.pane),
        tab: `${pane.workspace ?? ""}:${pane.tab ?? ""}`,
        tty: null,
        command: commands.get(pane.pane) || null,
      }));
  }

  return {
    name: "tty7",
    getCurrentPane: () => paneById(panes, selfId()),
    listPanes,
    async sendText(pane, text) {
      await tty7(["send", `%${pane}`, bracketedPaste(text)]);
    },
    async split({ from, direction, command, size }) {
      if (direction !== "right" && direction !== "down") {
        throw new Error("tty7 only splits right and down");
      }
      const axis = direction === "right" ? "--horizontal" : "--vertical";
      const ratio = size ? ["--ratio", String(1 - size)] : [];
      const created = JSON.parse(
        await tty7(["split", `%${from.id}`, axis, ...ratio, "--json"]),
      ) as { pane: number };
      await tty7(["send", `%${created.pane}`, shellQuote(command), "--enter"]);
    },
  };
};

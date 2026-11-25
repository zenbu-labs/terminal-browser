import type { Detect, Direction, Pane, PaneDetails } from "../terminal";

interface HerdrAppLayout {
  spaces: {
    tabs: {
      id: string;
      terminals: { terminal: string; pane: string }[];
    }[];
  }[];
}

interface HcTerminal {
  pid?: number | null;
  status?: { app?: string | null } | null;
  foreground?: { name?: string | null; argv?: string[] } | null;
}

const SHELL = /^-?(sh|bash|zsh|fish|dash|ksh|tcsh|csh|nu|xonsh|elvish|pwsh|powershell)$/;

const NATIVE_DIRECTION: Record<Direction, "right" | "down"> = {
  right: "right",
  left: "right",
  down: "down",
  up: "down",
};

// The Herdr desktop app hosts each pane in libghostty, so its panes also say TERM_PROGRAM=ghostty
export const herdrApp: Detect = (env, run) => {
  if (!env.HC_TERMINAL_ID) return null;

  const app = async (command: string, args: Record<string, unknown>) =>
    JSON.parse((await run("herdr-app", ["do", command, JSON.stringify(args)])) || "null");
  const hc = (args: string[]) => run("hc", args);

  async function panes(): Promise<(Pane & { herdrPane: string })[]> {
    const layout = JSON.parse(await run("herdr-app", ["ls"])) as HerdrAppLayout;
    return layout.spaces.flatMap((space) =>
      space.tabs.flatMap((tab) =>
        tab.terminals.map((entry) => ({ id: entry.terminal, tab: tab.id, herdrPane: entry.pane })),
      ),
    );
  }

  async function herdrPaneOf(terminal: string): Promise<string> {
    const found = (await panes()).find((pane) => pane.id === terminal);
    if (!found) throw new Error(`terminal ${terminal} has no pane in the Herdr window`);
    return found.herdrPane;
  }

  const terminalInfo = async (terminal: string) => JSON.parse(await hc(["get", terminal, "--json"])) as HcTerminal;

  // Herdr knows which program in a pane is an agent, even one reached over ssh, so trust it over the local process
  const agentName = (info: HcTerminal) =>
    info.status?.app && !SHELL.test(info.foreground?.name ?? "") ? info.status.app : null;

  async function ttyOf(pid: number | null | undefined): Promise<string | null> {
    if (!pid) return null;
    const tty = (await run("ps", ["-o", "tty=", "-p", String(pid)])).trim();
    return tty && !tty.startsWith("?") ? `/dev/${tty}` : null;
  }

  async function listPanes(): Promise<PaneDetails[]> {
    return Promise.all(
      (await panes()).map(async ({ id, tab }) => {
        const info = await terminalInfo(id).catch((): HcTerminal => ({}));
        // "" rather than null: the browser would otherwise guess the program from whatever runs on the pane's tty
        const command = agentName(info) ?? info.foreground?.argv?.join(" ") ?? "";
        return { id, tab, tty: await ttyOf(info.pid).catch(() => null), command };
      }),
    );
  }

  return {
    name: "herdr-app",
    drawsGraphics: true,
    submitsSentText: true,
    async getCurrentPane() {
      const found = (await panes()).find((pane) => pane.id === env.HC_TERMINAL_ID);
      return found ? { id: found.id, tab: found.tab } : null;
    },
    listPanes,
    async sendText(pane, text) {
      const foreground = (await terminalInfo(pane)).foreground?.name ?? "";
      if (!foreground || SHELL.test(foreground)) throw new Error(`terminal ${pane} is at a shell prompt`);
      await hc(["send", pane, "--", text]);
    },
    async focusPane(pane) {
      await app("pane.focus", { terminal: pane });
    },
    async split({ from, direction, command, size }) {
      if (size) throw new Error("the Herdr desktop app cannot open a pane at a given --size; leave it out");
      const pane = await herdrPaneOf(from.id);
      const created = (await app("pane.split", { direction: NATIVE_DIRECTION[direction], pane, argv: command })) as {
        pane: string;
      };
      if (direction === "left" || direction === "up") await app("pane.swap", { pane: created.pane, target: pane });
    },
  };
};

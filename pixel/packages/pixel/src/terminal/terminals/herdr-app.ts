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
  status?: { app?: string | null; state?: string | null } | null;
  foreground?: { name?: string | null } | null;
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
  const agentName = (info: HcTerminal) => {
    const foreground = info.foreground?.name;
    return info.status?.app && foreground && !SHELL.test(foreground) ? info.status.app : null;
  };

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
        return { id, tab, tty: await ttyOf(info.pid).catch(() => null), command: agentName(info) ?? "" };
      }),
    );
  }

  return {
    name: "herdr-app",
    drawsGraphics: true,
    submitsSentText: true,
    async getCurrentPane() {
      // hc terminals started outside the app have HC_TERMINAL_ID too, but no window to be a pane in
      const found = (await panes().catch(() => [])).find((pane) => pane.id === env.HC_TERMINAL_ID);
      return found ? { id: found.id, tab: found.tab } : null;
    },
    listPanes,
    async sendText(pane, text) {
      const info = await terminalInfo(pane);
      if (!agentName(info)) throw new Error(`terminal ${pane} is not running a coding agent`);
      // Herdr checks the status again as it types, so an agent that quits in the meantime gets nothing
      const state = info.status?.state;
      const onlyIf = state === "idle" || state === "working" ? ["--if", state] : [];
      await hc(["send", pane, ...onlyIf, "--", text]);
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

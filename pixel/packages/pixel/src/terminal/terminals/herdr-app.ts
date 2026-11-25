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

  async function ttyOf(terminal: string): Promise<string | null> {
    const { pid } = await terminalInfo(terminal);
    if (!pid) return null;
    const tty = (await run("ps", ["-o", "tty=", "-p", String(pid)])).trim();
    return tty && !tty.startsWith("?") ? `/dev/${tty}` : null;
  }

  async function listPanes(): Promise<PaneDetails[]> {
    return Promise.all(
      (await panes()).map(async ({ id, tab }) => ({
        id,
        tab,
        tty: await ttyOf(id).catch(() => null),
        command: null,
      })),
    );
  }

  return {
    name: "herdr-app",
    drawsGraphics: true,
    async getCurrentPane() {
      const found = (await panes()).find((pane) => pane.id === env.HC_TERMINAL_ID);
      return found ? { id: found.id, tab: found.tab } : null;
    },
    listPanes,
    // hc can only paste text followed by Enter, so a shell would run the text as a command
    async sendText(pane, text) {
      const info = await terminalInfo(pane);
      if (!info.status?.app || SHELL.test(info.foreground?.name ?? "")) {
        throw new Error(`terminal ${pane} is not running a coding agent`);
      }
      await hc(["send", pane, "--", text]);
    },
    async focusPane(pane) {
      await app("pane.focus", { terminal: pane });
    },
    async split({ from, direction, command }) {
      const pane = await herdrPaneOf(from.id);
      const created = (await app("pane.split", { direction: NATIVE_DIRECTION[direction], pane, argv: command })) as {
        pane: string;
      };
      if (direction === "left" || direction === "up") await app("pane.swap", { pane: created.pane, target: pane });
    },
  };
};

import { execFileSync } from "node:child_process";

import { paneById, shellQuote } from "../shared";
import type { Detect, Pane, PaneDetails } from "../terminal";

const SPLIT_FLAG = { right: "-h", left: "-h", down: "-v", up: "-v" } as const;

export const tmux: Detect = (env, run) => {
  if (!env.TMUX) return null;

  const tmux = (args: string[]) => run("tmux", args);

  async function panes(): Promise<Pane[]> {
    const listing = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_title}",
    ]);
    const panes: Pane[] = [];
    for (const line of listing.split("\n")) {
      if (!line.trim()) continue;
      const [session, window, pane, ...title] = line.split("\t");
      panes.push({ id: pane, tab: `${session}:${window}` });
    }
    return panes;
  }

  async function listPanes(): Promise<PaneDetails[]> {
    const listing = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_tty}",
    ]);
    const panes: PaneDetails[] = [];
    for (const line of listing.split("\n")) {
      if (!line.trim()) continue;
      const [session, window, pane, tty] = line.split("\t");
      panes.push({ id: pane, tab: `${session}:${window}`, tty: tty || null, command: null });
    }
    return panes;
  }

  async function userClient(): Promise<string | null> {
    const listing = await tmux(["list-clients", "-F", "#{client_tty}\t#{client_flags}\t#{client_activity}"]);
    let best: { tty: string; focused: boolean; activity: number } | null = null;
    for (const line of listing.split("\n")) {
      if (!line.trim()) continue;
      const [tty, flags, activity] = line.split("\t");
      const client = { tty, focused: (flags ?? "").split(",").includes("focused"), activity: Number(activity) || 0 };
      if (!best || (client.focused && !best.focused) || (client.focused === best.focused && client.activity > best.activity)) {
        best = client;
      }
    }
    return best?.tty ?? null;
  }

  return {
    name: "tmux",
    wrapper: "tmux",
    prepare: () => prepareTmux(env),
    getCurrentPane: () => paneById(panes, env.TMUX_PANE),
    listPanes,
    async sendText(pane, text) {
      if (text === "") return;
      await run("tmux", ["load-buffer", "-b", "terminal-browser-send", "-"], text);
      await tmux(["paste-buffer", "-p", "-d", "-b", "terminal-browser-send", "-t", pane]);
    },
    async focusPane(pane) {
      const client = await userClient();
      if (client) {
        await tmux(["switch-client", "-c", client, "-t", pane]);
        return;
      }
      await tmux(["select-window", "-t", pane]);
      await tmux(["select-pane", "-t", pane]);
    },
    async split({ from, direction, command, size }) {
      const before = direction === "left" || direction === "up" ? ["-b"] : [];
      const length = size ? ["-l", `${Math.round(size * 100)}%`] : [];
      await tmux([
        "split-window",
        SPLIT_FLAG[direction],
        ...before,
        ...length,
        "-t",
        from.id,
        shellQuote(command),
      ]);
    },
  };
};

function prepareTmux(env: NodeJS.ProcessEnv): void {
  const tmux = (args: string[]): string | null => {
    try {
      return execFileSync("tmux", args, { env, encoding: "utf8", timeout: 5000 }).trim();
    } catch {
      return null;
    }
  };

  tmux(["set", "-p", "allow-passthrough", "on"]);
  tmux(["set", "-s", "focus-events", "on"]);
  tmux(["set", "-s", "extended-keys", "on"]);
  tmux(["set", "-s", "extended-keys-format", "csi-u"]);
  const termname = tmux(["display", "-p", "#{client_termname}"]);
  if (termname) tmux(["set", "-as", "terminal-features", `${termname}:extkeys`]);
}

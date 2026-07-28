import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { Backend, Pane, shellQuote } from "./shared";

const run = promisify(execFile);

const SPLIT_FLAG = { right: "-h", left: "-h", down: "-v", up: "-v" } as const;

export function createTmux(env: NodeJS.ProcessEnv = process.env): Backend {
  async function tmux(args: string[]): Promise<string> {
    const { stdout } = await run("tmux", args, {
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
    });
    return stdout;
  }

  const selfPane = () => env.TMUX_PANE ?? null;

  async function find(titleNeedle: string): Promise<Pane | null> {
    return (await backend.panes()).find((pane) => pane.title.includes(titleNeedle)) ?? null;
  }

  async function focus(paneId: string): Promise<void> {
    await tmux(["select-window", "-t", paneId]);
    await tmux(["select-pane", "-t", paneId]);
  }

  const backend: Backend = {
    app: "tmux",
    async panes() {
      const self = selfPane();
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
        panes.push({
          window: session,
          tab: window,
          pane,
          title: title.join("\t"),
          self: pane === self,
        });
      }
      return panes;
    },
    async split(direction, command, cwd, size) {
      const before = direction === "left" || direction === "up" ? ["-b"] : [];
      const length = size ? ["-l", `${Math.round(size * 100)}%`] : [];
      const target = selfPane();
      await tmux([
        "split-window",
        SPLIT_FLAG[direction],
        ...before,
        ...length,
        "-c",
        cwd,
        ...(target ? ["-t", target] : []),
        shellQuote(command),
      ]);
    },
    async listAll() {
      return backend.panes();
    },
    async sendText(paneId, text) {
      await tmux(["send-keys", "-t", paneId, "-l", text]);
      await focus(paneId);
      return true;
    },
    async focusPane(titleNeedle) {
      const target = await find(titleNeedle);
      if (!target) return false;
      await focus(target.pane);
      return true;
    },
    async focusSelf() {
      const self = selfPane();
      if (!self) return false;
      await focus(self);
      return true;
    },
    async closePane(titleNeedle) {
      const target = await find(titleNeedle);
      if (!target) return false;
      await tmux(["kill-pane", "-t", target.pane]);
      return true;
    },
    async zoomPane(titleNeedle) {
      const target = await find(titleNeedle);
      if (!target) return false;
      await tmux(["resize-pane", "-Z", "-t", target.pane]);
      return true;
    },
  };
  return backend;
}

export function prepareTmux(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.TMUX) return;
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

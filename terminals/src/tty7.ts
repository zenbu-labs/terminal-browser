import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Backend, Pane, shellQuote } from "./shared";

const run = promisify(execFile);

interface Tty7Pane {
  pane: number;
  workspace: string | null;
  tab?: string;
  title?: string;
}

interface Tty7PaneList {
  panes: Tty7Pane[];
}

export function createTty7(env: NodeJS.ProcessEnv = process.env): Backend {
  async function tty7(args: string[]): Promise<string> {
    const { stdout } = await run("tty7", args, {
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
    });
    return stdout;
  }

  async function paneLists(): Promise<{
    attached: Tty7Pane[];
    running: Tty7Pane[];
  }> {
    const [attached, running] = await Promise.all([
      tty7(["pane", "ls", "--json"]),
      tty7(["pane", "ls", "--all", "--json"]),
    ]);
    return {
      attached: (JSON.parse(attached) as Tty7PaneList).panes,
      running: (JSON.parse(running) as Tty7PaneList).panes,
    };
  }

  const selfPane = () => {
    const pane = Number((env.TTY7_PANE ?? "").replace(/^%/, ""));
    return Number.isInteger(pane) ? pane : null;
  };

  const backend: Backend = {
    app: "tty7",
    async panes() {
      const self = selfPane();
      const { attached, running } = await paneLists();
      const liveByLocation = new Map(
        running.map((pane) => [`${pane.workspace}:${pane.pane}`, pane]),
      );
      return attached
        .filter((pane) => liveByLocation.has(`${pane.workspace}:${pane.pane}`))
        .map((pane): Pane => ({
          window: pane.workspace ?? "",
          tab: pane.tab ?? "",
          pane: String(pane.pane),
          title: liveByLocation.get(`${pane.workspace}:${pane.pane}`)?.title ?? "",
          self: pane.pane === self,
        }));
    },
    async listAll() {
      const self = selfPane();
      const { attached, running } = await paneLists();
      const locationByPane = new Map(
        attached.map((pane) => [`${pane.workspace}:${pane.pane}`, pane]),
      );
      return running.map((pane) => {
        const location = locationByPane.get(`${pane.workspace}:${pane.pane}`);
        return {
          window: location?.workspace ?? "",
          tab: location?.tab ?? "",
          pane: String(pane.pane),
          title: pane.title ?? "",
          self: pane.pane === self,
        };
      });
    },
    async split(direction, command, size) {
      if (direction === "left" || direction === "up") {
        throw new Error(
          `tty7 cannot place a CLI-created split ${direction}; use --split right or --split down`,
        );
      }
      const target = selfPane();
      if (target === null) {
        throw new Error("TTY7_PANE is not set — run terminal-browser inside a tty7 pane");
      }
      const axis = direction === "right" ? "--horizontal" : "--vertical";
      const ratio = size ? ["--ratio", String(1 - size)] : [];
      const output = await tty7(["split", `%${target}`, axis, ...ratio, "--json"]);
      const created = (JSON.parse(output) as { pane: number }).pane;
      await tty7(["send", `%${created}`, shellQuote(command), "--enter"]);
    },
    async sendText(paneId, text) {
      await tty7(["send", `%${paneId}`, text]);
      return true;
    },
    async focusPane() {
      return false;
    },
    async focusSelf() {
      return false;
    },
    async closePane() {
      const target = selfPane();
      if (target === null) return false;
      await tty7(["pane", "close", `%${target}`]);
      await tty7(["pane", "close", `%${target}`]).catch(() => "");
      return true;
    },
  };
  return backend;
}

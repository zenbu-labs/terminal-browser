import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "../shared";
import type { Detect, Direction } from "../terminal";

interface HerdrPaneSplitResult {
  result: { pane: { pane_id: string } };
}

interface HerdrWorkspaceList {
  result: { workspaces: { workspace_id: string; focused: boolean }[] };
}

interface HerdrPaneList {
  result: { panes: { pane_id: string; workspace_id: string }[] };
}

function herdrConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  if (process.platform === "win32") {
    return path.join(env.APPDATA ?? path.join(env.HOME ?? os.homedir(), "AppData", "Roaming"), "herdr", "config.toml");
  }
  return path.join(env.HOME ?? os.homedir(), ".config", "herdr", "config.toml");
}

function enableKittyGraphics(config: string): string {
  const flag = /^([ \t]*kitty_graphics[ \t]*=[ \t]*)false([ \t]*)$/m;
  if (flag.test(config)) return config.replace(flag, "$1true$2");
  const header = /^\[experimental\][ \t]*$/m;
  if (header.test(config)) return config.replace(header, "[experimental]\nkitty_graphics = true");
  const trimmed = config.replace(/\s+$/, "");
  return `${trimmed}${trimmed ? "\n\n" : ""}[experimental]\nkitty_graphics = true\n`;
}

const NATIVE_DIRECTION: Record<Direction, "right" | "down"> = {
  right: "right",
  left: "right",
  down: "down",
  up: "down",
};

const OPPOSITE: Record<"right" | "down", "left" | "up"> = { right: "left", down: "up" };

export const herdr: Detect = (env, run) => {
  if (!env.HERDR_PANE_ID) return null;

  const bin = env.HERDR_BIN_PATH || "herdr";
  const herdr = (args: string[]) => run(bin, args);

  async function splitPane(args: string[]): Promise<HerdrPaneSplitResult> {
    try {
      return JSON.parse(await herdr(["pane", "split", ...args, "--right-click", "pane"]));
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
      if (!stderr.includes("--right-click")) throw error;
      return JSON.parse(await herdr(["pane", "split", ...args]));
    }
  }

  /** The workspace a pane lives in. The calling pane's is already in the environment, so asking costs nothing. */
  async function paneWorkspace(paneId: string): Promise<string | null> {
    if (paneId === env.HERDR_PANE_ID && env.HERDR_WORKSPACE_ID) return env.HERDR_WORKSPACE_ID;
    const { result }: HerdrPaneList = JSON.parse(await herdr(["pane", "list"]));
    return result.panes.find((pane) => pane.pane_id === paneId)?.workspace_id ?? null;
  }

  /**
   * A new pane only earns focus when the split happens in the space the person is already looking at.
   * Splitting from a pane in another workspace — an agent, or a background job — used to yank them out
   * of whatever they were doing, so those splits are created unfocused. When herdr will not say which
   * workspace is focused we also stay put: failing to focus is an inconvenience, stealing focus is the bug.
   */
  async function focusFlag(fromPaneId: string): Promise<"--focus" | "--no-focus"> {
    try {
      const { result }: HerdrWorkspaceList = JSON.parse(await herdr(["workspace", "list"]));
      const focused = result.workspaces.find((workspace) => workspace.focused)?.workspace_id;
      const from = await paneWorkspace(fromPaneId);
      return from !== null && from === focused ? "--focus" : "--no-focus";
    } catch {
      return "--no-focus";
    }
  }

  async function prepare(): Promise<void> {
    try {
      const configPath = herdrConfigPath(env);
      const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
      if (/^[ \t]*kitty_graphics[ \t]*=[ \t]*true[ \t]*$/m.test(current)) return;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, enableKittyGraphics(current));
      await herdr(["server", "reload-config"]);
    } catch {
    }
  }

  return {
    name: "herdr",
    prepare,
    getCurrentPane: async () => ({ id: env.HERDR_PANE_ID!, tab: env.HERDR_TAB_ID! }),
    async split({ from, direction, command, size }) {
      const native = NATIVE_DIRECTION[direction];
      const ratio = size ? ["--ratio", String(size)] : [];
      const focus = await focusFlag(from.id);
      const { result } = await splitPane(["--pane", from.id, "--direction", native, focus, ...ratio]);
      const newPaneId = result.pane.pane_id;
      if (direction === "left" || direction === "up") {
        await herdr(["pane", "swap", "--pane", newPaneId, "--direction", OPPOSITE[native]]);
      }
      await herdr(["pane", "run", newPaneId, shellQuote(command)]);
    },
  };
};

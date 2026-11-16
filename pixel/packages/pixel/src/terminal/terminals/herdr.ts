import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { bracketedPaste, PASTE_KEY, shellQuote } from "../shared";
import type { Detect, Direction, PaneDetails } from "../terminal";

interface HerdrPaneSplitResult {
  result: { pane: { pane_id: string } };
}

interface HerdrPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}

interface HerdrProcessInfo {
  shell_pid?: number;
  foreground_processes?: { cmdline?: string }[];
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
  if (!env.HERDR_PANE_ID && env.HERDR_ENV !== "1") return null;

  const bin = env.HERDR_BIN_PATH || "herdr";
  const herdr = (args: string[]) => run(bin, args);

  async function resolvePane(id: string | undefined = env.HERDR_PANE_ID): Promise<HerdrPane> {
    try {
      if (!id?.trim()) throw new Error("HERDR_PANE_ID is missing or empty");
      const reply = JSON.parse(await herdr(["pane", "current", "--pane", id]));
      if (reply.error) throw new Error(reply.error.message ?? "Herdr caller lookup failed");
      const pane = reply.result?.pane;
      if (![pane?.pane_id, pane?.tab_id, pane?.workspace_id].every(
        (value) => typeof value === "string" && value.trim().length > 0,
      )) throw new Error("Herdr returned an incomplete pane context");
      return pane;
    } catch (cause) {
      throw new Error(
        `Could not resolve the Herdr pane ${id?.trim() ? id : "(missing HERDR_PANE_ID)"}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Run `herdr pane current --current` from the calling Herdr pane and check HERDR_SOCKET_PATH; " +
        "launch terminal-browser from a live Herdr shell if the inherited context no longer resolves.",
        { cause },
      );
    }
  }

  async function splitPane(args: string[]): Promise<HerdrPaneSplitResult> {
    return JSON.parse(await herdr(["pane", "split", ...args, "--right-click", "pane"]));
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

  async function listPanes(): Promise<PaneDetails[]> {
    const current = await resolvePane();
    const { result } = JSON.parse(await herdr(["pane", "list"])) as {
      result: { panes: HerdrPane[] };
    };
    const visible = result.panes.filter(
      pane => pane.workspace_id === current.workspace_id,
    );
    const processes = await Promise.all(
      visible.map((pane) =>
        herdr(["pane", "process-info", "--pane", pane.pane_id])
          .then((out) => (JSON.parse(out) as { result: { process_info: HerdrProcessInfo } }).result.process_info)
          .catch((): HerdrProcessInfo => ({})),
      ),
    );
    const ttyByPid = await shellTtys(processes.map((info) => info.shell_pid).filter((pid): pid is number => pid != null));
    return visible.map((pane, i) => ({
      id: pane.pane_id,
      tab: pane.tab_id,
      tty: processes[i].shell_pid != null ? ttyByPid.get(processes[i].shell_pid!) ?? null : null,
      command:
        (processes[i].foreground_processes ?? []).map((process) => process.cmdline ?? "").join("\n") || null,
    }));
  }

  async function shellTtys(pids: number[]): Promise<Map<number, string>> {
    const byPid = new Map<number, string>();
    if (pids.length === 0) return byPid;
    const listing = await run("ps", ["-o", "pid=,tty=", "-p", pids.join(",")]).catch(() => "");
    for (const line of listing.split("\n")) {
      const [pid, tty] = line.trim().split(/\s+/);
      if (pid && tty && tty !== "??") byPid.set(Number(pid), `/dev/${tty}`);
    }
    return byPid;
  }

  function socketCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socketPath =
      env.HERDR_SOCKET_PATH ?? path.join(env.HOME ?? os.homedir(), ".config", "herdr", "herdr.sock");
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      let buffer = "";
      socket.setTimeout(5000, () => socket.destroy(new Error("herdr socket timed out")));
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const line = buffer.indexOf("\n");
        if (line < 0) return;
        socket.end();
        const reply = JSON.parse(buffer.slice(0, line)) as { error?: { message?: string }; result?: unknown };
        if (reply.error) reject(new Error(reply.error.message ?? "herdr socket call failed"));
        else resolve(reply.result);
      });
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: "pixel", method, params })}\n`);
      });
    });
  }

  async function focusPane(pane: string): Promise<void> {
    const current = await resolvePane();
    const { result } = JSON.parse(await herdr(["pane", "get", pane])) as { result: { pane: HerdrPane } };
    if (result.pane.tab_id !== current.tab_id) await herdr(["tab", "focus", result.pane.tab_id]);
    await socketCall("pane.focus", { pane_id: result.pane.pane_id });
  }

  return {
    name: "herdr",
    prepare,
    async getCurrentPane() {
      const pane = await resolvePane();
      return { id: pane.pane_id, tab: pane.tab_id };
    },
    listPanes,
    async neighbor(from, direction) {
      const { result } = JSON.parse(await herdr(["pane", "neighbor", "--pane", from.id, "--direction", direction])) as {
        result: { neighbor: { neighbor_pane_id: string | null; layout: { tab_id: string } } };
      };
      const id = result.neighbor.neighbor_pane_id;
      return id ? { id, tab: result.neighbor.layout.tab_id } : null;
    },
    async sendText(pane, text) {
      await herdr(["pane", "send-text", pane, bracketedPaste(text)]);
    },
    async pasteKey(pane) {
      await herdr(["pane", "send-text", pane, PASTE_KEY]);
    },
    focusPane,
    async split({ from, direction, command, size }) {
      const source = await resolvePane(from.id);
      const native = NATIVE_DIRECTION[direction];
      const ratio = size ? ["--ratio", String(size)] : [];
      const { result } = await splitPane(["--pane", source.pane_id, "--direction", native, "--focus", ...ratio]);
      const newPaneId = result.pane.pane_id;
      if (direction === "left" || direction === "up") {
        await herdr(["pane", "swap", "--pane", newPaneId, "--direction", OPPOSITE[native]]);
      }
      await herdr(["pane", "run", newPaneId, shellQuote(command)]);
    },
  };
};

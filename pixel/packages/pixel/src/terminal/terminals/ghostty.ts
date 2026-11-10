import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appleScript } from "../applescript";
import { GHOSTTY_SCRIPT } from "./ghostty-script";
import { panePixels } from "../graphics";
import { setPaneWorkingDirectory, shellQuote, sleep } from "../shared";
import type { Detect, Direction, ListPanesOptions, Pane, PaneContext, PaneDetails } from "../terminal";


const DIRECTION_CODES: Record<Direction, string> = {
  right: "GSrt",
  left: "GSlf",
  down: "GSdn",
  up: "GSup",
};

const GHOSTTY_BINARY = /\.app\/Contents\/MacOS\/ghostty(\s|$)/;

interface Process {
  parent: number;
  tty: string;
  command: string;
}

function ghosttyAbove(start: number, processes: Map<number, Process>): number | null {
  for (let pid = start, hops = 0; hops < 64 && processes.has(pid); hops++) {
    const { parent, command } = processes.get(pid)!;
    if (GHOSTTY_BINARY.test(command)) return pid;
    pid = parent;
  }
  return null;
}

function markerDirectory(): string {
  const name = `pixel-pane-${process.pid}-`;
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), name));
  } catch {
    return path.join(os.tmpdir(), name + Math.floor(Math.random() * 1e9));
  }
}

export const ghostty: Detect = (env, run) => {
  const looksLikeGhostty =
    (env.TERM ?? "").includes("ghostty") ||
    env.TERM_PROGRAM === "ghostty" ||
    Boolean(env.GHOSTTY_RESOURCES_DIR);
  if (!looksLikeGhostty) return null;

  if (process.platform !== "darwin") {
    return {
      name: "ghostty",
      async split() {
        throw new Error(
          "--split is not supported inside ghostty on this platform",
        );
      },
    };
  }

  const tooOld =
    (env.TERM_PROGRAM_VERSION?.localeCompare("1.3.0", undefined, { numeric: true }) ?? 0) < 0;
  if (tooOld) {
    return {
      name: "ghostty",
      async split() {
        throw new Error(
          `Ghostty ${env.TERM_PROGRAM_VERSION} does not support automation: upgrade to Ghostty 1.3.0 or newer.`,
        );
      },
    };
  }

  const osascript = appleScript("Ghostty", run, "JavaScript");
  const directories = new Map<string, string>();

  let owner: Promise<number> | null = null;
  function ownerPid(tty: string | null): Promise<number> {
    owner ??= findOwner(tty).catch((error) => {
      owner = null;
      throw error;
    });
    return owner;
  }

  async function ghosttyAncestor(): Promise<number | null> {
    for (let pid = process.pid, hops = 0; pid > 1 && hops < 64; hops++) {
      const line = await run("ps", ["-o", "pid=,ppid=,command=", "-p", String(pid)]).catch(() => "");
      const parts = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!parts) return null;
      if (GHOSTTY_BINARY.test(parts[3])) return pid;
      pid = Number(parts[2]);
    }
    return null;
  }

  async function findOwner(tty: string | null): Promise<number> {
    const ancestor = await ghosttyAncestor();
    if (ancestor !== null) return ancestor;
    const processes = new Map<number, Process>();
    for (const line of (await run("ps", ["-axo", "pid=,ppid=,tty=,command="])).split("\n")) {
      const parts = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (parts) processes.set(Number(parts[1]), { parent: Number(parts[2]), tty: parts[3], command: parts[4] });
    }
    const above = ghosttyAbove(process.pid, processes);
    if (above !== null) return above;
    if (tty) {
      for (const [pid, { tty: owned }] of processes) {
        if (`/dev/${owned}` !== tty) continue;
        const found = ghosttyAbove(pid, processes);
        if (found !== null) return found;
      }
    }
    const running = [...processes].filter(([, { command }]) => GHOSTTY_BINARY.test(command)).map(([pid]) => pid);
    if (running.length === 1) return running[0];
    if (running.length === 0) {
      throw new Error("Ghostty is not running, so there is no window to script");
    }
    throw new Error(
      `${running.length} Ghostty processes are running (pids ${running.join(", ")}) and this shell is not inside any of them, so we cannot tell which one to script`,
    );
  }

  async function ghosttyCommand(command: string, args: string[], tty: string | null = null): Promise<string> {
    return osascript(GHOSTTY_SCRIPT, [String(await ownerPid(tty)), command, ...args]);
  }

  let scale: number | null = null;
  async function backingScale(): Promise<number> {
    if (scale !== null) return scale;
    const read = await run("osascript", [
      "-l",
      "JavaScript",
      "-e",
      "ObjC.import('AppKit'); $.NSScreen.mainScreen.backingScaleFactor",
    ]).catch(() => "");
    const found = Number(read.trim());
    scale = Number.isFinite(found) && found > 0 ? found : 2;
    return scale;
  }

  async function listPanes(tty: string | null = null): Promise<PaneDetails[]> {
    const listed: PaneDetails[] = [];
    const pids = new Map<string, string>();
    directories.clear();
    for (const line of (await ghosttyCommand("list", [], tty)).split("\n")) {
      if (!line.trim()) continue;
      const [window, tab, pane, pid, paneTty, ...directory] = line.split("\t");
      directories.set(pane, directory.join("\t"));
      if (pid && !paneTty) pids.set(pane, pid);
      listed.push({ id: pane, tab: `${window}:${tab}`, tty: paneTty || null, command: null });
    }
    if (pids.size > 0) {
      const byPid = new Map<string, string>();
      const listing = await run("ps", ["-o", "pid=,tty=", "-p", [...pids.values()].join(",")]).catch(
        () => "",
      );
      for (const line of listing.split("\n")) {
        const [pid, paneTty] = line.trim().split(/\s+/);
        if (pid && paneTty && paneTty !== "??") byPid.set(pid, `/dev/${paneTty}`);
      }
      for (const pane of listed) {
        const pid = pids.get(pane.id);
        if (pid) pane.tty = byPid.get(pid) ?? null;
      }
    }
    return listed;
  }

  const paneByTty = new Map<string, string>();
  const missedAt = new Map<string, number>();
  const MISS_MEMORY_MS = 60_000;

  async function cwdByPane(): Promise<Map<string, string>> {
    const cwds = new Map<string, string>();
    for (const line of (await ghosttyCommand("list", [])).split("\n")) {
      if (!line.trim()) continue;
      const [, , pane, , , ...directory] = line.split("\t");
      cwds.set(pane, directory.join("\t"));
    }
    return cwds;
  }

  async function processCwd(pid: string): Promise<string> {
    const listing = await run("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pid]).catch(() => "");
    const found = listing.split("\n").find((line) => line.startsWith("n/"));
    return found ? found.slice(1) : os.homedir();
  }

  async function mapTtys(
    ttys: string[],
    listed: Pane[],
    cwdOf: (tty: string) => Promise<string>,
  ): Promise<void> {
    const alive = new Set(listed.map((pane) => pane.id));
    const pending = ttys.filter((tty) => {
      const known = paneByTty.get(tty);
      if (known && alive.has(known)) return false;
      return Date.now() - (missedAt.get(tty) ?? 0) > MISS_MEMORY_MS;
    });
    if (pending.length === 0) return;
    const markers = new Map<string, string>();
    for (const tty of pending) {
      const marker = markerDirectory();
      try {
        setPaneWorkingDirectory(tty, marker);
        markers.set(tty, marker);
      } catch {
        missedAt.set(tty, Date.now());
        fs.rmSync(marker, { recursive: true, force: true });
      }
    }
    const mapped = new Map<string, string>();
    try {
      // Ghostty applies OSC 7 as soon as it reads it, so one listing normally sees every
      // marker; a second look only happens when the first saw none at all
      for (let attempt = 0; attempt < 2 && mapped.size === 0 && markers.size > 0; attempt++) {
        if (attempt > 0) await sleep(120);
        for (const [pane, cwd] of await cwdByPane()) {
          for (const [tty, marker] of markers) {
            if (cwd === marker && alive.has(pane)) mapped.set(tty, pane);
          }
        }
      }
    } finally {
      for (const [tty, marker] of markers) {
        const pane = mapped.get(tty);
        let restore = os.homedir();
        if (pane) {
          paneByTty.set(tty, pane);
          restore = directories.get(pane) ?? restore;
        } else {
          missedAt.set(tty, Date.now());
          restore = await cwdOf(tty).catch(() => restore);
        }
        try {
          setPaneWorkingDirectory(tty, restore);
        } catch {}
        fs.rmSync(marker, { recursive: true, force: true });
      }
    }
  }

  interface Running {
    pid: string;
    command: string;
  }

  async function ttysRunning(match: (command: string) => boolean): Promise<Map<string, Running>> {
    const byTty = new Map<string, Running[]>();
    const listing = await run("ps", ["-e", "-o", "pid=,tty=,args="]).catch(() => "");
    for (const line of listing.split("\n")) {
      const parts = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!parts || parts[2].startsWith("?")) continue;
      const tty = `/dev/${parts[2]}`;
      byTty.set(tty, [...(byTty.get(tty) ?? []), { pid: parts[1], command: parts[3] }]);
    }
    const matched = new Map<string, Running>();
    for (const [tty, processes] of byTty) {
      const command = processes.map((running) => running.command).join("\n");
      if (match(command)) matched.set(tty, { pid: processes[processes.length - 1].pid, command });
    }
    return matched;
  }

  async function listPanesMatching(options?: ListPanesOptions): Promise<PaneDetails[]> {
    const listed = await listPanes(options?.tty ?? null);
    if (!options?.commands || listed.some((pane) => pane.tty)) return listed;
    const running = await ttysRunning(options.commands);
    await mapTtys([...running.keys()], listed, (tty) => processCwd(running.get(tty)!.pid));
    for (const [tty, { command }] of running) {
      const pane = listed.find((candidate) => candidate.id === paneByTty.get(tty));
      if (!pane) continue;
      pane.tty = tty;
      pane.command = command;
    }
    return listed;
  }

  async function getCurrentPane({ tty, cwd }: PaneContext): Promise<Pane | null> {
    if (!tty) return null;
    const before = await listPanes(tty);
    const byTty = before.find((pane) => pane.tty === tty);
    if (byTty) return byTty;
    missedAt.delete(tty);
    await mapTtys([tty], before, async () => cwd);
    const id = paneByTty.get(tty);
    const found = id ? before.find((pane) => pane.id === id) : null;
    if (!found) {
      throw new Error(
        `could not find this pane in Ghostty — we marked ${tty} and no Ghostty pane reported it back, so ${tty} is not a Ghostty pane (a shell inside tmux or a remote session looks like this)`,
      );
    }
    return found;
  }

  async function sizeSplit(pane: string, direction: Direction, size: number) {
    const pixels = await panePixels();
    if (!pixels) return;
    const sideways = direction === "right" || direction === "left";
    const whole = sideways ? pixels.width : pixels.height;
    const points = ((size - 0.5) * whole) / (await backingScale());
    const amount = Math.round(Math.abs(points));
    if (amount < 3) return;
    const away: Record<Direction, Direction> = {
      right: "left",
      left: "right",
      down: "up",
      up: "down",
    };
    const grow = points >= 0 ? away[direction] : direction;
    await ghosttyCommand("action", [pane, `resize_split:${grow},${amount}`]);
  }

  return {
    name: "ghostty",
    getCurrentPane,
    listPanes: listPanesMatching,
    async sendText(pane, text) {
      const result = await ghosttyCommand("input", [pane, text]);
      if (result !== "ok") throw new Error(`Ghostty could not type into pane ${pane}`);
    },
    async pasteKey(pane) {
      await ghosttyCommand("action", [pane, "text:\\x16"]);
    },
    async neighbor(from, direction) {
      const [window, tab] = from.tab.split(":");
      const result = (await ghosttyCommand("neighbor", [window, tab, from.id, direction])).trim();
      return result && result !== "not-found" ? { id: result, tab: from.tab } : null;
    },
    async focusPane(pane) {
      const result = await ghosttyCommand("focus", [pane]);
      if (result !== "ok") throw new Error(`Ghostty could not focus pane ${pane}`);
    },
    async split({ from, direction, command, size }) {
      const startDir = directories.get(from.id) ?? process.cwd();
      // Ghostty execs the command from login, and Electron logs a code-signing
      // error when its parent is login; a shell in between keeps the pane quiet
      const wrapped = shellQuote(["/bin/sh", "-c", `${shellQuote(command)}; exit $?`]);
      const opened = await ghosttyCommand("split", [from.id, DIRECTION_CODES[direction], startDir, wrapped]);
      if (!opened || opened === "not-found") {
        throw new Error("this pane went away before we could split it");
      }
      if (size !== null) await sizeSplit(opened, direction, size);
    },
  };
};

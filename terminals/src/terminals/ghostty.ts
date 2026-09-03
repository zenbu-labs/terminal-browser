import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codingAgent } from "../agents";
import { appleScript } from "../applescript";
import { panePixels } from "../graphics";
import { setPaneWorkingDirectory, shellQuote, sleep } from "../shared";
import type { Detect, Direction, Pane, PaneContext, PaneDetails } from "../terminal";

// one line per split: window, tab, terminal, pid, tty, cwd. Plural specifiers fetch a whole
// tab in one Apple Event; pid/tty only exist on Ghostty newer than 1.3.1 and stay empty here
const LIST_SCRIPT = `
on run argv
  set out to ""
  set sep to tab
  tell application "Ghostty"
    repeat with w in windows
      try
        set wid to id of w
        repeat with tb in tabs of w
          try
            set tid to id of tb
            set ids to id of every terminal of tb
            set cwds to working directory of every terminal of tb
            set pids to {}
            set ttys to {}
            try
              set pids to pid of every terminal of tb
              set ttys to tty of every terminal of tb
            end try
            repeat with i from 1 to count of ids
              set pd to ""
              set ty to ""
              try
                set pd to (item i of pids) as text
                set ty to item i of ttys
              end try
              set out to out & wid & sep & tid & sep & (item i of ids) & sep & pd & sep & ty & sep & (item i of cwds) & linefeed
            end repeat
          end try
        end repeat
      end try
    end repeat
  end tell
  return out
end run
`;

function onPane(body: string, prelude = ""): string {
  return `
on run argv
  set targetId to item 1 of argv
  ${prelude}
  tell application "Ghostty"
    set windowList to windows
    repeat with w in windowList
      try
        set tabList to tabs of w
        repeat with tb in tabList
          try
            set termList to terminals of tb
            repeat with term in termList
              try
                if (id of term) as text is targetId then
${body}
                end if
              end try
            end repeat
          end try
        end repeat
      end try
    end repeat
  end tell
  return "not-found"
end run
`;
}

const splitScript = (direction: Direction) =>
  onPane(`            set opened to split term direction ${direction} with configuration {initial working directory:(item 3 of argv), initial input:(item 2 of argv) & linefeed}
            return (id of opened) as text`);

const byId = (body: string) => `
on run argv
  tell application "Ghostty"
    set term to terminal id (item 1 of argv)
${body}
  end tell
  return "ok"
end run
`;

const SEND_TEXT_SCRIPT = byId("    input text (item 2 of argv) to term");
const FOCUS_SCRIPT = byId("    focus term");

const RESIZE_SCRIPT = onPane(`            set r to perform action (item 2 of argv) on term
            return r as text`);


function markerDirectory(): string {
  const name = `terminal-browser-pane-${process.pid}-`;
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

  const osascript = appleScript("Ghostty", run);
  const directories = new Map<string, string>();

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

  async function listPanes(): Promise<PaneDetails[]> {
    const listed: PaneDetails[] = [];
    const pids = new Map<string, string>();
    directories.clear();
    for (const line of (await osascript(LIST_SCRIPT, [])).split("\n")) {
      if (!line.trim()) continue;
      const [window, tab, pane, pid, tty, ...directory] = line.split("\t");
      directories.set(pane, directory.join("\t"));
      if (pid && !tty) pids.set(pane, pid);
      listed.push({ id: pane, tab: `${window}:${tab}`, tty: tty || null, command: null });
    }
    if (pids.size > 0) {
      const byPid = new Map<string, string>();
      const listing = await run("ps", ["-o", "pid=,tty=", "-p", [...pids.values()].join(",")]).catch(
        () => "",
      );
      for (const line of listing.split("\n")) {
        const [pid, tty] = line.trim().split(/\s+/);
        if (pid && tty && tty !== "??") byPid.set(pid, `/dev/${tty}`);
      }
      for (const pane of listed) {
        const pid = pids.get(pane.id);
        if (pid) pane.tty = byPid.get(pid) ?? null;
      }
    }
    return listed;
  }

  const panes = (): Promise<Pane[]> => listPanes();

  const paneByTty = new Map<string, string>();
  const missedAt = new Map<string, number>();
  const MISS_MEMORY_MS = 60_000;

  async function cwdByPane(): Promise<Map<string, string>> {
    const cwds = new Map<string, string>();
    for (const line of (await osascript(LIST_SCRIPT, [])).split("\n")) {
      if (!line.trim()) continue;
      const [, , pane, , , ...directory] = line.split("\t");
      cwds.set(pane, directory.join("\t"));
    }
    return cwds;
  }

  async function mapTtys(ttys: string[], listed: Pane[]): Promise<void> {
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
        if (pane) {
          paneByTty.set(tty, pane);
          try {
            setPaneWorkingDirectory(tty, directories.get(pane) ?? os.homedir());
          } catch {}
        } else {
          missedAt.set(tty, Date.now());
        }
        fs.rmSync(marker, { recursive: true, force: true });
      }
    }
  }

  async function agentTtys(): Promise<Map<string, string>> {
    const byTty = new Map<string, string[]>();
    const listing = await run("ps", ["-e", "-o", "tty=,args="]).catch(() => "");
    for (const line of listing.split("\n")) {
      const parts = line.trim().match(/^(\S+)\s+(.*)$/);
      if (!parts || parts[1].startsWith("?")) continue;
      const tty = `/dev/${parts[1]}`;
      byTty.set(tty, [...(byTty.get(tty) ?? []), parts[2]]);
    }
    const agents = new Map<string, string>();
    for (const [tty, commands] of byTty) {
      const command = commands.join("\n");
      if (codingAgent(command)) agents.set(tty, command);
    }
    return agents;
  }

  async function listPanesWithAgents(): Promise<PaneDetails[]> {
    const [listed, agents] = await Promise.all([listPanes(), agentTtys()]);
    if (listed.some((pane) => pane.tty)) return listed;
    await mapTtys([...agents.keys()], listed);
    for (const [tty, command] of agents) {
      const pane = listed.find((candidate) => candidate.id === paneByTty.get(tty));
      if (!pane) continue;
      pane.tty = tty;
      pane.command = command;
    }
    return listed;
  }

  async function getCurrentPane({ tty }: PaneContext): Promise<Pane | null> {
    if (!tty) return null;
    const before = await listPanes();
    const byTty = before.find((pane) => pane.tty === tty);
    if (byTty) return byTty;
    missedAt.delete(tty);
    await mapTtys([tty], before);
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
    await osascript(RESIZE_SCRIPT, [pane, `resize_split:${grow},${amount}`]);
  }

  return {
    name: "ghostty",
    getCurrentPane,
    listPanes: listPanesWithAgents,
    async sendText(pane, text) {
      const result = await osascript(SEND_TEXT_SCRIPT, [pane, text]);
      if (result !== "ok") throw new Error(`Ghostty could not type into pane ${pane}`);
    },
    async focusPane(pane) {
      const result = await osascript(FOCUS_SCRIPT, [pane]);
      if (result !== "ok") throw new Error(`Ghostty could not focus pane ${pane}`);
    },
    async split({ from, direction, command, size }) {
      const startDir = directories.get(from.id) ?? process.cwd();
      const opened = await osascript(splitScript(direction), [
        from.id,
        shellQuote(command),
        startDir,
      ]);
      if (!opened || opened === "not-found") {
        throw new Error("this pane went away before we could split it");
      }
      if (size !== null) await sizeSplit(opened, direction, size);
    },
  };
};

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appleScript } from "../applescript";
import { panePixels } from "../graphics";
import { setPaneWorkingDirectory, shellQuote, sleep } from "../shared";
import type { Detect, Direction, Pane, PaneContext } from "../terminal";

const LIST_SCRIPT = `
on run argv
  set out to ""
  set sep to tab
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
                set out to out & (id of w) & sep & (id of tb) & sep & (id of term) & sep & (working directory of term) & sep & (name of term) & linefeed
              end try
            end repeat
          end try
        end repeat
      end try
    end repeat
  end tell
  return out
end run
`;

const FIND_BY_DIRECTORY_SCRIPT = `
on run argv
  set wanted to item 1 of argv
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
                if (working directory of term) is wanted then return (id of term) as text
              end try
            end repeat
          end try
        end repeat
      end try
    end repeat
  end tell
  return ""
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

const RESIZE_SCRIPT = onPane(`            set r to perform action (item 2 of argv) on term
            return r as text`);

const MARKER_ATTEMPTS = 6;


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
          "Ghostty on Linux doesn't support scripted splits. Run without --split, or use tmux, kitty (with config changes), or WezTerm (partial support).",
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

  async function panes(): Promise<Pane[]> {
    const listed: Pane[] = [];
    directories.clear();
    for (const line of (await osascript(LIST_SCRIPT, [])).split("\n")) {
      if (!line.trim()) continue;
      const [window, tab, pane, directory, ...title] = line.split("\t");
      directories.set(pane, directory);
      listed.push({ id: pane, tab: `${window}:${tab}` });
    }
    return listed;
  }

  async function getCurrentPane({ tty, cwd }: PaneContext): Promise<Pane | null> {
    if (!tty) return null;
    const before = await panes();
    const marker = markerDirectory();
    let restoreTo = cwd;
    try {
      for (let attempt = 0; attempt < MARKER_ATTEMPTS; attempt++) {
        setPaneWorkingDirectory(tty, marker);
        if (attempt > 0) await sleep(120);
        const id = await osascript(FIND_BY_DIRECTORY_SCRIPT, [marker]);
        if (!id) continue;
        restoreTo = directories.get(id) ?? restoreTo;
        return before.find((pane) => pane.id === id) ?? null;
      }
      throw new Error(
        `could not find this pane in Ghostty — we marked ${tty} and no Ghostty pane reported it back, so ${tty} is not a Ghostty pane (a shell inside tmux or a remote session looks like this)`,
      );
    } finally {
      setPaneWorkingDirectory(tty, restoreTo);
      fs.rmSync(marker, { recursive: true, force: true });
    }
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

import { execFileSync, spawn } from "node:child_process";

import {
  Backend,
  Direction,
  Pane,
  callerTty,
  setPaneTitle,
  shellQuote,
  sleep,
} from "./shared";

const LIST_SCRIPT = `
on run argv
  set marker to item 1 of argv
  set out to ""
  set sep to tab
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          set selfFlag to "0"
          if (name of term) contains marker then set selfFlag to "1"
          set out to out & (id of w) & sep & (id of tb) & sep & (id of term) & sep & selfFlag & sep & (name of term) & linefeed
        end repeat
      end repeat
    end repeat
  end tell
  return out
end run
`;

const SEND_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  set payload to item 2 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (id of term) is targetId then
            input text payload to term
            focus term
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const FOCUS_SCRIPT = `
on run argv
  set needle to item 1 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (name of term) contains needle then
            focus term
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const RESIZE_SCRIPT = `
on run argv
  set needle to item 1 of argv
  set resizeAction to item 2 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (name of term) contains needle then
            set r to perform action resizeAction on term
            return r as text
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const FIND_SCRIPT = `
on run argv
  set needle to item 1 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (name of term) contains needle then return (id of term) as text
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run
`;

const CLOSE_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  delay 0.3
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (id of term) as text is targetId then
            close term
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
end run
`;

const ZOOM_SCRIPT = `
on run argv
  set needle to item 1 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (name of term) contains needle then
            perform action "toggle_split_zoom" on term
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

// the split direction is an AppleScript enum keyword, not a string — it can't
// arrive through argv, it has to be baked into the script text
const splitScript = (direction: Direction) => `
on run argv
  set marker to item 1 of argv
  set cmdText to item 2 of argv
  set cwdText to item 3 of argv
  tell application "Ghostty"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with term in terminals of tb
          if (name of term) contains marker then
            split term direction ${direction} with configuration {initial working directory:cwdText, initial input:cmdText & linefeed}
            return
          end if
        end repeat
      end repeat
    end repeat
    error "could not find this pane"
  end tell
end run
`;

function osascript(script: string, args: string[]): string {
  try {
    return execFileSync("osascript", ["-", ...args], {
      encoding: "utf8",
      input: script,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
      // failed attempts inside withMarkedPane's retry loop are routine;
      // inherited stderr would print their AppleScript errors to the caller
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const signal = (error as { signal?: string }).signal;
    if (signal === "SIGTERM") {
      throw new Error(
        "controlling Ghostty timed out — this environment may lack macOS automation permission for Ghostty",
      );
    }
    throw error;
  }
}

async function withMarkedPane<T>(fn: (marker: string) => T): Promise<T> {
  const tty = callerTty();
  if (!tty) throw new Error("no terminal tty found for this process");
  const marker = `pixel-marker-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    setPaneTitle(tty, marker);
    await sleep(150);
    try {
      return fn(marker);
    } catch {}
  }
  throw new Error(
    `could not find this pane in Ghostty — something keeps rewriting the ${tty} title (busy TUI), or this shell is inside tmux (which drops the title marker unless set-titles is on)`,
  );
}

function parseListing(out: string, marker: string): Pane[] {
  const panes: Pane[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [window, tab, pane, selfFlag, ...title] = line.split("\t");
    panes.push({ window, tab, pane, self: selfFlag === "1" && marker !== "", title: title.join("\t") });
  }
  return panes;
}

export const ghostty: Backend = {
  app: "ghostty",
  panes() {
    return withMarkedPane((marker) => {
      const panes = parseListing(osascript(LIST_SCRIPT, [marker]), marker);
      if (!panes.some((pane) => pane.self)) throw new Error("marker not visible yet");
      return panes;
    });
  },
  async listAll() {
    return parseListing(osascript(LIST_SCRIPT, ["pixel-never-matches"]), "");
  },
  async sendText(paneId, text) {
    return osascript(SEND_SCRIPT, [paneId, text]).trim() === "ok";
  },
  split(direction, command, cwd) {
    return withMarkedPane((marker) => {
      osascript(splitScript(direction), [marker, shellQuote(command), cwd]);
    });
  },
  async focusPane(titleNeedle) {
    return osascript(FOCUS_SCRIPT, [titleNeedle]).trim() === "ok";
  },
  focusSelf() {
    return withMarkedPane(
      (marker) => osascript(FOCUS_SCRIPT, [marker]).trim() === "ok",
    );
  },
  async resizePane(titleNeedle, grow, points) {
    const amount = Math.round(Math.abs(points));
    if (amount < 3) return true;
    const opposite: Record<Direction, Direction> = {
      left: "right",
      right: "left",
      up: "down",
      down: "up",
    };
    const direction = points >= 0 ? grow : opposite[grow];
    // the pane sets its title marker shortly after launch; retry the lookup
    for (let attempt = 0; attempt < 8; attempt++) {
      const out = osascript(RESIZE_SCRIPT, [
        titleNeedle,
        `resize_split:${direction},${amount}`,
      ]).trim();
      if (out === "true") return true;
      if (out === "false") return false;
      await sleep(250);
    }
    return false;
  },
  /** The pane is resolved to an id up front (its title marker vanishes once
   * the process exits) and closed by a detached osascript that outlives the
   * caller; closing after the process exits means Ghostty sees no running
   * process and skips its close confirmation. */
  async closePane(titleNeedle) {
    let id: string;
    try {
      id = osascript(FIND_SCRIPT, [titleNeedle]).trim();
    } catch {
      return false;
    }
    if (!id) return false;
    const closer = spawn("osascript", ["-", id], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    closer.stdin.end(CLOSE_SCRIPT);
    closer.unref();
    return true;
  },
  async zoomPane(titleNeedle) {
    try {
      return osascript(ZOOM_SCRIPT, [titleNeedle]).trim() === "ok";
    } catch {
      return false;
    }
  },
};

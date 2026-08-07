import { appleScript } from "../applescript";
import { shellQuote } from "../shared";
import type { Detect, Pane } from "../terminal";

const LIST_SCRIPT = `
on run argv
  set out to ""
  set sep to tab
  tell application "iTerm"
    repeat with w in windows
      set tabIndex to 0
      repeat with tb in tabs of w
        set tabIndex to tabIndex + 1
        repeat with s in sessions of tb
          try
            set out to out & ((id of w) as text) & sep & (tabIndex as text) & sep & (id of s) & sep & (tty of s) & linefeed
          end try
        end repeat
      end repeat
    end repeat
  end tell
  return out
end run
`;

const SPLIT_SCRIPT = `
on run argv
  set wanted to item 1 of argv
  set startCommand to item 2 of argv
  set place to item 3 of argv
  tell application "iTerm"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          if (id of s) is wanted then
            if place is "beside" then
              split vertically with same profile s command startCommand
            else
              split horizontally with same profile s command startCommand
            end if
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "gone"
end run
`;

interface Session extends Pane {
  tty: string;
}

export const iterm2: Detect = (env, run) => {
  if (!env.ITERM_SESSION_ID) return null;
  if (env.TERM_PROGRAM && env.TERM_PROGRAM !== "iTerm.app") return null;

  const osascript = appleScript("iTerm2", run);
  const exportedId = env.ITERM_SESSION_ID.split(":")[1] ?? "";

  async function sessions(): Promise<Session[]> {
    const listed: Session[] = [];
    for (const line of (await osascript(LIST_SCRIPT, [])).split("\n")) {
      if (!line.trim()) continue;
      const [window, tabIndex, id, tty] = line.split("\t");
      listed.push({ id, tab: `${window}:${tabIndex}`, tty });
    }
    return listed;
  }

  return {
    name: "iterm2",
    async getCurrentPane({ tty }) {
      const open = await sessions();
      // a shell keeps the id of the session that started it, long after that session closes
      const onThisTty = tty ? open.find((session) => session.tty === tty) : undefined;
      const mine = onThisTty ?? open.find((session) => session.id === exportedId);
      return mine ? { id: mine.id, tab: mine.tab } : null;
    },
    async split({ from, direction, command }) {
      if (direction === "left" || direction === "up") {
        throw new Error("iTerm2 only splits right and down");
      }
      const place = direction === "right" ? "beside" : "below";
      const answer = await osascript(SPLIT_SCRIPT, [from.id, shellQuote(command), place]);
      if (answer !== "ok") throw new Error("this pane went away before we could split it");
    },
  };
};

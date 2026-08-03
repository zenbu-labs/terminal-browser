import { execFileSync } from "node:child_process";

import { Backend, Pane, callerTty, shellQuote } from "./shared";

const APP = "iTerm2";

function osascript(script: string, args: string[] = []): string {
  try {
    return execFileSync("osascript", ["-", ...args], {
      encoding: "utf8",
      input: script,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const signal = (error as { signal?: string }).signal;
    if (signal === "SIGTERM") {
      throw new Error(
        "controlling iTerm2 timed out — grant macOS Automation permission for the caller to control iTerm",
      );
    }
    throw error;
  }
}

function selfSessionId(env: NodeJS.ProcessEnv): string | null {
  const raw = env.ITERM_SESSION_ID ?? env.TERM_SESSION_ID;
  if (!raw) return null;
  const colon = raw.indexOf(":");
  return colon >= 0 ? raw.slice(colon + 1) : raw;
}

const LIST_SCRIPT = `
on run argv
  set selfId to item 1 of argv
  set selfTty to item 2 of argv
  set out to ""
  set sep to (ASCII character 9)
  tell application "${APP}"
    repeat with w in windows
      set wid to id of w as text
      set ti to 0
      repeat with tb in tabs of w
        set ti to ti + 1
        set tid to ti as text
        repeat with s in sessions of tb
          set sid to id of s as text
          set selfFlag to "0"
          if selfId is not "" and sid is selfId then set selfFlag to "1"
          if selfFlag is "0" and selfTty is not "" then
            try
              if tty of s is selfTty then set selfFlag to "1"
            end try
          end if
          set sname to ""
          try
            set sname to name of s as text
          end try
          set out to out & wid & sep & tid & sep & sid & sep & selfFlag & sep & sname & linefeed
        end repeat
      end repeat
    end repeat
  end tell
  return out
end run
`;

const SPLIT_SCRIPT = `
on run argv
  set selfId to item 1 of argv
  set selfTty to item 2 of argv
  set dir to item 3 of argv
  set cmdText to item 4 of argv
  tell application "${APP}"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          set matched to false
          if selfId is not "" and (id of s as text) is selfId then set matched to true
          if not matched and selfTty is not "" then
            try
              if tty of s is selfTty then set matched to true
            end try
          end if
          if matched then
            if dir is "right" or dir is "left" then
              split vertically with same profile s command cmdText
            else
              split horizontally with same profile s command cmdText
            end if
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const SEND_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  set payload to item 2 of argv
  tell application "${APP}"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          if (id of s as text) is targetId then
            write s text payload newline no
            select s
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
  tell application "${APP}"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          set sname to ""
          try
            set sname to name of s as text
          end try
          if sname contains needle or (id of s as text) is needle then
            select s
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

const CLOSE_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  tell application "${APP}"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          if (id of s as text) is targetId then
            close s
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;

function parseListing(out: string): Pane[] {
  const panes: Pane[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [window, tab, pane, selfFlag, ...title] = line.split("\t");
    panes.push({
      window,
      tab,
      pane,
      self: selfFlag === "1",
      title: title.join("\t"),
    });
  }
  return panes;
}

export function isIterm(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TERM_PROGRAM === "iTerm.app") return true;
  if (env.LC_TERMINAL === "iTerm2") return true;
  if (env.ITERM_SESSION_ID || env.ITERM_PROFILE) return true;
  return false;
}

export function createIterm(env: NodeJS.ProcessEnv = process.env): Backend {
  const sessionId = () => selfSessionId(env) ?? "";
  const tty = () => callerTty() ?? "";

  const backend: Backend = {
    app: "iterm",
    async panes() {
      return parseListing(osascript(LIST_SCRIPT, [sessionId(), tty()]));
    },
    async listAll() {
      return parseListing(osascript(LIST_SCRIPT, ["", ""]));
    },
    async split(direction, command) {
      const result = osascript(SPLIT_SCRIPT, [
        sessionId(),
        tty(),
        direction,
        shellQuote(command),
      ]).trim();
      if (result !== "ok") {
        throw new Error(
          "could not find this iTerm2 session to split — is the shell running inside iTerm2?",
        );
      }
    },
    async sendText(paneId, text) {
      return osascript(SEND_SCRIPT, [paneId, text]).trim() === "ok";
    },
    async focusPane(titleNeedle) {
      return osascript(FOCUS_SCRIPT, [titleNeedle]).trim() === "ok";
    },
    async focusSelf() {
      const id = sessionId();
      if (id) return osascript(FOCUS_SCRIPT, [id]).trim() === "ok";
      const me = (await backend.panes()).find((pane) => pane.self);
      if (!me) return false;
      return osascript(FOCUS_SCRIPT, [me.pane]).trim() === "ok";
    },
    async closePane(titleNeedle) {
      const target = (await backend.listAll()).find((pane) => pane.title.includes(titleNeedle));
      if (!target) return false;
      return osascript(CLOSE_SCRIPT, [target.pane]).trim() === "ok";
    },
  };
  return backend;
}

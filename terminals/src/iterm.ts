import { execFileSync } from "node:child_process";

import { Backend, Pane, callerTty, shellQuote } from "./shared";

const APP = "iTerm2";

const CONTROL_SCRIPT = `
on run argv
  set action to item 1 of argv
  set sep to (ASCII character 9)
  tell application "${APP}"
    if action is "list" then
      set selfId to item 2 of argv
      set selfTty to item 3 of argv
      set out to ""
      repeat with w in windows
        set wid to id of w as text
        set tabIndex to 0
        repeat with tb in tabs of w
          set tabIndex to tabIndex + 1
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
            set out to out & wid & sep & (tabIndex as text) & sep & sid & sep & selfFlag & sep & sname & linefeed
          end repeat
        end repeat
      end repeat
      return out
    end if

    if action is "split" then
      set selfId to item 2 of argv
      set selfTty to item 3 of argv
      set dir to item 4 of argv
      set cmdText to item 5 of argv
      set target to my findSession(selfId, selfTty)
      if target is missing value then return "not-found"
      if dir is "right" or dir is "left" then
        split vertically with same profile target command cmdText
      else
        split horizontally with same profile target command cmdText
      end if
      return "ok"
    end if

    if action is "write" then
      set targetId to item 2 of argv
      set payload to item 3 of argv
      set target to my findById(targetId)
      if target is missing value then return "not-found"
      write target text payload newline no
      select target
      return "ok"
    end if

    if action is "select" then
      set needle to item 2 of argv
      set target to my findById(needle)
      if target is missing value then set target to my findByName(needle)
      if target is missing value then return "not-found"
      select target
      return "ok"
    end if

    if action is "close" then
      set targetId to item 2 of argv
      set target to my findById(targetId)
      if target is missing value then return "not-found"
      close target
      return "ok"
    end if
  end tell
  return "unknown-action"
end run

on findSession(selfId, selfTty)
  tell application "${APP}"
    if selfId is not "" then
      set byId to my findById(selfId)
      if byId is not missing value then return byId
    end if
    if selfTty is not "" then
      repeat with w in windows
        repeat with tb in tabs of w
          repeat with s in sessions of tb
            try
              if tty of s is selfTty then return s
            end try
          end repeat
        end repeat
      end repeat
    end if
  end tell
  return missing value
end findSession

on findById(targetId)
  tell application "${APP}"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          if (id of s as text) is targetId then return s
        end repeat
      end repeat
    end repeat
  end tell
  return missing value
end findById

on findByName(needle)
  tell application "${APP}"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          try
            if (name of s as text) contains needle then return s
          end try
        end repeat
      end repeat
    end repeat
  end tell
  return missing value
end findByName
`;

function osascript(args: string[]): string {
  try {
    return execFileSync("osascript", ["-", ...args], {
      encoding: "utf8",
      input: CONTROL_SCRIPT,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const signal = (error as { signal?: string }).signal;
    if (signal === "SIGTERM") {
      throw new Error(
        "controlling iTerm2 timed out: grant macOS Automation permission for the caller to control iTerm",
      );
    }
    throw error;
  }
}

// ITERM_SESSION_ID is `w0t0p0:<guid>`; AppleScript session id is the guid.
function selfSessionId(env: NodeJS.ProcessEnv): string {
  const raw = env.ITERM_SESSION_ID ?? env.TERM_SESSION_ID;
  if (!raw) return "";
  const colon = raw.indexOf(":");
  return colon >= 0 ? raw.slice(colon + 1) : raw;
}

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
  return (
    env.TERM_PROGRAM === "iTerm.app" ||
    env.LC_TERMINAL === "iTerm2" ||
    Boolean(env.ITERM_SESSION_ID)
  );
}

export function createIterm(env: NodeJS.ProcessEnv = process.env): Backend {
  const sessionId = () => selfSessionId(env);
  const tty = () => callerTty() ?? "";

  const backend: Backend = {
    app: "iterm",
    async panes() {
      return parseListing(osascript(["list", sessionId(), tty()]));
    },
    async listAll() {
      return parseListing(osascript(["list", "", ""]));
    },
    async split(direction, command) {
      const result = osascript([
        "split",
        sessionId(),
        tty(),
        direction,
        shellQuote(command),
      ]).trim();
      if (result !== "ok") {
        throw new Error(
          "could not find this iTerm2 session to split: is the shell running inside iTerm2?",
        );
      }
    },
    async sendText(paneId, text) {
      return osascript(["write", paneId, text]).trim() === "ok";
    },
    async focusPane(titleNeedle) {
      return osascript(["select", titleNeedle]).trim() === "ok";
    },
    async focusSelf() {
      const id = sessionId();
      if (id) return osascript(["select", id]).trim() === "ok";
      const me = (await backend.panes()).find((pane) => pane.self);
      return me ? osascript(["select", me.pane]).trim() === "ok" : false;
    },
    async closePane(titleNeedle) {
      const target = (await backend.listAll()).find((pane) => pane.title.includes(titleNeedle));
      return target ? osascript(["close", target.pane]).trim() === "ok" : false;
    },
  };
  return backend;
}

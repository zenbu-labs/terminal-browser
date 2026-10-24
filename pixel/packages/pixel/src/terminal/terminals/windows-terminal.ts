import path from "node:path";

import type { Detect } from "../terminal";

// Windows looks in the current directory before PATH, so a bare "wt" would run a wt.exe planted
// in whatever project the user is in; Windows Terminal's own alias lives here instead.
function wtExecutable(env: NodeJS.ProcessEnv): string {
  if (!env.LOCALAPPDATA) throw new Error("cannot find wt.exe without LOCALAPPDATA");
  return path.win32.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe");
}

// wt reads `;` as the start of its next command, so one inside an argument has to be escaped.
function wtArgument(arg: string): string {
  return arg.replaceAll(";", "\\;");
}

// The wt command line cannot list, focus or type into panes, so only splitting is offered.
// New panes always open to the right of or below the current one.
export const windowsTerminal: Detect = (env, run) => {
  if (!env.WT_SESSION || env.TERM_PROGRAM) return null;
  const session = env.WT_SESSION;

  return {
    name: "windows-terminal",
    async getCurrentPane() {
      return { id: session, tab: session };
    },
    async split({ direction, command, size }) {
      const orientation = direction === "right" || direction === "left" ? "--vertical" : "--horizontal";
      const sized = size ? ["--size", String(size)] : [];
      await run(wtExecutable(env), ["-w", "0", "split-pane", orientation, ...sized, ...command.map(wtArgument)]);
    },
  };
};

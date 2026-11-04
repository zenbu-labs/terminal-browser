export const DEBUGGING_PORT_FLAG = "--remote-debugging-port";
// How the CLI passes the port to the daemon: a name of our own, so Chromium never
// opens its own debugging server.
export const DAEMON_PORT_SWITCH = "cdp-port";

// The port asked for with --remote-debugging-port[=N]: 0 lets Chromium pick a free one,
// null means the flag wasn't given.
export function requestedDebuggingPort(argv: string[]): number | null {
  for (const arg of argv) {
    if (arg === DEBUGGING_PORT_FLAG) return 0;
    if (!arg.startsWith(`${DEBUGGING_PORT_FLAG}=`)) continue;
    const value = arg.slice(DEBUGGING_PORT_FLAG.length + 1);
    const port = Number(value);
    // fixme: placeholder copy
    if (!/^\d+$/.test(value) || port > 65535) throw new Error(`invalid ${DEBUGGING_PORT_FLAG}=${value} (a port from 0 to 65535)`);
    return port;
  }
  return null;
}

// The debugging port is opened when the browser starts, so a browser that is
// already running can only serve the port it has (or none).
export function debuggingPortRefusal(argv: string[], open: number | null): string | null {
  let wanted: number | null;
  try {
    wanted = requestedDebuggingPort(argv);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (wanted === null || wanted === open || (wanted === 0 && open !== null)) return null;
  // fixme: placeholder copy
  if (open === null) return "terminal-browser is already running without --remote-debugging-port; close its windows, wait for it to exit, then open it with the flag";
  // fixme: placeholder copy
  return `terminal-browser is already running with --remote-debugging-port=${open}`;
}

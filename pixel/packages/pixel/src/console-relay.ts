export const RELAY_SIZE_ENV = "TERMINAL_BROWSER_RELAY_SIZE";

/**
 * Windows gives one process no way to draw in another's console, so the process that owns the
 * console relays it through a named pipe that the engine opens as its terminal. Resolves once
 * the engine closes the pipe and the console is back in the mode it started in.
 */
export function relayConsole(pipe: string): Promise<void> {
  // The native engine is large, so it is only loaded by the process that relays.
  const native = require("./react/native") as typeof import("./react/native");
  return native.relayConsole(pipe);
}

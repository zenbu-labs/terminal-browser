// Apps launched from the browser get the session's environment minus the
// Claude bridge's address and credentials, which only the browser itself uses,
// and NODE_OPTIONS, which could turn on a debugger listening on a TCP port.
export function appEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("TERMINAL_BROWSER_AGENT_") && key !== "NODE_OPTIONS"),
  );
}

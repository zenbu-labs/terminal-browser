// The Claude bridge hands `terminal-browser open` its token on stdin and sets
// this variable, so the token never sits in an environment that gets copied on.
export const AGENT_TOKEN_ON_STDIN = "TERMINAL_BROWSER_AGENT_TOKEN_ON_STDIN";

export function readAgentToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env[AGENT_TOKEN_ON_STDIN] !== "1") return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (text += chunk));
    process.stdin.on("end", () => resolve(/^[0-9a-f]{48}$/.test(text.trim()) ? text.trim() : null));
    process.stdin.on("error", () => resolve(null));
  });
}

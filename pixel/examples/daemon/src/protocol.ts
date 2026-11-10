import os from "node:os";
import path from "node:path";

export const SOCKET = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
  "daemon-example",
  "daemon.sock",
);

export type Request =
  | { cmd: "open"; tty: string; url: string; cwd: string; env: Record<string, string | undefined> }
  | { cmd: "resize" }
  | { cmd: "close" }
  | { cmd: "shutdown" };

export type Reply =
  | { ok: true; pid: number }
  | { ok: false; error: string }
  | { event: "closed"; code: number };

export function lines(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  };
}

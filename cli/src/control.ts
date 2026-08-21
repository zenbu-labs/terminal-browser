import net from "node:net";

import { readSocketControlSecret } from "pixel-store";

interface ControlReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function control(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const secret = readSocketControlSecret();
    if (!secret) {
      reject(new Error("no browser control secret yet; start the browser first"));
      return;
    }
    const connection = net.connect(socketPath);
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("control request timed out"));
    }, timeoutMs);
    let buffer = "";
    let authenticated = false;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      finish();
    };
    connection.setEncoding("utf8");
    connection.on("error", (error) => settle(() => reject(error)));
    // A refused connection only ever gets a FIN, so "end" is what makes it fail fast;
    // "close" covers the peer that dies without one.
    const closed = () =>
      settle(() => reject(new Error("browser closed the control connection")));
    connection.on("end", closed);
    connection.on("close", closed);
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let reply: ControlReply;
        try {
          reply = JSON.parse(line) as ControlReply;
        } catch (error) {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        if (!reply.ok) {
          settle(() => reject(new Error(reply.error ?? "control request failed")));
          return;
        }
        if (!authenticated) {
          authenticated = true;
          connection.write(`${JSON.stringify(request)}\n`);
          continue;
        }
        settle(() => resolve(reply.data));
        return;
      }
    });
    connection.write(`${JSON.stringify({ cmd: "auth", secret })}\n`);
  });
}

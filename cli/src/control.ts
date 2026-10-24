import { randomUUID } from "node:crypto";
import net from "node:net";

import { ipcPath } from "@zenbu-labs/pixel/terminal";

// a browser that cannot say where it sits this quickly is not worth waiting for,
// or every open would stall behind one slow host
export const WHERE_TIMEOUT_MS = 300;

export function control(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const connection = net.connect(ipcPath(socketPath));
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("control request timed out"));
    }, timeoutMs);
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      connection.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          id?: string | null;
          ok: boolean;
          data?: unknown;
          error?: string;
        };
        if (!response.ok) reject(new Error(response.error ?? "control request failed"));
        else if (response.id !== id) reject(new Error("response id mismatch"));
        else resolve(response.data);
      } catch (error) {
        reject(error);
      }
    });
    connection.write(`${JSON.stringify({ id, ...request })}\n`);
  });
}

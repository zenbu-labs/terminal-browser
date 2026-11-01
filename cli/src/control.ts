import { randomUUID } from "node:crypto";
import type net from "node:net";

import { connectPrivately } from "@zenbu-labs/pixel/private-socket";

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
    let connection: net.Socket | null = null;
    const timer = setTimeout(() => {
      connection?.destroy();
      reject(new Error("control request timed out"));
    }, timeoutMs);
    const fail = (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    };
    connectPrivately(socketPath).then((connected) => {
      connection = connected;
      let buffer = "";
      connected.setEncoding("utf8");
      connected.on("error", fail);
      connected.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        connected.destroy();
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
      connected.write(`${JSON.stringify({ id, ...request })}\n`);
    }, fail);
  });
}

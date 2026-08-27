import { randomUUID } from "node:crypto";
import net from "node:net";

export function control(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const connection = net.connect(socketPath);
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

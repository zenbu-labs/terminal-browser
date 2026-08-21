import net from "node:net";

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
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const connection = net.connect(socketPath);
  const timer = setTimeout(() => {
    connection.destroy();
    reject(new Error("control request timed out"));
  }, timeoutMs);
  let buffer = "";
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
  // A browser that hangs up without answering only ever sends a FIN, so "end" is what
  // makes it fail fast; "close" covers the peer that dies without one.
  const closed = () => settle(() => reject(new Error("browser closed the control connection")));
  connection.on("end", closed);
  connection.on("close", closed);
  connection.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    let reply: ControlReply;
    try {
      reply = JSON.parse(buffer.slice(0, newline)) as ControlReply;
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    if (reply.ok) settle(() => resolve(reply.data));
    else settle(() => reject(new Error(reply.error ?? "control request failed")));
  });
  connection.write(`${JSON.stringify(request)}\n`);
  return promise;
}

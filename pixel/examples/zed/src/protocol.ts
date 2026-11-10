export type Request =
  | { cmd: "open"; tty: string; folder: string; env: Record<string, string | undefined>; startedAt: number }
  | { cmd: "resize" }
  | { cmd: "close" }
  | { cmd: "shutdown" };

export type Reply =
  | { ok: true }
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

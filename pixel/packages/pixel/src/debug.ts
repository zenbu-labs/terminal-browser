const enabled = typeof process !== "undefined" && process.env?.PIXEL_DEBUG === "1";

export function debug(...parts: unknown[]): void {
  if (!enabled) return;
  process.stderr.write(`[pixel] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
}

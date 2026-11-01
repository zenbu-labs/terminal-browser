import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "pxsh", "host.log");

export function logError(error: unknown): void {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${process.pid} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  } catch {}
}

export function trace(...parts: unknown[]): void {
  if (process.env.PXSH_TRACE) fs.appendFileSync(process.env.PXSH_TRACE, parts.map((p) => JSON.stringify(p)).join(" ") + "\n");
}

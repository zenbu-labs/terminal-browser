import fs from "node:fs";
import path from "node:path";

/** Both sockets drive the browser and hand out its cookies, so keep them to this user. */
export function prepareSocketDirectory(socketPath: string): void {
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

/** Call once the socket exists: binding it applies the umask, not the mode we asked for. */
export function restrictSocketMode(socketPath: string): void {
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {}
}

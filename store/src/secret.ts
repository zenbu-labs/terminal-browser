import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SOCKET_SECRET_FILE } from "./paths";

export function readSocketControlSecret(): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(SOCKET_SECRET_FILE, "utf8");
  } catch {
    return null;
  }
  const secret = contents.trim();
  return secret.length > 0 ? secret : null;
}

export function writeSocketControlSecret(secret: string): void {
  const directory = path.dirname(SOCKET_SECRET_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (readSocketControlSecret() === secret) {
    // A copy restored from a backup can hold the right secret at the wrong mode.
    fs.chmodSync(SOCKET_SECRET_FILE, 0o600);
    return;
  }
  // Write under an unguessable name so a pre-planted path cannot redirect the write, then link
  // it into place rather than renaming over: link fails if the name is taken, so two daemons
  // minting at once settle on one secret instead of the loser's write orphaning the secret the
  // running daemon already holds. A reader still never sees a half-written file.
  const staging = `${SOCKET_SECRET_FILE}.${crypto.randomBytes(6).toString("hex")}`;
  const handle = fs.openSync(staging, "wx", 0o600);
  try {
    fs.writeFileSync(handle, secret, "utf8");
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.linkSync(staging, SOCKET_SECRET_FILE);
  } catch (error) {
    // Someone got there first, and theirs is the secret the running daemon authenticates with.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

/** Drops a secret nothing can use, so the next mint is not refused by the file already there. */
export function discardSocketControlSecret(): void {
  fs.rmSync(SOCKET_SECRET_FILE, { force: true });
}

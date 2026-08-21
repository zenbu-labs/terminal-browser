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
  // Rename so a reader never sees a half-written secret, and open exclusively under an
  // unguessable name so a pre-planted path cannot redirect the write.
  const staging = `${SOCKET_SECRET_FILE}.${crypto.randomBytes(6).toString("hex")}`;
  const handle = fs.openSync(staging, "wx", 0o600);
  try {
    fs.writeFileSync(handle, secret, "utf8");
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(staging, SOCKET_SECRET_FILE);
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readSocketControlSecret, writeSocketControlSecret } from "pixel-store";

const SECRET_BYTES = 32;
const SECRET_SHAPE = /^[0-9a-f]{64}$/;

// An unauthenticated peer gets only enough budget to send its auth line, so it can
// neither grow a read buffer nor hold a connection slot open.
export const PRE_AUTH_MAX_BYTES = 4096;
export const PRE_AUTH_TIMEOUT_MS = 2000;

interface AuthRequest {
  cmd?: string;
  secret?: string;
}

/**
 * The per-install control-socket secret, created on first use.
 *
 * The 0600 file is the whole store. It keeps other users off the sockets; it stops
 * nothing that already runs as this user, since that can read the file with no prompt.
 * Deleting the file rotates the secret on the next launch.
 */
export function loadOrCreateSocketSecret(): string {
  const stored = readSocketControlSecret();
  if (stored && SECRET_SHAPE.test(stored)) return stored;
  const created = crypto.randomBytes(SECRET_BYTES).toString("hex");
  writeSocketControlSecret(created);
  return created;
}

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

/** Returns an error to send back, or null once the peer has proved the secret. */
export function authenticationFailure(expected: string, line: string): string | null {
  let request: AuthRequest;
  try {
    request = JSON.parse(line) as AuthRequest;
  } catch {
    // Never surface the parse error: the line it quotes is the secret.
    return "auth expects a json object";
  }
  if (request.cmd !== "auth") return "authentication required: send auth first";
  if (typeof request.secret !== "string") return "auth needs a secret";
  if (!secretsMatch(expected, request.secret)) return "authentication failed";
  return null;
}

/**
 * Compares in time independent of where the two values first differ. The socket is
 * local-only, so the timing surface is small, but this is an auth path and an early
 * exit would leak how much of the secret a caller guessed.
 */
function secretsMatch(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  let difference = expectedBytes.length ^ providedBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= expectedBytes[index]! ^ (providedBytes[index] ?? 0);
  }
  return difference === 0;
}

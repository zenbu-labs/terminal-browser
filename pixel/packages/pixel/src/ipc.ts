import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Unlike a socket file, a named pipe is visible to every user on the machine, so its name mixes in
// a secret kept beside the socket file, where only this user can read it; nobody else can work out
// the name and open the pipe first to receive what is sent to it.
const SECRET = /^[0-9a-f]{64}$/;

function readSecret(file: string): string | null {
  try {
    const secret = fs.readFileSync(file, "utf8").trim();
    return SECRET.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

function pipeSecret(dir: string): string {
  const file = path.join(dir, ".pipe-secret");
  const existing = readSecret(file);
  if (existing) return existing;
  if (!fs.existsSync(file)) {
    // Written whole beside the secret and then linked into place, so a process starting at the
    // same moment either finds no secret or a complete one, never an empty file.
    fs.mkdirSync(dir, { recursive: true });
    const draft = path.join(dir, `.pipe-secret-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    fs.writeFileSync(draft, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    try {
      fs.linkSync(draft, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(draft, { force: true });
    }
  }
  const secret = readSecret(file);
  if (!secret) throw new Error(`${file} does not hold a pipe secret; delete it so a new one is made`);
  return secret;
}

// Node only talks to local sockets through named pipes on Windows, so each socket file stands
// for a pipe named after the file and this user's secret.
export function ipcPath(socketFile: string): string {
  if (process.platform !== "win32") return socketFile;
  const file = path.resolve(socketFile);
  const digest = crypto
    .createHmac("sha256", pipeSecret(path.dirname(file)))
    .update(file.toLowerCase())
    .digest("hex");
  return `\\\\.\\pipe\\terminal-browser-${digest.slice(0, 32)}-${path.basename(file)}`;
}

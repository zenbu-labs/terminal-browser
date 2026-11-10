import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SERVER_BIN, STATE_DIR } from "./paths";

const ISSUER = "zs";
const AUDIENCE = "pixel-zed";
const TOKEN_TTL_SECS = 50 * 60;

export interface Workspace {
  id: string;
  folder: string;
  port: number;
  process: ChildProcess;
  participants: Set<string>;
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKeyFile = path.join(STATE_DIR, "jwt-public.pem");
const controlSecretFile = path.join(STATE_DIR, "control-secret");
const workspaces = new Map<string, Promise<Workspace>>();
const servers = new Set<ChildProcess>();
process.on("exit", () => {
  for (const server of servers) server.kill("SIGKILL");
});

function writeKeys() {
  fs.mkdirSync(path.join(STATE_DIR, "logs"), { recursive: true });
  fs.writeFileSync(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
  fs.writeFileSync(controlSecretFile, crypto.randomBytes(32).toString("base64url"), { mode: 0o600 });
}
writeKeys();

function folderHash(folder: string) {
  return crypto.createHash("sha256").update(folder).digest("hex");
}

// The server only accepts participant ids shaped like `p_` plus 32 hex characters.
export function participantFor(workspace: Workspace): string {
  const stable = `p_${folderHash(workspace.folder).slice(0, 32)}`;
  return workspace.participants.has(stable) ? `p_${crypto.randomBytes(16).toString("hex")}` : stable;
}

export function mintToken(workspace: Workspace, participant: string) {
  const sessionId = `con_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "local",
    pid: participant,
    ws: workspace.id,
    sid: sessionId,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + TOKEN_TTL_SECS,
  })}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return {
    wsUrl: `ws://127.0.0.1:${workspace.port}/rpc`,
    token: `${unsigned}.${signature.toString("base64url")}`,
    sessionId,
    sessionExpiresAt: new Date((now + TOKEN_TTL_SECS) * 1000).toISOString(),
  };
}

async function waitForPort(portFile: string, child: ChildProcess, log: string): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`zed-remote-server exited with ${child.exitCode} (log: ${log})`);
    const contents = fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").trim() : "";
    if (contents) return Number(contents.split(":").pop());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`zed-remote-server did not start within 30s (log: ${log})`);
}

async function startWorkspace(folder: string, pageOrigin: string): Promise<Workspace> {
  const id = `ws-${folderHash(folder).slice(0, 16)}`;
  const log = path.join(STATE_DIR, "logs", `${id}.log`);
  const portFile = path.join(STATE_DIR, `${id}.port`);
  fs.rmSync(portFile, { force: true });
  const output = fs.openSync(log, "w");
  const child = spawn(
    SERVER_BIN,
    [
      "serve",
      "--listen", "127.0.0.1:0",
      "--port-file", portFile,
      "--control-listen", "127.0.0.1:0",
      "--control-secret-file", controlSecretFile,
      "--jwt-public-key", publicKeyFile,
      "--issuer", ISSUER,
      "--audience", AUDIENCE,
      "--workspace-id", id,
      "--workspace-root", folder,
      "--allowed-origin", pageOrigin,
      "--user-data-dir", path.join(STATE_DIR, "data"),
    ],
    { stdio: ["ignore", output, output] },
  );
  fs.closeSync(output);
  servers.add(child);
  child.on("exit", () => {
    servers.delete(child);
    workspaces.delete(folder);
  });
  const port = await waitForPort(portFile, child, log);
  return { id, folder, port, process: child, participants: new Set() };
}

export function workspaceFor(folder: string, pageOrigin: string): Promise<Workspace> {
  let workspace = workspaces.get(folder);
  if (!workspace) {
    workspace = startWorkspace(folder, pageOrigin);
    workspace.catch(() => workspaces.delete(folder));
    workspaces.set(folder, workspace);
  }
  return workspace;
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function stopAllWorkspaces() {
  const running = await Promise.all([...workspaces.values()].map((workspace) => workspace.catch(() => null)));
  workspaces.clear();
  await Promise.all(running.map((workspace) => (workspace ? stopProcess(workspace.process) : null)));
}

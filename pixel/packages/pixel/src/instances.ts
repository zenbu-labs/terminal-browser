import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { connectPrivately } from "./host/private-socket";
import { reclaimPrivateDir } from "./private-dir";



export const PROTOCOL = 1;

export interface Instance {
  tty: string;
  pid: number;
  socket: string;
  protocol: number;
  name: string;
  title: string | null;
  cwd: string;
  startedAt: number;
}

export function instancesDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(state, "pixel", "instances");
}

export function instanceKey(tty: string): string {
  return tty.replace(/[^\w-]/g, "_");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readInstance(file: string): Instance | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Instance>;
    if (
      typeof parsed.tty !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.socket !== "string" ||
      typeof parsed.protocol !== "number"
    ) {
      return null;
    }
    return {
      tty: parsed.tty,
      pid: parsed.pid,
      socket: parsed.socket,
      protocol: parsed.protocol,
      name: typeof parsed.name === "string" ? parsed.name : "app",
      title: typeof parsed.title === "string" ? parsed.title : null,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

export function listInstances(env: NodeJS.ProcessEnv = process.env): Instance[] {
  const dir = instancesDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const live: Instance[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const record = readInstance(file);
    if (!record || !alive(record.pid) || !fs.existsSync(record.socket)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    live.push(record);
  }
  return live.sort((a, b) => b.startedAt - a.startedAt);
}

export function findOwner(tty: string, env: NodeJS.ProcessEnv = process.env): Instance | null {
  return (
    listInstances(env).find(
      (record) => record.tty === tty && record.protocol === PROTOCOL && record.pid !== process.pid,
    ) ?? null
  );
}

// Tells an owner that an app is on its way so the tab shows up before the
// app's electron has booted; the connection stays open for the app's lifetime
// and its close before the app joins means the launch failed.
export function announceGuest(owner: Instance, name: string): { pane: string; end(): void } {
  const pane = randomBytes(8).toString("hex");
  let ended = false;
  let socket: net.Socket | null = null;
  connectPrivately(owner.socket).then(
    (connected) => {
      if (ended) {
        connected.destroy();
        return;
      }
      socket = connected;
      connected.on("error", () => {});
      connected.write(`${JSON.stringify({ type: "announce", pane, name, pid: process.pid })}\n`);
    },
    () => {},
  );
  return {
    pane,
    end: () => {
      ended = true;
      socket?.destroy();
    },
  };
}


function handoffMarker(tty: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(instancesDir(env), `${instanceKey(tty)}.handoff`);
}

export function markHandoff(tty: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    reclaimPrivateDir(instancesDir(env));
    fs.writeFileSync(handoffMarker(tty, env), String(Date.now()), { mode: 0o600 });
  } catch {}
}

export function clearHandoff(tty: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.rmSync(handoffMarker(tty, env), { force: true });
  } catch {}
}


function handoffPending(tty: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return Date.now() - Number(fs.readFileSync(handoffMarker(tty, env), "utf8")) < 20000;
  } catch {
    return false;
  }
}


export async function waitForOwners(tty: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  for (;;) {
    const owner = findOwner(tty, env);
    if (!owner) {
      if (!handoffPending(tty, env)) return;
      await sleep(50);
      continue;
    }
    await connectPrivately(owner.socket).then(
      (socket) =>
        new Promise<void>((resolve) => {
          const done = () => {
            socket.destroy();
            resolve();
          };
          socket.on("error", done);
          socket.on("close", done);
          socket.on("end", done);
        }),
      () => {},
    );
  }
}

export class InstanceRecord {
  private readonly file: string;
  private readonly record: Instance;

  constructor(record: Instance, env: NodeJS.ProcessEnv = process.env) {
    this.record = record;
    this.file = path.join(instancesDir(env), `${instanceKey(record.tty)}.json`);
    reclaimPrivateDir(path.dirname(this.file));
    this.write();
  }

  setTitle(title: string | null) {
    if (this.record.title === title) return;
    this.record.title = title;
    this.write();
  }

  withdraw() {
    fs.rmSync(this.file, { force: true });
  }

  private write() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this.record)}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, this.file);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }
}

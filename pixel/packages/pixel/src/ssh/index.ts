import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";

import { ensurePrivateDir } from "../private-dir";

export interface SshTunnel {
  destination: string;
  controlPath: string;
  stop(): void;
}

export interface RemoteBundle {
  url: string;
  stop(): void;
}

export type StatusLine = (line: string) => void;

export interface SshOptions {
  terminal?: boolean;
}

// A target is only ever [user@]host[:port]: anything else could smuggle ssh
// options (ProxyCommand, -F, -o ...) that run commands or turn off host checks.
// IPv6 literals go in brackets, as in [::1] or user@[fe80::1]:2222.
const TARGET = /^(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?(?:([A-Za-z0-9_][A-Za-z0-9._-]*)|\[([0-9A-Fa-f:.]+)\])(?::(\d{1,5}))?$/;
const DESTINATION = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9._-]*|[0-9A-Fa-f:.]+)$/;

export function parseSshTarget(target: string): { destination: string; sshPort: string | null } {
  const match = TARGET.exec(target);
  const port = match?.[4] ? Number(match[4]) : null;
  const literal = match?.[3];
  if (!match || (port !== null && (port < 1 || port > 65535)) || (literal !== undefined && !net.isIPv6(literal))) {
    // fixme: placeholder copy
    throw new Error(`invalid ssh target ${JSON.stringify(target)} (use host, user@host, user@host:port or user@[ipv6]:port)`);
  }
  return { destination: `${match[1] ? `${match[1]}@` : ""}${match[2] ?? literal}`, sshPort: match[4] ?? null };
}

function isDestination(destination: string): boolean {
  if (!DESTINATION.test(destination)) return false;
  const host = destination.slice(destination.lastIndexOf("@") + 1);
  return !host.includes(":") || net.isIPv6(host);
}

export function validateSshTarget(target: string): void {
  parseSshTarget(target);
}

interface ResolvedTarget {
  destination: string;
  hostArgs: string[];
}

export function resolveSshTarget(target: string): ResolvedTarget {
  const { destination, sshPort } = parseSshTarget(target);
  return { destination, hostArgs: sshPort ? ["-p", sshPort] : [] };
}

// Forwards from the user's ssh config (LocalForward, DynamicForward, ...) would
// open TCP ports any local user can reach, so the connection drops them all and
// the commands that reuse it through the control socket read no config at all,
// and fail rather than connect on their own if the connection is gone.
const NO_FORWARDS = ["-o", "ClearAllForwardings=yes"];
const NO_CONFIG = ["-F", "/dev/null", "-o", "ProxyCommand=false", "-o", "BatchMode=yes", "-o", "ControlMaster=no"];

// ssh runs ProxyCommand=false through $SHELL, which for zsh would source ~/.zshenv;
// plain sh started this way reads no startup files.
function muxEnv(): NodeJS.ProcessEnv {
  const { ENV: _env, BASH_ENV: _bashEnv, ...env } = process.env;
  return { ...env, SHELL: "/bin/sh" };
}

// The only config ssh reads is the user's own ~/.ssh/config, and only when
// nobody else could have written it; a project can't pick another with -F.
// A symlinked config (dotfile managers do this) is followed when the link is
// ours, and ssh is handed the checked real file so the link can't be re-pointed.
export function userSshConfig(home = os.homedir(), uid = process.getuid?.() ?? -1): string {
  const config = path.join(home, ".ssh", "config");
  const safe = (stat: fs.Stats) => stat.isFile() && stat.uid === uid && (stat.mode & 0o022) === 0;
  try {
    const link = fs.lstatSync(config);
    if (!link.isSymbolicLink()) return safe(link) ? config : "/dev/null";
    if (link.uid !== uid) return "/dev/null";
    const real = fs.realpathSync(config);
    return safe(fs.lstatSync(real)) ? real : "/dev/null";
  } catch {
    return "/dev/null";
  }
}

export function sshMasterArgs(
  controlPath: string,
  hostArgs: string[],
  destination: string,
  terminal: boolean,
  config = userSshConfig(),
): string[] {
  return [
    "-F",
    config,
    ...NO_FORWARDS,
    "-o",
    `StrictHostKeyChecking=${terminal ? "ask" : "yes"}`,
    "-o",
    "PermitLocalCommand=no",
    ...(terminal ? [] : ["-o", "BatchMode=yes"]),
    "-f",
    "-N",
    "-M",
    "-S",
    controlPath,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...hostArgs,
    "--",
    destination,
  ];
}

export async function openSshTunnel(
  target: string,
  status: StatusLine,
  options: SshOptions = {},
): Promise<SshTunnel> {
  const terminal = options.terminal ?? true;
  const { destination, hostArgs } = resolveSshTarget(target);
  const dir = privateTunnelDir();
  const controlPath = path.join(dir, "control");
  const args = sshMasterArgs(controlPath, hostArgs, destination, terminal);
  status(`connecting to ${destination}`);
  const stderr: string[] = [];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: terminal ? "inherit" : ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8").trim()));
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    const detail = stderr.filter(Boolean).join("\n");
    throw new Error(`ssh to ${destination} failed${detail ? `: ${detail}` : ""}`);
  }
  const check = spawnSync("ssh", [...NO_CONFIG, "-S", controlPath, "-O", "check", "--", destination], {
    env: muxEnv(),
    stdio: "ignore",
    timeout: 10_000,
  });
  if (check.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`ssh to ${destination} did not stay connected`);
  }
  status(`connected ${destination}`);
  return {
    destination,
    controlPath,
    stop: () => {
      try {
        spawnSync("ssh", [...NO_CONFIG, "-S", controlPath, "-O", "exit", "--", destination], {
          env: muxEnv(),
          stdio: "ignore",
          timeout: 5000,
        });
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface SshSessionOptions extends SshOptions {
  target: string;
  bundle?: string | null;
  remoteBase?: string | null;
  status?: StatusLine;
}

export interface SshSession {
  destination: string;
  controlPath: string;
  url: string | undefined;
  view: { proxy: string; partition: string };
  stop(): void;
}

export async function connectSsh(options: SshSessionOptions): Promise<SshSession> {
  const status = options.status ?? (() => {});
  const terminal = options.terminal ?? true;
  if (options.bundle) validateBundleDir(options.bundle);
  const tunnel = await openSshTunnel(options.target, status, { terminal });
  let bundle: RemoteBundle | null = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    bundle?.stop();
    tunnel.stop();
  };
  process.on("exit", stop);
  if (options.bundle) {
    try {
      bundle = await startBundle(tunnel, path.resolve(options.bundle), {
        status,
        remoteBase: options.remoteBase ?? undefined,
        terminal,
      });
    } catch (error) {
      stop();
      throw error;
    }
  }
  return {
    destination: tunnel.destination,
    controlPath: tunnel.controlPath,
    url: bundle?.url,
    view: {
      proxy: sshProxyRules(tunnel),
      partition: sshPartition(tunnel),
    },
    stop,
  };
}

// Chromium only speaks to proxies over TCP, so this marks traffic for an ssh
// connection; routeThroughProxy puts an authenticated loopback proxy in front.
export const SSH_PROXY_PREFIX = "ssh-mux:";

export interface SshRoute {
  controlPath: string;
  destination: string;
}

// Each ssh connection gets its own browser session, so two windows to the same
// host never share proxy settings, cookies or a proxy port.
export function sshPartition(route: SshRoute): string {
  const connection = path.basename(path.dirname(route.controlPath));
  return `ssh-${route.destination.replace(/[^A-Za-z0-9@._-]/g, "-")}-${connection.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function sshProxyRules(tunnel: SshRoute): string {
  return `${SSH_PROXY_PREFIX}${JSON.stringify({ controlPath: tunnel.controlPath, destination: tunnel.destination })}`;
}

export function parseSshProxyRules(rules: string): SshRoute | null {
  if (!rules.startsWith(SSH_PROXY_PREFIX)) return null;
  try {
    const route = JSON.parse(rules.slice(SSH_PROXY_PREFIX.length)) as Partial<SshRoute>;
    if (typeof route.controlPath !== "string" || typeof route.destination !== "string") return null;
    if (!path.isAbsolute(route.controlPath) || !isDestination(route.destination)) return null;
    return { controlPath: route.controlPath, destination: route.destination };
  } catch {
    return null;
  }
}

const FORWARD_HOST = /^[A-Za-z0-9._~-]+$|^[0-9A-Fa-f:.]+$/;

// One connection to host:port made from the remote machine, carried over the
// existing ssh connection as the stdin and stdout of `ssh -W`.
export function sshForward(route: SshRoute, host: string, port: number): Duplex {
  // fixme: placeholder copy
  if (!FORWARD_HOST.test(host) || host.startsWith("-") || !(port > 0 && port < 65536)) throw new Error(`invalid destination ${host}:${port}`);
  const child = spawn("ssh", [...NO_CONFIG, "-S", route.controlPath, "-W", host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`, "--", route.destination], {
    env: muxEnv(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
  stream.on("error", () => {});
  child.on("error", () => stream.destroy());
  stream.on("close", () => child.kill());
  child.on("exit", () => stream.destroy());
  return stream;
}

export function validateBundleDir(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`bundle ${dir} does not exist`);
  }
  if (!stat.isDirectory()) throw new Error(`bundle ${dir} is not a directory`);
  let start: fs.Stats;
  try {
    start = fs.statSync(path.join(dir, "start"));
  } catch {
    throw new Error(`bundle ${dir} has no start script`);
  }
  if (!start.isFile() || !(start.mode & 0o111)) {
    throw new Error(`bundle ${dir}/start is not executable`);
  }
}

const READY_TIMEOUT_MS = 120_000;

export const REMOTE_BUNDLES_DIR = '${XDG_DATA_HOME:-$HOME/.local/share}/pixel/bundles';

export interface BundleOptions extends SshOptions {
  status: StatusLine;
  remoteBase?: string;
}

export async function startBundle(tunnel: SshTunnel, dir: string, options: BundleOptions): Promise<RemoteBundle> {
  const { status, remoteBase = REMOTE_BUNDLES_DIR, terminal = true } = options;
  validateBundleDir(dir);
  const name = bundleName(dir);
  const remoteDir = `${remoteBase}/${name}-${bundleHash(dir).slice(0, 12)}`;
  if (!installed(tunnel, remoteDir)) {
    status(`installing ${name} on ${tunnel.destination}`);
    upload(tunnel, dir, remoteDir);
    setup(tunnel, remoteDir, terminal, status);
  }
  status(`starting ${name}`);
  return launch(tunnel, name, remoteDir, status);
}

function bundleName(dir: string): string {
  let name = path.basename(dir);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    if (typeof manifest.name === "string" && manifest.name) name = manifest.name;
  } catch {}
  return name.replace(/[^A-Za-z0-9._-]/g, "-");
}

function bundleHash(dir: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (rel: string) => {
    const entries = fs
      .readdirSync(path.join(dir, rel), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(path.join(dir, childRel));
      hash.update(`${childRel}\0${stat.mode & 0o777}\0`);
      hash.update(fs.readFileSync(path.join(dir, childRel)));
      hash.update("\0");
    }
  };
  walk("");
  return hash.digest("hex");
}

function run(
  tunnel: SshTunnel,
  command: string,
  options: { input?: Buffer; stdio?: "inherit" | "ignore" | "pipe"; timeout?: number } = {},
): SpawnSyncReturns<string> {
  return spawnSync("ssh", [...NO_CONFIG, "-S", tunnel.controlPath, "--", tunnel.destination, command], {
    env: muxEnv(),
    input: options.input,
    stdio: options.input ? undefined : options.stdio ?? "ignore",
    timeout: options.timeout,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  });
}

function installed(tunnel: SshTunnel, remoteDir: string): boolean {
  return run(tunnel, `test -f "${remoteDir}/.ready"`).status === 0;
}

function upload(tunnel: SshTunnel, dir: string, remoteDir: string): void {
  const tar = spawnSync("tar", ["-cz", "-C", dir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (tar.status !== 0 || !tar.stdout) throw new Error(`could not pack ${dir}`);
  const result = run(tunnel, `mkdir -p "${remoteDir}" && tar -xz -C "${remoteDir}"`, {
    input: tar.stdout,
  });
  if (result.status !== 0) {
    throw new Error(`could not upload the bundle to ${tunnel.destination}`);
  }
}

function setup(tunnel: SshTunnel, remoteDir: string, terminal: boolean, status: StatusLine): void {
  const result = run(
    tunnel,
    `cd "${remoteDir}" && { [ ! -x ./setup ] || ./setup; } && touch .ready`,
    { stdio: terminal ? "inherit" : "pipe" },
  );
  if (!terminal) {
    for (const line of `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n")) if (line.trim()) status(line);
  }
  if (result.status !== 0) {
    throw new Error(`the bundle's setup script failed on ${tunnel.destination}`);
  }
}

function launch(
  tunnel: SshTunnel,
  name: string,
  remoteDir: string,
  status: StatusLine,
): Promise<RemoteBundle> {
  const tail: string[] = [];
  const child = spawn(
    "ssh",
    [
      ...NO_CONFIG,
      "-tt",
      "-S",
      tunnel.controlPath,
      "--",
      tunnel.destination,
      `cd "${remoteDir}" || exit 9; [ -x ./stop ] && ./stop >/dev/null 2>&1; exec ./start`,
    ],
    { env: muxEnv(), stdio: ["ignore", "pipe", "ignore"] },
  );
  const stop = () => {
    try {
      run(tunnel, `cd "${remoteDir}" && [ -x ./stop ] && ./stop`, { timeout: 10_000 });
    } catch {}
    try {
      child.kill();
    } catch {}
  };
  return new Promise<RemoteBundle>((resolve, reject) => {
    let buffer = "";
    let done = false;
    const finish = (result: RemoteBundle | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (result instanceof Error) {
        stop();
        reject(result);
      } else {
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(`${name} never printed READY <url>\n${tail.join("\n")}`));
    }, READY_TIMEOUT_MS);
    const sawLine = (line: string) => {
      tail.push(line);
      if (tail.length > 20) tail.shift();
      const ready = /^READY\s+(\S+)/.exec(line);
      if (!ready) return;
      const url = pageUrl(ready[1]);
      if (!url) {
        finish(new Error(`${name} printed READY ${ready[1]}, which is not an http(s) url`));
        return;
      }
      status(`${name} is up at ${url}`);
      finish({ url, stop });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        sawLine(line);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (buffer.trim()) sawLine(buffer.trim());
      finish(
        new Error(
          `${name} exited with code ${code} before printing READY <url>\n${tail.join("\n")}`,
        ),
      );
    });
  });
}

function pageUrl(token: string): string | null {
  try {
    const url = new URL(token);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// ssh's control and SOCKS sockets live in a fresh folder inside a per-user
// folder we have checked nobody else can write to.
function privateTunnelDir(env: NodeJS.ProcessEnv = process.env): string {
  const absolute = (value: string | undefined) => (value && path.isAbsolute(value) ? value : null);
  const base = absolute(env.XDG_RUNTIME_DIR) ?? absolute(env.XDG_STATE_HOME) ?? path.join(os.homedir(), ".local", "state");
  return fs.mkdtempSync(path.join(ensurePrivateDir(path.join(base, "pixel", "ssh")), "t-"));
}


import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface SshTunnel {
  destination: string;
  socksPort: number;
  controlPath: string;
  stop(): void;
}

export interface RemoteBundle {
  url: string;
  stop(): void;
}

export function parseSshTarget(target: string): { destination: string; sshPort: string | null } {
  const match = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]+)(:(\d+))?$/.exec(target);
  if (!match) {
    throw new Error(
      `invalid --ssh ${target} (user@host, host, user@host:port, or a shell alias for ssh)`,
    );
  }
  return { destination: `${match[1] ?? ""}${match[2]}`, sshPort: match[4] ?? null };
}

interface ResolvedTarget {
  destination: string;
  hostArgs: string[];
  aliasCommand: string | null;
}

export function resolveSshTarget(target: string): ResolvedTarget {
  const words = target.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return { ...parseSshWords(words, target), aliasCommand: null };
  }
  const single = words[0] ?? "";
  if (!single.includes("@") && !single.includes(":")) {
    const alias = shellAlias(single);
    if (alias) {
      const parsed = parseSshCommand(alias);
      if (parsed) return { ...parsed, aliasCommand: alias.join(" ") };
    }
  }
  const { destination, sshPort } = parseSshTarget(single);
  return { destination, hostArgs: sshPort ? ["-p", sshPort] : [], aliasCommand: null };
}

export function validateSshTarget(target: string): void {
  const words = target.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) parseSshWords(words, target);
  else parseSshTarget(words[0] ?? "");
}

function parseSshWords(
  words: string[],
  target: string,
): { destination: string; hostArgs: string[] } {
  const tokens = words[0] === "ssh" ? words.slice(1) : words;
  const hostArgs: string[] = [];
  let found: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      hostArgs.push(token);
      if (SSH_VALUE_FLAGS.has(token) && i + 1 < tokens.length) hostArgs.push(tokens[++i]);
      continue;
    }
    if (found) {
      throw new Error(`invalid --ssh ${target} (both ${found} and ${token} look like destinations)`);
    }
    found = token;
  }
  if (!found) throw new Error(`invalid --ssh ${target} (no destination)`);
  const { destination, sshPort } = parseSshTarget(found);
  return { destination, hostArgs: [...hostArgs, ...(sshPort ? ["-p", sshPort] : [])] };
}

function shellAlias(name: string): string[] | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const shell = process.env.SHELL ?? "/bin/sh";
  const result = spawnSync(shell, ["-ic", `alias ${name}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const line = result.stdout.trim().split("\n").pop() ?? "";
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  const tokens = unquote(line.slice(eq + 1).trim())
    .split(/\s+/)
    .filter(Boolean);
  if (!/(^|\/)ssh$/.test(tokens[0] ?? "")) return null;
  return tokens.slice(1);
}

function unquote(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll(`'\\''`, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value.replaceAll("\\ ", " ");
}

const SSH_VALUE_FLAGS = new Set(
  "-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -P -p -R -S -W -w".split(" "),
);

function parseSshCommand(tokens: string[]): { destination: string; hostArgs: string[] } | null {
  const hostArgs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      hostArgs.push(token);
      if (SSH_VALUE_FLAGS.has(token) && i + 1 < tokens.length) hostArgs.push(tokens[++i]);
      continue;
    }
    return { destination: token, hostArgs };
  }
  return null;
}

export async function openSshTunnel(
  target: string,
  status: (line: string) => void,
): Promise<SshTunnel> {
  const { destination, hostArgs, aliasCommand } = resolveSshTarget(target);
  if (aliasCommand) status(`${target} is an alias for ssh ${aliasCommand}`);
  const controlPath = freshControlPath();
  const socksPort = await freePort();
  const args = [
    "-f",
    "-N",
    "-M",
    "-S",
    controlPath,
    "-D",
    `127.0.0.1:${socksPort}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...hostArgs,
    destination,
  ];
  status(`connecting to ${destination}`);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`ssh to ${destination} failed`);
  await waitForSocks(socksPort, destination);
  status(`connected ${destination}`);
  return {
    destination,
    socksPort,
    controlPath,
    stop: () => {
      try {
        spawnSync("ssh", ["-S", controlPath, "-O", "exit", destination], {
          stdio: "ignore",
          timeout: 5000,
        });
      } catch {}
    },
  };
}

export function validateBundleDir(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`--ssh-bundle ${dir} does not exist`);
  }
  if (!stat.isDirectory()) throw new Error(`--ssh-bundle ${dir} is not a directory`);
  let start: fs.Stats;
  try {
    start = fs.statSync(path.join(dir, "start"));
  } catch {
    throw new Error(`--ssh-bundle ${dir} has no start script`);
  }
  if (!start.isFile() || !(start.mode & 0o111)) {
    throw new Error(`--ssh-bundle ${dir}/start is not executable`);
  }
}

const READY_TIMEOUT_MS = 120_000;

const REMOTE_BUNDLES_DIR = '${XDG_DATA_HOME:-$HOME/.local/share}/terminal-browser/bundles';

export async function startBundle(
  tunnel: SshTunnel,
  dir: string,
  status: (line: string) => void,
  remoteBase: string = REMOTE_BUNDLES_DIR,
): Promise<RemoteBundle> {
  validateBundleDir(dir);
  const name = bundleName(dir);
  const remoteDir = `${remoteBase}/${name}-${bundleHash(dir).slice(0, 12)}`;
  if (!installed(tunnel, remoteDir)) {
    status(`installing ${name} on ${tunnel.destination}`);
    upload(tunnel, dir, remoteDir);
    setup(tunnel, remoteDir);
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
  options: { input?: Buffer; stdio?: "inherit" | "ignore"; timeout?: number } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("ssh", ["-S", tunnel.controlPath, tunnel.destination, command], {
    input: options.input,
    stdio: options.input ? undefined : options.stdio ?? "ignore",
    timeout: options.timeout,
    maxBuffer: 256 * 1024 * 1024,
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

function setup(tunnel: SshTunnel, remoteDir: string): void {
  const result = run(
    tunnel,
    `cd "${remoteDir}" && { [ ! -x ./setup ] || ./setup; } && touch .ready`,
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`the bundle's setup script failed on ${tunnel.destination}`);
  }
}

function launch(
  tunnel: SshTunnel,
  name: string,
  remoteDir: string,
  status: (line: string) => void,
): Promise<RemoteBundle> {
  const tail: string[] = [];
  const child = spawn(
    "ssh",
    [
      "-tt",
      "-S",
      tunnel.controlPath,
      tunnel.destination,
      `cd "${remoteDir}" || exit 9; [ -x ./stop ] && ./stop >/dev/null 2>&1; exec ./start`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
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

function freshControlPath(): string {
  const name = `${process.pid.toString(36)}-${Date.now().toString(36).slice(-5)}`;
  const dir = path.join(os.tmpdir(), "tb-ssh");
  const candidate = path.join(dir, name);
  if (candidate.length <= 80) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return candidate;
  }
  fs.mkdirSync("/tmp/tb-ssh", { recursive: true, mode: 0o700 });
  return path.join("/tmp/tb-ssh", name);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function waitForSocks(port: number, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the ssh proxy for ${destination} never started listening`));
    }, 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

import { execFile, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { callerTty, detect } from "@zenbu-labs/pixel/terminal";
import type { Terminal } from "@zenbu-labs/pixel/terminal";

export interface BrowserSample {
  pid: number;
  label: string;
  tty: string | null;
  total: number;
  engine: number;
  gpu: number;
  renderer: number;
}

export interface Sample {
  at: number;
  terminal: number;
  browsers: BrowserSample[];
}

export interface TerminalInfo {
  pid: number;
  app: string;
}

interface Instance {
  pid: number;
  label: string;
  tty: string | null;
  helpers: { pid: number; kind: string }[];
}

const REFRESH_INSTANCES_MS = 5000;
const TERMINAL_NAMES = /ghostty|forky|kitty|wezterm|iterm/i;

function ps(args: string[]): string {
  return spawnSync("ps", args, { encoding: "utf8" }).stdout?.trim() ?? "";
}

function psAsync(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("ps", args, { encoding: "utf8" }, (_error, stdout) => resolve((stdout ?? "").trim()));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function findTerminal(): TerminalInfo | null {
  let pid = process.ppid;
  for (let i = 0; i < 16 && pid > 1; i++) {
    const [ppid, ...comm] = ps(["-o", "ppid=,comm=", "-p", String(pid)]).split(/\s+/);
    const name = comm.join(" ");
    if (TERMINAL_NAMES.test(name)) {
      const app = name.match(/\/([^/]+)\.app\//)?.[1] ?? path.basename(name);
      return { pid, app };
    }
    pid = Number(ppid);
    if (!Number.isFinite(pid)) break;
  }
  return null;
}

function readRegistry(): { pid: number; tty: string | null }[] {
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  const dir = path.join(state, "pixel", "instances");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const found: { pid: number; tty: string | null }[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (typeof parsed.pid === "number" && parsed.name === "terminal-browser" && alive(parsed.pid)) {
        found.push({ pid: parsed.pid, tty: typeof parsed.tty === "string" ? path.basename(parsed.tty) : null });
      }
    } catch {}
  }
  return found;
}

function buildLabel(args: string): string {
  const main = args.match(/(\S+)\/browser\/dist\/main\.js/)?.[1];
  if (!main) return "browser";
  if (/\.local\/share\/terminal-browser|Caskroom|\/Applications\//.test(main)) return "installed";
  return path.basename(main);
}

function helperKind(args: string): string {
  const type = args.match(/--type=([a-z-]+)/)?.[1];
  if (type === "gpu-process") return "gpu";
  if (type === "renderer") return "renderer";
  return type ?? "helper";
}

// A browser is launched detached and ends up parented to launchd, so its pane's shell is
// what still leads back to the terminal that owns it.
async function terminalOwningTtys(): Promise<Map<string, number>> {
  const processes = new Map<number, { parent: number; tty: string; name: string }>();
  for (const line of (await psAsync(["-axo", "pid=,ppid=,tty=,comm="])).split("\n")) {
    const parts = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (parts) processes.set(Number(parts[1]), { parent: Number(parts[2]), tty: parts[3], name: parts[4] });
  }
  const owners = new Map<string, number>();
  for (const [pid, { tty }] of processes) {
    if (tty.startsWith("?") || owners.has(tty)) continue;
    for (let at = pid, hops = 0; hops < 32 && processes.has(at); hops++) {
      const { parent, name } = processes.get(at)!;
      if (TERMINAL_NAMES.test(name)) {
        owners.set(tty, at);
        break;
      }
      at = parent;
    }
  }
  return owners;
}

// The ttys sharing this pane's terminal tab, or null when the terminal cannot say.
async function ttysInOwnTab(driver: Terminal | null, ownTty: string | null): Promise<Set<string> | null> {
  if (!driver?.listPanes || !ownTty) return null;
  try {
    const panes = await driver.listPanes({ tty: ownTty });
    const own = panes.find((pane) => pane.tty === ownTty);
    if (!own) return null;
    return new Set(
      panes
        .filter((pane) => pane.tab === own.tab && pane.tty)
        .map((pane) => path.basename(pane.tty!)),
    );
  } catch {
    return null;
  }
}

async function describeInstances(
  terminal: TerminalInfo | null,
  driver: Terminal | null,
  ownTty: string | null,
): Promise<Instance[]> {
  const instances: Instance[] = [];
  const inTab = await ttysInOwnTab(driver, ownTty);
  const owners = inTab || !terminal ? null : await terminalOwningTtys();
  for (const { pid, tty } of readRegistry()) {
    if (inTab && (!tty || !inTab.has(tty))) continue;
    if (owners && (!tty || owners.get(tty) !== terminal!.pid)) continue;
    const args = await psAsync(["-o", "args=", "-p", String(pid)]);
    const childList = await new Promise<number[]>((resolve) => {
      execFile("pgrep", ["-P", String(pid)], { encoding: "utf8" }, (_error, stdout) =>
        resolve(
          (stdout ?? "")
            .split("\n")
            .map(Number)
            .filter((n) => n > 0),
        ),
      );
    });
    const helpers = [];
    for (const child of childList) {
      helpers.push({ pid: child, kind: helperKind(await psAsync(["-o", "args=", "-p", String(child)])) });
    }
    instances.push({ pid, label: buildLabel(args), tty, helpers });
  }
  return instances.sort((a, b) => a.pid - b.pid);
}

/// Streams one CPU sample per second from `top`, attributing helper processes to the
/// browser that owns them. `top -l 0` runs continuously so nothing blocks the UI.
export class Sampler extends EventEmitter {
  private top: ReturnType<typeof spawn> | null = null;
  private buffer = "";
  private instances: Instance[] = [];
  private refreshedAt = 0;
  private first = true;

  private readonly driver = detect(process.env);
  private readonly ownTty = process.env.PIXEL_TTY ?? callerTty().path ?? null;

  constructor(private readonly terminal: TerminalInfo | null) {
    super();
  }

  start(): void {
    void this.refresh();
    this.top = spawn("top", ["-l", "0", "-s", "1", "-stats", "pid,cpu"], { stdio: ["ignore", "pipe", "ignore"] });
    this.top.stdout?.setEncoding("utf8");
    this.top.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let at = this.buffer.indexOf("\nProcesses:", 1);
      while (at !== -1) {
        const block = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        this.consume(block);
        at = this.buffer.indexOf("\nProcesses:", 1);
      }
    });
    this.top.on("exit", () => this.emit("exit"));
  }

  stop(): void {
    this.top?.kill();
    this.top = null;
  }

  private async refresh(): Promise<void> {
    this.refreshedAt = Date.now();
    this.instances = await describeInstances(this.terminal, this.driver, this.ownTty);
  }

  private consume(block: string): void {
    if (this.first) {
      this.first = false;
      return;
    }
    if (Date.now() - this.refreshedAt > REFRESH_INSTANCES_MS) void this.refresh();
    const cpu = new Map<number, number>();
    for (const line of block.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+([\d.]+)/);
      if (m) cpu.set(Number(m[1]), Number(m[2]));
    }
    const at = Date.now();
    const browsers: BrowserSample[] = this.instances.map((instance) => {
      const engine = cpu.get(instance.pid) ?? 0;
      let gpu = 0;
      let renderer = 0;
      let total = engine;
      for (const helper of instance.helpers) {
        const value = cpu.get(helper.pid) ?? 0;
        total += value;
        if (helper.kind === "gpu") gpu += value;
        else if (helper.kind === "renderer") renderer += value;
      }
      return { pid: instance.pid, label: instance.label, tty: instance.tty, total, engine, gpu, renderer };
    });
    const sample: Sample = {
      at,
      terminal: this.terminal ? cpu.get(this.terminal.pid) ?? 0 : 0,
      browsers,
    };
    this.emit("sample", sample);
  }
}

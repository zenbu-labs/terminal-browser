import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Process {
  pid: number;
  ppid: number;
  cpu: number;
  memoryPercent: number;
  rssBytes: number;
  state: string;
  elapsed: string;
  user: string;
  name: string;
  executable: string;
}

export interface Snapshot {
  at: number;
  cpu: number;
  cores: number[];
  memoryUsed: number;
  memoryTotal: number;
  load: [number, number, number];
  processes: Process[];
}

export async function listProcesses(): Promise<Process[]> {
  const { stdout } = await run(
    "ps",
    ["-A", "-o", "pid=,ppid=,pcpu=,pmem=,rss=,state=,etime=,user=,comm="],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const processes: Process[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) continue;
    const [pid, ppid, cpu, mem, rss, state, elapsed, user, ...command] = fields;
    const executable = command.join(" ");
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      cpu: Number(cpu),
      memoryPercent: Number(mem),
      rssBytes: Number(rss) * 1024,
      state,
      elapsed,
      user,
      name: path.basename(executable),
      executable,
    });
  }
  return processes;
}

export async function commandLine(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run("ps", ["-o", "args=", "-p", String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function darwinMemoryUsed(): Promise<number> {
  const { stdout } = await run("vm_stat");
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096);
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
  const app = pages("Anonymous pages") - pages("Pages purgeable");
  return (app + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize;
}

async function linuxMemoryUsed(): Promise<number> {
  const meminfo = await fs.readFile("/proc/meminfo", "utf8");
  const kib = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(meminfo)?.[1] ?? 0) * 1024;
  return kib("MemTotal") - kib("MemAvailable");
}

function memoryUsed(): Promise<number> {
  return process.platform === "darwin" ? darwinMemoryUsed() : linuxMemoryUsed();
}

interface CoreTimes {
  busy: number;
  total: number;
}

function coreTimes(): CoreTimes[] {
  return os.cpus().map(({ times }) => {
    const busy = times.user + times.nice + times.sys + times.irq;
    return { busy, total: busy + times.idle };
  });
}

export class Sampler {
  private previous = coreTimes();

  async sample(): Promise<Snapshot> {
    const [processes, used] = await Promise.all([listProcesses(), memoryUsed()]);
    const current = coreTimes();
    const cores = current.map((now, i) => {
      const before = this.previous[i] ?? now;
      const total = now.total - before.total;
      return total > 0 ? ((now.busy - before.busy) / total) * 100 : 0;
    });
    this.previous = current;
    const load = os.loadavg();
    return {
      at: Date.now(),
      cpu: cores.reduce((sum, core) => sum + core, 0) / Math.max(1, cores.length),
      cores,
      memoryUsed: used,
      memoryTotal: os.totalmem(),
      load: [load[0], load[1], load[2]],
      processes,
    };
  }
}

export interface ProcessInfo {
  parent: number;
  tty: string;
  command: string;
}

export const PROCESS_LIST_ARGS = ["-axo", "pid=,ppid=,tty=,comm="];

export function parseProcesses(listing: string): Map<number, ProcessInfo> {
  const processes = new Map<number, ProcessInfo>();
  for (const line of listing.split("\n")) {
    const parts = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (parts) processes.set(Number(parts[1]), { parent: Number(parts[2]), tty: parts[3], command: parts[4] });
  }
  return processes;
}

export function ancestry(start: number, processes: Map<number, ProcessInfo>): number[] {
  const chain: number[] = [];
  for (let pid = start; processes.has(pid) && !chain.includes(pid) && chain.length < 64; ) {
    chain.push(pid);
    pid = processes.get(pid)!.parent;
  }
  return chain;
}

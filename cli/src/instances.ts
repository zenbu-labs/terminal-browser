import type { Backend, Direction, Pane } from "pixel-terminals";

import { control } from "./control";
import { instances } from "./registry";
import type { InstanceRecord } from "./registry";

export interface TabTarget {
  id: number;
  url: string;
  title: string;
  active: boolean;
  targetId: string | null;
  timeOrigin?: number | null;
}

export interface Browser extends InstanceRecord {
  window: string | null;
  tab: string | null;
  pane: string | null;
  inCurrentTab: boolean;
}

const TITLE_PATTERN = /terminal-browser:([\w-]+)/;

export function recordKey(record: InstanceRecord): string {
  return record.key ?? String(record.pid);
}

export function locate(records: InstanceRecord[], panes: Pane[]): Browser[] {
  const self = panes.find((pane) => pane.self);
  const byKey = new Map<string, Pane>();
  for (const pane of panes) {
    const match = TITLE_PATTERN.exec(pane.title);
    if (match) byKey.set(match[1], pane);
  }
  return records.map((record) => {
    const pane =
      (record.tty7Pane === null
        ? undefined
        : panes.find((candidate) => candidate.pane === String(record.tty7Pane))) ??
      byKey.get(recordKey(record));
    return {
      ...record,
      window: pane?.window ?? null,
      tab: pane?.tab ?? null,
      pane: pane?.pane ?? null,
      inCurrentTab:
        !!pane && !!self && pane.window === self.window && pane.tab === self.tab,
    };
  });
}

export function reusable(
  found: Browser[],
  direction: Direction | null,
  tty: string | null,
): Browser | undefined {
  const here = found.filter((browser) => browser.inCurrentTab);
  const candidates = direction ? here.filter((browser) => browser.splitDir === direction) : here;
  return candidates.find((browser) => tty !== null && browser.parentTty === tty) ?? candidates[0];
}

export async function browsers(backend: Backend): Promise<Browser[]> {
  return locate(await instances(), await backend.panes());
}

export async function targets(browser: Browser): Promise<TabTarget[]> {
  const reply = (await control(browser.socket, { cmd: "targets" })) as { tabs?: TabTarget[] };
  return reply.tabs ?? [];
}

export function describe(browser: Browser): string {
  const where = browser.window ? `${browser.window}:${browser.tab}:${browser.pane}` : "no pane";
  return `${recordKey(browser)} (${where}) ${browser.url}`;
}

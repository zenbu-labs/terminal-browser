import { callerTty } from "pixel-terminals";
import type { Direction, Pane, Terminal } from "pixel-terminals";

import { control } from "./control";
import { instances } from "./registry";
import type { InstanceRecord } from "./registry";

export interface TabTarget {
  id: number;
  url: string;
  title: string;
  active: boolean;
  targetId: string | null;
  app?: { name: string | null; id: string } | null;
  timeOrigin?: number | null;
}

export interface Browser extends InstanceRecord {
  pane: string | null;
  paneTab: string | null;
  inCurrentTab: boolean;
}

export function recordKey(record: InstanceRecord): string {
  return record.key ?? String(record.pid);
}

export interface Where {
  terminal: string | null;
  tab: string | null;
  pane: string | null;
}

export async function asked(records: InstanceRecord[]): Promise<Map<string, Where>> {
  const answers = await Promise.all(
    records.map(async (record) => {
      const where = await control(record.socket, { cmd: "where" }, 2000).catch(() => null);
      return [recordKey(record), where as Where | null] as const;
    }),
  );
  return new Map(
    answers.filter((entry): entry is [string, Where] => entry[1] !== null),
  );
}

export function locate(
  records: InstanceRecord[],
  current: Pane | null,
  terminalName: string | null,
  answers: Map<string, Where> = new Map(),
): Browser[] {
  return records.map((record) => {
    const said = answers.get(recordKey(record));
    const claimed = said?.terminal === terminalName ? said : null;
    const pane = claimed?.pane ?? null;
    const paneTab = claimed?.tab ?? null;
    return {
      ...record,
      pane,
      paneTab,
      inCurrentTab: !!paneTab && !!current && paneTab === current.tab,
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

export async function browsers(terminal: Terminal | null): Promise<Browser[]> {
  const current = (await terminal?.getCurrentPane?.({ tty: callerTty().path, cwd: process.cwd() })) ?? null;
  const records = await instances();
  return locate(records, current, terminal?.name ?? null, await asked(records));
}

export async function targets(browser: Browser): Promise<TabTarget[]> {
  const reply = (await control(browser.socket, { cmd: "targets" })) as { tabs?: TabTarget[] };
  return reply.tabs ?? [];
}

export function describe(browser: Browser): string {
  const where = browser.pane ? `${browser.paneTab}:${browser.pane}` : "no pane";
  return `${recordKey(browser)} (${where}) ${browser.url}`;
}


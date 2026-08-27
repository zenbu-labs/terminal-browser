import { callerTty } from "pixel-terminals";
import type { Terminal } from "pixel-terminals";

import { browsers, recordKey, targets } from "./instances";
import type { Browser, TabTarget } from "./instances";

interface Listed {
  key: string;
  pid: number;
  cdpPort: number | null;
  socket: string;
  tty: string | null;
  pane: { tab: string | null; pane: string | null };
  splitDir: Browser["splitDir"];
  parentTty: string | null;
  inCurrentTab: boolean;
  viewport: { width: number; height: number } | null;
  tabs: TabTarget[];
}

async function collect(list: Browser[]): Promise<Listed[]> {
  return Promise.all(
    list.map(async (browser) => ({
      key: recordKey(browser),
      pid: browser.pid,
      cdpPort: browser.cdpPort,
      socket: browser.socket,
      tty: browser.tty,
      pane: { tab: browser.paneTab, pane: browser.pane },
      splitDir: browser.splitDir,
      parentTty: browser.parentTty,
      inCurrentTab: browser.inCurrentTab,
      viewport: browser.viewport,
      tabs: await targets(browser).catch(() => []),
    })),
  );
}

function render(list: Listed[]): string {
  if (list.length === 0) return "no terminal browsers running\n";
  const lines: string[] = [];
  for (const browser of list) {
    const where = browser.pane.pane ? `${browser.pane.tab}:${browser.pane.pane}` : "no pane";
    lines.push(`${browser.key}  ${where}${browser.inCurrentTab ? "  (this tab)" : ""}`);
    for (const tab of browser.tabs) {
      const mark = tab.active ? "*" : " ";
      const page = tab.title || tab.url;
      const label = tab.app ? `${tab.app.name ?? page} (app)` : page;
      lines.push(`  ${mark} ${tab.id}  ${label}`);
      lines.push(`      ${tab.url}`);
      lines.push(`      target ${tab.targetId ?? "pending"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function lsCommand(terminal: Terminal | null, all: boolean, json: boolean) {
  const found = await browsers(terminal);
  const scoped = all ? found : found.filter((browser) => browser.inCurrentTab);
  const list = await collect(scoped);
  if (!json) {
    process.stdout.write(render(list));
    if (!all && found.length > list.length) {
      process.stdout.write(`\n${found.length - list.length} more elsewhere — terminal-browser ls --all\n`);
    }
    return;
  }
  const self = (await terminal?.getCurrentPane?.({ tty: callerTty().path, cwd: process.cwd() })) ?? null;
  process.stdout.write(
    `${JSON.stringify(
      { self: self ? { tab: self.tab, pane: self.id } : null, browsers: list },
      null,
      2,
    )}\n`,
  );
}

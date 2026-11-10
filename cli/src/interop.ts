import { callerTty } from "@zenbu-labs/pixel/terminal";
import type { Terminal } from "@zenbu-labs/pixel/terminal";
import { INTEROP_PROTOCOL_VERSIONS, listInteropInstances } from "shared";
import type { InteropInstance, OpenSpec } from "shared";

import { control, WHERE_TIMEOUT_MS } from "./control";

export type Host = InteropInstance & { pane: string | null };

export async function findHosts(terminal: Terminal | null): Promise<Host[]> {
  const records = listInteropInstances().filter((record) =>
    record.protocolVersions.some((version) => INTEROP_PROTOCOL_VERSIONS.includes(version)),
  );
  const target = process.env.TERMINAL_BROWSER_INTEROP_TARGET;
  if (target) return records.filter((record) => record.socket === target).map((record) => ({ ...record, pane: null }));
  // pane discovery writes to the caller's tty and can be slow, so never run
  // it with nothing to match against
  if (records.length === 0 || !terminal) return [];
  const current = await terminal
    .getCurrentPane?.({ tty: callerTty().path, cwd: process.cwd() })
    .catch(() => null);
  if (!current) return [];
  const answers = await Promise.all(
    records.map(async (record) => {
      const where = (await control(record.socket, { cmd: "where" }, WHERE_TIMEOUT_MS).catch(() => null)) as {
        terminal: string | null;
        tab: string | null;
        pane: string | null;
      } | null;
      if (!where || where.terminal !== terminal.name) return null;
      if (!where.tab || where.tab !== current.tab) return null;
      return { ...record, pane: where.pane ?? null };
    }),
  );
  return answers
    .filter((record): record is Host => record !== null)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function openInHost(socket: string, spec: OpenSpec): Promise<{ tab: number }> {
  return control(socket, { cmd: "interop/1/open", ...spec }) as Promise<{ tab: number }>;
}

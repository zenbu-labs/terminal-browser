import { randomUUID } from "node:crypto";
import net from "node:net";

import { callerTty } from "pixel-terminals";
import type { Terminal } from "pixel-terminals";
import { INTEROP_PROTOCOL_VERSIONS, listInteropInstances } from "pixel-store";
import type { InteropInstance, OpenResult, OpenSpec } from "pixel-store";

import { control } from "./control";

export async function findHosts(terminal: Terminal | null): Promise<InteropInstance[]> {
  const records = listInteropInstances().filter((record) =>
    record.protocolVersions.some((version) => INTEROP_PROTOCOL_VERSIONS.includes(version)),
  );
  const target = process.env.TERMINAL_BROWSER_INTEROP_TARGET;
  if (target) return records.filter((record) => record.socket === target);
  if (records.length === 0 || !terminal) return [];
  const current = await terminal
    .getCurrentPane?.({ tty: callerTty().path, cwd: process.cwd() })
    .catch(() => null);
  if (!current) return [];
  const answers = await Promise.all(
    records.map(async (record) => {
      const where = (await control(record.socket, { cmd: "where" }, 2000).catch(() => null)) as {
        terminal: string | null;
        tab: string | null;
      } | null;
      if (!where || where.terminal !== terminal.name) return null;
      if (!where.tab || where.tab !== current.tab) return null;
      return record;
    }),
  );
  return answers
    .filter((record): record is InteropInstance => record !== null)
    .sort((a, b) =>
      a.mode === b.mode ? b.startedAt - a.startedAt : a.mode === "browser" ? -1 : 1,
    );
}

export function openUrlInHost(socket: string, url: string | undefined): Promise<{ tab: number }> {
  return control(socket, { cmd: "interop/1/open", url }) as Promise<{ tab: number }>;
}

export interface AppAttachment {
  result: OpenResult;
  closed: Promise<{ reason: string }>;
  close(): void;
}

export function openAppInHost(
  socket: string,
  spec: OpenSpec,
  timeoutMs = 15_000,
): Promise<AppAttachment> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    let buffer = "";
    let settled = false;
    let closedResolve!: (value: { reason: string }) => void;
    const closed = new Promise<{ reason: string }>((res) => (closedResolve = res));
    const timer = setTimeout(() => {
      if (settled) return;
      connection.destroy();
      reject(new Error("open timed out"));
    }, timeoutMs);
    connection.setEncoding("utf8");
    connection.on("error", (error) => {
      if (!settled) {
        clearTimeout(timer);
        reject(error);
      } else closedResolve({ reason: "connection lost" });
    });
    connection.on("close", () => {
      if (settled) closedResolve({ reason: "closed" });
    });
    const id = randomUUID();
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let message: {
          id?: string | null;
          ok?: boolean;
          data?: OpenResult;
          error?: string;
          event?: string;
          reason?: string;
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (message.ok && message.data && message.id === id) {
            resolve({ result: message.data, closed, close: () => connection.destroy() });
          } else {
            connection.destroy();
            reject(new Error(message.error ?? "open failed"));
          }
        } else if (message.event === "app-closed" && message.id === id) {
          closedResolve({ reason: message.reason ?? "closed" });
          connection.destroy();
        }
      }
    });
    connection.write(`${JSON.stringify({ id, cmd: "interop/1/open", ...spec })}\n`);
  });
}

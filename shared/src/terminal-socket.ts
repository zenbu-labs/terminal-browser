import { randomUUID } from "node:crypto";
import net from "node:net";

import { z } from "zod";

import type {
  Direction,
  ListPanesOptions,
  Pane,
  PaneContext,
  PaneDetails,
  SplitRequest,
  Terminal,
} from "@zenbu-labs/pixel/terminal";

export const TERMINAL_SOCKET_ENV = "TERMINAL_BROWSER_TERMINAL_SOCKET";

export const TERMINAL_SOCKET_PROTOCOL = 1;

const REQUEST_TIMEOUT_MS = 8000;

const paneSchema = z.object({ id: z.string(), tab: z.string() });

const paneDetailsSchema = paneSchema.extend({
  tty: z.string().nullable(),
  command: z.string().nullable(),
});

const replySchema = z.object({
  id: z.string(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const OPERATIONS = ["getCurrentPane", "split", "listPanes", "neighbor", "sendText", "pasteKey", "focusPane"] as const;

const RESULTS = {
  hello: z.object({ name: z.string(), methods: z.array(z.string()) }),
  getCurrentPane: z.object({ pane: paneSchema.nullable() }),
  split: z.object({}),
  listPanes: z.object({ panes: z.array(paneDetailsSchema) }),
  neighbor: z.object({ pane: paneSchema.nullable() }),
  sendText: z.object({}),
  pasteKey: z.object({}),
  focusPane: z.object({}),
};

type Method = keyof typeof RESULTS;

function readLine(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socketPath);
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error(`terminal at ${socketPath} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new Error(`nothing is listening at ${socketPath} (${TERMINAL_SOCKET_ENV})`)
          : error,
      );
    });
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      connection.destroy();
      resolve(buffer.slice(0, newline));
    });
    connection.on("connect", () => connection.write(`${line}\n`));
  });
}

async function call<M extends Method>(
  socketPath: string,
  method: M,
  params: Record<string, unknown>,
): Promise<z.infer<(typeof RESULTS)[M]>> {
  const id = randomUUID();
  const request = { id, method, params, caller: { pid: process.pid, cwd: process.cwd() } };
  const line = await readLine(socketPath, JSON.stringify(request));
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`terminal answered ${method} with something that is not json`);
  }
  const reply = replySchema.safeParse(parsed);
  if (!reply.success) throw new Error(`terminal answered ${method} without an id`);
  if (reply.data.id !== id) throw new Error(`terminal answered ${method} with the wrong id`);
  if (reply.data.error) throw new Error(reply.data.error.message);
  const result = RESULTS[method].safeParse(reply.data.result);
  if (!result.success) throw new Error(`terminal answered ${method} with an unexpected result`);
  return result.data as z.infer<(typeof RESULTS)[M]>;
}

export function socketTerminal(socketPath: string): Terminal {
  let name = "socket";
  const greeted = call(socketPath, "hello", { protocol: TERMINAL_SOCKET_PROTOCOL }).then((hello) => {
    name = hello.name;
    for (const operation of OPERATIONS) {
      if (!hello.methods.includes(operation)) delete terminal[operation];
    }
  });
  greeted.catch(() => {});
  const terminal: Terminal = {
    get name() {
      return name;
    },
    prepare: () => greeted,
    async getCurrentPane(context: PaneContext): Promise<Pane | null> {
      return (await call(socketPath, "getCurrentPane", { tty: context.tty, cwd: context.cwd })).pane;
    },
    async split(request: SplitRequest): Promise<void> {
      await call(socketPath, "split", { ...request });
    },
    async listPanes(options?: ListPanesOptions): Promise<PaneDetails[]> {
      return (await call(socketPath, "listPanes", { tty: options?.tty ?? null })).panes;
    },
    async neighbor(from: Pane, direction: Direction): Promise<Pane | null> {
      return (await call(socketPath, "neighbor", { from, direction })).pane;
    },
    async sendText(pane: string, text: string): Promise<void> {
      await call(socketPath, "sendText", { pane, text });
    },
    async pasteKey(pane: string): Promise<void> {
      await call(socketPath, "pasteKey", { pane });
    },
    async focusPane(pane: string): Promise<void> {
      await call(socketPath, "focusPane", { pane });
    },
  };
  return terminal;
}

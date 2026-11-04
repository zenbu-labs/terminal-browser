import type { Duplex } from "node:stream";

import { refusal, scrubEvent } from "./policy";
import { DEFAULT_LIMITS } from "./websocket";
import type { CdpLimits, MessageSocket } from "./websocket";

interface Client {
  socket: MessageSocket;
  root: string | null;
  waiting: string[];
  waitingBytes: number;
  pending: number;
  sessions: Set<string>;
}

interface Pending {
  client: Client | null;
  id: number;
  method: string;
  sessionId: string | undefined;
  resolve?: (message: PipeMessage) => void;
}

interface PipeMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

const ATTACHING_METHODS = new Set(["Target.attachToTarget", "Target.attachToBrowserTarget"]);

// Shares Chromium's one debugging pipe between many clients. Each client gets
// its own browser-level session and can only talk to sessions it opened.
export class CdpRelay {
  private nextId = 1;
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private skippingOversized = false;
  private readonly paused = new Set<Client>();
  private readonly pending = new Map<number, Pending>();
  private readonly owners = new Map<string, Client>();
  private readonly clients = new Set<Client>();

  constructor(
    private readonly pipe: Duplex,
    private readonly limits: CdpLimits = DEFAULT_LIMITS,
  ) {
    pipe.on("data", (chunk: Buffer) => this.receive(chunk));
    pipe.on("drain", () => {
      for (const client of this.paused) client.socket.resume();
      this.paused.clear();
    });
    pipe.on("close", () => {
      for (const client of [...this.clients]) client.socket.close();
    });
    pipe.on("error", () => {});
  }

  connect(socket: MessageSocket): void {
    const client: Client = { socket, root: null, waiting: [], waitingBytes: 0, pending: 0, sessions: new Set() };
    this.clients.add(client);
    socket.onMessage((text) => this.fromClient(client, text));
    socket.onClose(() => this.disconnect(client));
    this.call("Target.attachToBrowserTarget", {}, undefined, (reply) => {
      const sessionId = reply.result?.sessionId;
      if (typeof sessionId !== "string" || !this.clients.has(client)) {
        if (typeof sessionId === "string") this.call("Target.detachFromTarget", { sessionId });
        socket.close();
        return;
      }
      client.root = sessionId;
      this.own(client, sessionId);
      client.waitingBytes = 0;
      for (const text of client.waiting.splice(0)) this.fromClient(client, text);
    });
  }

  private disconnect(client: Client) {
    if (!this.clients.delete(client)) return;
    this.paused.delete(client);
    for (const [id, pending] of this.pending) if (pending.client === client) this.pending.delete(id);
    const children = [...client.sessions].filter((sessionId) => sessionId !== client.root);
    for (const sessionId of children) this.call("Target.detachFromTarget", { sessionId }, client.root ?? undefined);
    if (client.root) this.call("Target.detachFromTarget", { sessionId: client.root });
    for (const sessionId of client.sessions) this.owners.delete(sessionId);
    client.sessions.clear();
  }

  private own(client: Client, sessionId: string) {
    if (this.owners.has(sessionId)) return;
    this.owners.set(sessionId, client);
    client.sessions.add(sessionId);
  }

  private disown(sessionId: string) {
    const client = this.owners.get(sessionId);
    if (!client) return;
    this.owners.delete(sessionId);
    client.sessions.delete(sessionId);
    if (sessionId === client.root) client.socket.close();
  }

  private call(method: string, params: object, sessionId?: string, resolve?: (message: PipeMessage) => void) {
    const id = this.nextId++;
    this.pending.set(id, { client: null, id, method, sessionId, resolve });
    this.write({ id, method, params, ...(sessionId ? { sessionId } : {}) });
  }

  private write(message: object): boolean {
    return this.pipe.write(`${JSON.stringify(message)}\0`);
  }

  private fromClient(client: Client, text: string) {
    if (!client.root) {
      client.waitingBytes += text.length;
      if (client.waitingBytes > this.limits.maxMessageBytes) {
        client.socket.close();
        return;
      }
      client.waiting.push(text);
      return;
    }
    let message: PipeMessage;
    try {
      message = JSON.parse(text) as PipeMessage;
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const { id, method } = message;
    if (typeof id !== "number" || typeof method !== "string") return;
    const sessionId = message.sessionId ?? client.root;
    if (typeof sessionId !== "string" || this.owners.get(sessionId) !== client) {
      const reply: PipeMessage = { id, error: { code: -32001, message: "Session with given id not found." } };
      if (message.sessionId !== undefined) reply.sessionId = message.sessionId;
      client.socket.send(JSON.stringify(reply));
      return;
    }
    const refused = refusal(method, message.params);
    if (refused) {
      const reply: PipeMessage = { id, error: { code: -32000, message: refused } };
      if (message.sessionId !== undefined) reply.sessionId = message.sessionId;
      client.socket.send(JSON.stringify(reply));
      return;
    }
    const pipeId = this.nextId++;
    if (client.pending >= this.limits.maxPending) {
      client.socket.close();
      return;
    }
    client.pending++;
    this.pending.set(pipeId, { client, id, method, sessionId });
    if (!this.write({ ...message, id: pipeId, sessionId })) {
      client.socket.pause();
      this.paused.add(client);
    }
  }

  // Only the new chunk is searched for the NUL separator, and a message is
  // joined once, so cost stays linear in its size.
  private receive(chunk: Buffer) {
    let start = 0;
    let end = chunk.indexOf(0);
    while (end !== -1) {
      const tail = chunk.subarray(start, end);
      if (this.skippingOversized || this.partialBytes + tail.length > this.limits.maxMessageBytes) {
        this.skippingOversized = false;
      } else {
        const whole = this.partial.length === 0 ? tail : Buffer.concat([...this.partial, tail]);
        try {
          this.fromPipe(JSON.parse(whole.toString("utf8")) as PipeMessage);
        } catch {}
      }
      this.partial = [];
      this.partialBytes = 0;
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    const rest = chunk.subarray(start);
    if (rest.length === 0 || this.skippingOversized) return;
    if (this.partialBytes + rest.length > this.limits.maxMessageBytes) {
      process.stderr.write(`terminal-browser cdp: dropped a message over ${this.limits.maxMessageBytes} bytes\n`);
      this.partial = [];
      this.partialBytes = 0;
      this.skippingOversized = true;
      return;
    }
    this.partial.push(rest);
    this.partialBytes += rest.length;
  }

  private fromPipe(message: PipeMessage) {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending || message.sessionId !== pending.sessionId) return;
      this.pending.delete(message.id);
      if (pending.client) pending.client.pending--;
      if (!pending.client) {
        pending.resolve?.(message);
        return;
      }
      const attached = message.result?.sessionId;
      if (ATTACHING_METHODS.has(pending.method) && typeof attached === "string") this.own(pending.client, attached);
      this.deliver(pending.client, { ...message, id: pending.id });
      return;
    }

    const sessionId = message.sessionId;
    if (sessionId === undefined) {
      const detached = message.params?.sessionId;
      if (message.method === "Target.detachedFromTarget" && typeof detached === "string") this.disown(detached);
      return;
    }
    const client = this.owners.get(sessionId);
    if (!client) return;
    const child = message.params?.sessionId;
    if (message.method === "Target.attachedToTarget" && typeof child === "string") this.own(client, child);
    this.deliver(client, scrubEvent(message));
    if (message.method === "Target.detachedFromTarget" && typeof child === "string") this.disown(child);
  }

  private deliver(client: Client, message: PipeMessage) {
    if (message.sessionId === client.root) {
      const { sessionId: _root, ...rest } = message;
      client.socket.send(JSON.stringify(rest));
      return;
    }
    client.socket.send(JSON.stringify(message));
  }
}

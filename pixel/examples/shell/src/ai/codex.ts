import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import readline from "node:readline";

import { COMMAND_FIELD_DESCRIPTION, SYSTEM_PROMPT, TurnSession, WRITE_COMMAND_DESCRIPTION, WRITE_COMMAND_RESULT } from "./turn";
import type { AiEvents, AiSession } from "./turn";
import { codexModels } from "./models";
import type { AiChoice, CodexModel, HarnessModels } from "./models";

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
}

interface ServerHandlers {
  notification(method: string, params: any): void;
  request(method: string, params: any): unknown;
  exit(): void;
}

class AppServer {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private nextId = 0;
  private exited = false;
  private readonly kill = () => this.child.kill();

  constructor(executable: string, cwd: string, private readonly handlers: ServerHandlers) {
    this.child = spawn(executable, ["app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    process.once("exit", this.kill);
    this.child.on("error", () => this.ended());
    this.child.on("exit", () => this.ended());
    this.child.stdin!.on("error", () => {});
    readline.createInterface({ input: this.child.stdout! }).on("line", (line) => this.receive(line));
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "pxsh", title: "pxsh", version: "1.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.send({ method: "initialized" });
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    // fixme: placeholder copy
    if (this.exited) return Promise.reject(new Error("codex app-server is not running"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  close(): void {
    process.off("exit", this.kill);
    this.kill();
  }

  private send(message: RpcMessage): void {
    if (!this.exited) this.child.stdin!.write(JSON.stringify(message) + "\n");
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method == null) {
      const waiting = this.pending.get(Number(message.id));
      this.pending.delete(Number(message.id));
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    } else if (message.id != null) {
      const id = message.id;
      Promise.resolve()
        .then(() => this.handlers.request(message.method!, message.params))
        .then(
          (result) => this.send({ id, result }),
          (error: unknown) => this.send({ id, error: { message: error instanceof Error ? error.message : String(error) } }),
        );
    } else {
      this.handlers.notification(message.method, message.params);
    }
  }

  private ended(): void {
    if (this.exited) return;
    this.exited = true;
    process.off("exit", this.kill);
    for (const waiting of this.pending.values()) waiting.reject(new Error("codex app-server exited"));
    this.pending.clear();
    this.handlers.exit();
  }
}

async function readModels(server: AppServer): Promise<HarnessModels> {
  const account = await server.request<{ account: unknown; requiresOpenaiAuth: boolean }>("account/read", { refreshToken: false });
  const models: CodexModel[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: CodexModel[]; nextCursor: string | null } = await server.request("model/list", { cursor });
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return { models: codexModels(models), signedIn: account.account != null || !account.requiresOpenaiAuth };
}

export async function listCodexModels(executable: string): Promise<HarnessModels | null> {
  const server = new AppServer(executable, process.cwd(), { notification() {}, request: () => Promise.reject(new Error("unsupported")), exit() {} });
  try {
    await server.initialize();
    return await readModels(server);
  } catch {
    return null;
  } finally {
    server.close();
  }
}

const WRITE_COMMAND_TOOL = {
  type: "function",
  name: "write_command",
  description: WRITE_COMMAND_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: { command: { type: "string", description: COMMAND_FIELD_DESCRIPTION } },
    required: ["command"],
    additionalProperties: false,
  },
};

export class CodexSession extends TurnSession implements AiSession {
  private readonly server: AppServer;
  private readonly ready: Promise<{ threadId: string; models: HarnessModels | null }>;
  private turnId: string | null = null;
  private stopWanted = false;
  private lastError: string | null = null;
  private closed = false;

  constructor(
    events: AiEvents,
    private choice: AiChoice,
    executable: string,
    cwd: string,
  ) {
    super(events);
    this.server = new AppServer(executable, cwd, {
      notification: (method, params) => this.notification(method, params),
      request: (method, params) => this.request(method, params),
      exit: () => {
        if (!this.closed) this.fail("codex app-server exited");
      },
    });
    this.ready = this.start(cwd);
    this.ready.catch((error: unknown) => {
      if (!this.closed) this.events.failed(error instanceof Error ? error.message : String(error));
    });
  }

  private async start(cwd: string) {
    await this.server.initialize();
    const models = readModels(this.server).then(
      (found) => {
        this.events.models("codex", found);
        return found;
      },
      () => null,
    );
    const { thread } = await this.server.request<{ thread: { id: string } }>("thread/start", {
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      developerInstructions: SYSTEM_PROMPT,
      dynamicTools: [WRITE_COMMAND_TOOL],
    });
    return { threadId: thread.id, models: await models };
  }

  setChoice(choice: AiChoice): void {
    this.choice = choice;
  }

  protected next(): void {
    if (this.turn !== "idle" || this.closed) return;
    const text = this.inbox.shift();
    if (text == null) return;
    this.turn = "running";
    this.stopWanted = false;
    void this.startTurn(text);
  }

  private async startTurn(text: string): Promise<void> {
    try {
      const { threadId, models } = await this.ready;
      // fixme: placeholder copy
      if (models && !models.signedIn) return this.fail("Codex is not signed in. Run codex login");
      const { model, effort, fast } = this.choice;
      const tier = fast ? models?.models.find((m) => m.id === model)?.fastTier : null;
      const { turn } = await this.server.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        model,
        effort,
        serviceTier: tier ?? "default",
      });
      if (this.turn === "idle") return;
      this.turnId = turn.id;
      if (this.stopWanted) void this.interrupt();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private fail(message: string): void {
    const wasRunning = this.turn === "running";
    this.turn = "idle";
    this.turnId = null;
    this.events.failed(message);
    if (wasRunning) {
      this.events.status(null);
      this.events.done();
    }
  }

  private async interrupt(): Promise<void> {
    const { threadId } = await this.ready;
    if (this.turnId) await this.server.request("turn/interrupt", { threadId, turnId: this.turnId }).catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.turn === "finishing") return this.dropQueued();
    if (this.turn !== "running") return;
    this.stopWanted = true;
    await this.interrupt();
  }

  close(): void {
    this.closed = true;
    this.server.close();
  }

  private notification(method: string, params: any): void {
    if (method === "item/agentMessage/delta") {
      if (this.turn === "running") this.events.text(params.delta);
    } else if (method === "item/started" && this.turn === "running") {
      const item = params.item;
      // fixme: placeholder copy
      if (item.type === "commandExecution") this.events.status(`Running ${item.command}`);
      // fixme: placeholder copy
      else if (item.type === "reasoning") this.events.status("Thinking");
    } else if (method === "item/completed" && this.turn === "running" && params.item.type !== "agentMessage") {
      this.events.status(null);
    } else if (method === "error" && !params.willRetry) {
      this.lastError = params.error?.message ?? null;
    } else if (method === "turn/completed") {
      const wasRunning = this.turn === "running";
      const { turn } = params;
      this.turn = "idle";
      this.turnId = null;
      if (wasRunning) {
        this.events.status(null);
        // fixme: placeholder copy
        if (turn.status === "failed") this.events.failed(turn.error?.message ?? this.lastError ?? "Codex failed");
        this.events.done();
      }
      this.lastError = null;
      this.next();
    }
  }

  private request(method: string, params: any): unknown {
    if (method !== "item/tool/call") throw new Error(`pxsh does not handle ${method}`);
    const command = params.tool === "write_command" ? params.arguments?.command : undefined;
    if (typeof command !== "string") return { contentItems: [], success: false };
    this.finish(command);
    return { contentItems: [{ type: "inputText", text: WRITE_COMMAND_RESULT }], success: true };
  }
}

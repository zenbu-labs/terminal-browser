import type { EffortLevel, ModelInfo, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { z } from "zod";

import { CodexSession, listCodexModels } from "./codex";
import { claudeModels } from "./models";
import type { AiChoice, Harness, HarnessModels } from "./models";
import { COMMAND_FIELD_DESCRIPTION, SYSTEM_PROMPT, TurnSession, WRITE_COMMAND_DESCRIPTION, WRITE_COMMAND_RESULT } from "./turn";
import type { AiEvents, AiSession } from "./turn";

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk", { with: { "resolution-mode": "import" } });

let sdk: Promise<Sdk> | null = null;

function loadSdk(): Promise<Sdk> {
  sdk ??= import("@anthropic-ai/claude-agent-sdk");
  return sdk;
}

export function preloadSdk(): void {
  loadSdk().catch(() => {});
}

function partialCommand(json: string): string | null {
  const match = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(json);
  if (!match) return null;
  const body = match[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, "");
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return null;
  }
}

function fullCommand(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : null;
  } catch {
    return null;
  }
}

class ClaudeSession extends TurnSession implements AiSession {
  private wake: (() => void) | null = null;
  private closed = false;
  private chat: Query | null = null;
  private toolJson = "";
  private inTool = false;

  constructor(
    events: AiEvents,
    private choice: AiChoice,
    private readonly executable: string,
    cwd: string,
  ) {
    super(events);
    void loadSdk().then(
      (loaded) => this.start(loaded, cwd),
      (error: unknown) => this.events.failed(error instanceof Error ? error.message : String(error)),
    );
  }

  private start({ createSdkMcpServer, query, tool }: Sdk, cwd: string): void {
    if (this.closed) return;
    const writeCommand = tool("write_command", WRITE_COMMAND_DESCRIPTION, { command: z.string().describe(COMMAND_FIELD_DESCRIPTION) }, async ({ command }) => {
      this.finish(command);
      return { content: [{ type: "text", text: WRITE_COMMAND_RESULT }] };
    });
    const { model, effort, fast } = this.choice;
    this.chat = query({
      prompt: this.messages(),
      options: {
        cwd,
        pathToClaudeCodeExecutable: this.executable,
        model,
        effort: (effort ?? undefined) as EffortLevel | undefined,
        settings: fast ? { fastMode: true } : undefined,
        systemPrompt: SYSTEM_PROMPT,
        tools: ["Read", "Glob", "Grep"],
        mcpServers: { shell: createSdkMcpServer({ name: "shell", version: "1.0.0", tools: [writeCommand] }) },
        allowedTools: ["Read", "Glob", "Grep", "mcp__shell__write_command"],
        permissionMode: "dontAsk",
        includePartialMessages: true,
        settingSources: [],
      },
    });
    void this.chat.initializationResult().then(
      (init) => this.events.models("claude", { models: claudeModels(init.models), signedIn: true }),
      () => {},
    );
    void this.consume();
  }

  setChoice(choice: AiChoice): void {
    const previous = this.choice;
    this.choice = choice;
    const chat = this.chat;
    if (!chat) return;
    if (choice.model !== previous.model) void chat.setModel(choice.model).catch(() => {});
    if (choice.effort !== previous.effort) void chat.applyFlagSettings({ effortLevel: choice.effort as EffortLevel | null }).catch(() => {});
    if (choice.fast !== previous.fast) void chat.applyFlagSettings({ fastMode: choice.fast }).catch(() => {});
  }

  protected next(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    if (this.turn === "finishing") return this.dropQueued();
    await this.chat?.interrupt().catch(() => {});
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.chat?.close();
  }

  private async *messages(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.turn === "idle" ? this.inbox.shift() : undefined;
      if (next) {
        this.turn = "running";
        yield { type: "user", message: { role: "user", content: next }, parent_tool_use_id: null, session_id: "" };
        continue;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }

  private async consume(): Promise<void> {
    if (!this.chat) return;
    try {
      for await (const message of this.chat) {
        if (this.turn === "finishing") {
          this.consumeTail(message);
          continue;
        }
        if (message.type === "stream_event") {
          const event = message.event;
          if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            this.inTool = event.content_block.name.endsWith("write_command");
            this.toolJson = "";
            // fixme: placeholder copy
            if (!this.inTool) this.events.status(`Reading ${event.content_block.name.toLowerCase()}`);
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") this.events.text(event.delta.text);
            if (event.delta.type === "input_json_delta" && this.inTool) {
              this.toolJson += event.delta.partial_json;
              const partial = partialCommand(this.toolJson);
              if (partial != null) this.streamCommand(partial);
            }
          } else if (event.type === "content_block_stop") {
            const command = this.inTool ? fullCommand(this.toolJson) : null;
            this.inTool = false;
            if (command != null) this.finish(command);
          }
        } else if (message.type === "assistant") {
          this.events.status(null);
        } else if (message.type === "result") {
          this.turn = "idle";
          this.wake?.();
          this.events.status(null);
          if (message.subtype !== "success") this.events.failed(message.subtype);
          this.events.done();
        }
      }
    } catch (error) {
      if (!this.closed) this.events.failed(error instanceof Error ? error.message : String(error));
    }
  }

  private consumeTail(message: SDKMessage): void {
    if (message.type === "result") {
      this.turn = "idle";
      this.wake?.();
    }
  }
}

export function createSession(choice: AiChoice, executable: string, events: AiEvents, cwd: string): AiSession {
  return choice.harness === "codex" ? new CodexSession(events, choice, executable, cwd) : new ClaudeSession(events, choice, executable, cwd);
}

async function listClaudeModels(executable: string): Promise<ModelInfo[]> {
  const { query } = await loadSdk();
  const idle = async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise(() => {});
  };
  const chat = query({ prompt: idle(), options: { pathToClaudeCodeExecutable: executable, settingSources: [], cwd: process.cwd() } });
  try {
    return await chat.supportedModels();
  } finally {
    chat.close();
  }
}

export function refreshModels(executables: Partial<Record<Harness, string | null>>, found: (harness: Harness, models: HarnessModels) => void): void {
  if (executables.claude) {
    listClaudeModels(executables.claude).then(
      (models) => found("claude", { models: claudeModels(models), signedIn: true }),
      () => {},
    );
  }
  if (executables.codex) listCodexModels(executables.codex).then((models) => models && found("codex", models), () => {});
}

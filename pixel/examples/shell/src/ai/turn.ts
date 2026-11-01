import type { AiChoice, Harness, HarnessModels } from "./models";

interface AskContext {
  cwd: string;
  commandLine: string;
  recentOutput: string;
  selection: string;
  lastRun: { command: string; exitCode: number | null } | null;
}

export function askMessage(text: string, context: AskContext): string {
  const parts = [text, "", `Working directory: ${context.cwd}`];
  if (context.lastRun) {
    // fixme: placeholder copy
    const ended = context.lastRun.exitCode == null ? "it is still running" : `it exited with code ${context.lastRun.exitCode}`;
    parts.push(`They ran ${context.lastRun.command} and ${ended}.`);
  }
  if (context.commandLine) parts.push(`Current command line: ${context.commandLine}`);
  if (context.selection) parts.push("", "Text they selected in the terminal:", "```", context.selection, "```");
  if (context.recentOutput) parts.push("", "Recent terminal output:", "```", context.recentOutput, "```");
  return parts.join("\n");
}

export interface AiEvents {
  text(delta: string): void;
  command(command: string, final: boolean): void;
  status(status: string | null): void;
  done(): void;
  failed(message: string): void;
  models(harness: Harness, models: HarnessModels): void;
}

export interface AiSession {
  ask(text: string, context: AskContext): void;
  stop(): Promise<void>;
  close(): void;
  setChoice(choice: AiChoice): void;
}

// fixme: placeholder copy
export const SYSTEM_PROMPT = `You are the AI built into the user's terminal, opened over their zsh prompt.
When they want something done, call write_command exactly once with the command that does it.
The command appears directly on their command line, where they read it and decide whether to run it. Write no text before or after it: do not explain, confirm or describe it, and do not tell them to press Enter. After write_command, end your turn immediately.
When they ask a question, answer briefly in markdown instead, without calling write_command.
Prefer one line commands for zsh on ${process.platform === "darwin" ? "macOS" : process.platform}. You may read files in their working directory when it helps.`;

// fixme: placeholder copy
export const WRITE_COMMAND_DESCRIPTION = "Put a command on the user's zsh command line, replacing what is there. It is not run. The user sees it there, so end your turn without replying after calling this.";
// fixme: placeholder copy
export const COMMAND_FIELD_DESCRIPTION = "The full command line";
// fixme: placeholder copy
export const WRITE_COMMAND_RESULT = "Written to the user's command line; they can see it. End your turn now without replying.";

const UNSAFE_CHARACTERS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200d\\ufeff]", "g");

function sanitize(command: string): string {
  return command.replace(UNSAFE_CHARACTERS, "").replace(/\s+$/, "");
}

export abstract class TurnSession {
  protected readonly inbox: string[] = [];
  protected turn: "idle" | "running" | "finishing" = "idle";

  constructor(protected readonly events: AiEvents) {}

  ask(text: string, context: AskContext): void {
    this.inbox.push(askMessage(text, context));
    this.next();
  }

  protected abstract next(): void;

  protected finish(command: string): void {
    if (this.turn !== "running") return;
    this.turn = "finishing";
    this.events.command(sanitize(command), true);
    this.events.status(null);
    this.events.done();
  }

  protected streamCommand(partial: string): void {
    this.events.command(sanitize(partial), false);
  }

  protected dropQueued(): void {
    this.inbox.length = 0;
    this.events.done();
  }
}

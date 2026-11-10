import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellLiteral } from "@zenbu-labs/pixel/terminal";
import { codingAgent } from "./agents";
import type { Pane, PaneDetails, Terminal } from "@zenbu-labs/pixel/terminal";

const exec = promisify(execFile);

export type TargetTier = "embed" | "parent" | "agent" | "neighbor";

export interface AgentTarget {
  pane: string;
  tier: TargetTier;
  agent: boolean;
}

const CONTROL_BYTES = /[\x00-\x1f\x7f-\x9f]/g;

export function chatMessage(content: string, target: AgentTarget, screenshotFile: string | null = null): string {
  const line = content.replace(CONTROL_BYTES, " ").replace(/\s+/g, " ").trim();
  if (!target.agent) return shellLiteral(screenshotFile ? `${line} ${screenshotFile}` : line);
  return screenshotFile ? `${line}\n${screenshotFile}\n\n` : `${line}\n\n`;
}

export interface Screenshot {
  file(): string;
  copyToClipboard(): Promise<void>;
}

export interface Delivery {
  target: AgentTarget;
  pasted: boolean;
}

export interface AgentPaneContext {
  terminal: Terminal | null;
  parentTty: string | null;
  cwd: string;
  self(): Promise<Pane | null>;
  embedded?: EmbeddedAgent | null;
}

export interface EmbeddedAgent {
  send(content: string, screenshot: string | null): Promise<boolean>;
}

const EMBED_TARGET: AgentTarget = { pane: "embed", tier: "embed", agent: true };

async function withCommands(panes: PaneDetails[]): Promise<PaneDetails[]> {
  if (!panes.some((pane) => pane.tty && pane.command == null)) return panes;
  let listing = "";
  try {
    listing = (await exec("ps", ["-e", "-o", "tty=,args="])).stdout;
  } catch {
    return panes;
  }
  const byTty = new Map<string, string[]>();
  for (const line of listing.split("\n")) {
    const parts = line.trim().match(/^(\S+)\s+(.*)$/);
    if (!parts || parts[1].startsWith("?")) continue;
    const tty = `/dev/${parts[1]}`;
    byTty.set(tty, [...(byTty.get(tty) ?? []), parts[2]]);
  }
  for (const pane of panes) {
    if (pane.tty && pane.command == null) pane.command = (byTty.get(pane.tty) ?? []).join("\n") || null;
  }
  return panes;
}

const isAgentPane = (pane: PaneDetails): boolean => codingAgent(pane.command) != null;

const canPaste = (terminal: Terminal, target: AgentTarget, screenshot: Screenshot): boolean =>
  target.agent && terminal.pasteKey != null && screenshot != null;

export class AgentPaneFinder {
  private cached: AgentTarget | null = null;
  private resolving: Promise<AgentTarget | null> | null = null;
  private parent: Promise<Pane | null> | null = null;

  constructor(private readonly ctx: AgentPaneContext) {}

  warm() {
    void this.target();
  }

  async send(content: string, screenshot: Screenshot | null): Promise<Delivery | null> {
    if (this.ctx.embedded) {
      const taken = await this.ctx.embedded.send(content, screenshot?.file() ?? null).catch(() => false);
      if (taken) return { target: EMBED_TARGET, pasted: false };
    }
    const terminal = this.ctx.terminal;
    if (!terminal?.sendText) return null;
    let target = await this.target();
    if (!target) return null;
    const message = (to: AgentTarget) =>
      chatMessage(content, to, screenshot && !canPaste(terminal, to, screenshot) ? screenshot.file() : null);
    try {
      await terminal.sendText(target.pane, message(target));
    } catch {
      this.cached = null;
      target = await this.target();
      if (!target) return null;
      await terminal.sendText(target.pane, message(target));
    }
    const pasted = await this.pasteScreenshot(terminal, target, screenshot);
    await terminal.focusPane?.(target.pane).catch(() => {});
    return { target, pasted };
  }

  private async pasteScreenshot(terminal: Terminal, target: AgentTarget, screenshot: Screenshot | null): Promise<boolean> {
    if (!screenshot || !canPaste(terminal, target, screenshot)) return false;
    await screenshot.copyToClipboard();
    await terminal.pasteKey!(target.pane);
    return true;
  }

  private target(): Promise<AgentTarget | null> {
    if (this.cached) return Promise.resolve(this.cached);
    this.resolving ??= this.resolve()
      .then((target) => {
        this.cached = target;
        return target;
      })
      .finally(() => {
        this.resolving = null;
      });
    return this.resolving;
  }

  private async parentPane(panes: PaneDetails[]): Promise<PaneDetails | null> {
    const tty = this.ctx.parentTty;
    if (!tty || !this.ctx.terminal) return null;
    const listed = panes.find((pane) => pane.tty === tty);
    if (listed) return listed;
    this.parent ??= (
      this.ctx.terminal.getCurrentPane?.({ tty, cwd: this.ctx.cwd }) ?? Promise.resolve(null)
    ).catch(() => null);
    const found = await this.parent;
    if (!found) return null;
    const known = panes.find((pane) => pane.id === found.id);
    const [parent] = await withCommands([{ ...found, tty, command: known?.command ?? null }]);
    return parent;
  }

  private async resolve(): Promise<AgentTarget | null> {
    const terminal = this.ctx.terminal;
    if (!terminal) return null;
    let panes: PaneDetails[] = [];
    try {
      panes = await withCommands(
        (await terminal.listPanes?.({
          commands: (command) => codingAgent(command) != null,
          tty: this.ctx.parentTty,
        })) ?? [],
      );
    } catch {}
    const self = await this.ctx.self();
    const inTab = (pane: Pane) => self == null || pane.tab === self.tab;
    const parent = await this.parentPane(panes);
    if (parent && parent.id !== self?.id && inTab(parent)) {
      if (panes.length === 0 || panes.some((pane) => pane.id === parent.id)) {
        return { pane: parent.id, tier: "parent", agent: isAgentPane(parent) };
      }
    }
    if (!self) return null;
    const neighbours = panes.filter((pane) => pane.id !== self.id && pane.tab === self.tab);
    const agent = neighbours.find(isAgentPane);
    if (agent) return { pane: agent.id, tier: "agent", agent: true };
    if (neighbours.length > 0) return { pane: neighbours[0].id, tier: "neighbor", agent: false };
    return null;
  }
}

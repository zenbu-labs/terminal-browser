import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codingAgent, shellLiteral } from "pixel-terminals";
import type { Pane, PaneDetails, Terminal } from "pixel-terminals";

const exec = promisify(execFile);

export type TargetTier = "parent" | "agent" | "neighbor";

export interface AgentTarget {
  pane: string;
  tier: TargetTier;
  agent: boolean;
}

const CONTROL_BYTES = /[\x00-\x1f\x7f-\x9f]/g;

export function chatMessage(content: string, target: AgentTarget): string {
  const line = `> ${content.replace(CONTROL_BYTES, " ").replace(/\s+/g, " ").trim()}`;
  return target.agent ? `${line}\n\n` : shellLiteral(line);
}

export interface AgentPaneContext {
  terminal: Terminal | null;
  parentTty: string | null;
  cwd: string;
  self(): Promise<Pane | null>;
}

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

export class AgentPaneFinder {
  private cached: AgentTarget | null = null;
  private resolving: Promise<AgentTarget | null> | null = null;
  private parent: Promise<Pane | null> | null = null;

  constructor(private readonly ctx: AgentPaneContext) {}

  warm() {
    void this.target();
  }

  async send(content: string): Promise<AgentTarget | null> {
    const terminal = this.ctx.terminal;
    if (!terminal?.sendText) return null;
    let target = await this.target();
    if (!target) return null;
    try {
      await terminal.sendText(target.pane, chatMessage(content, target));
    } catch {
      this.cached = null;
      target = await this.target();
      if (!target) return null;
      await terminal.sendText(target.pane, chatMessage(content, target));
    }
    await terminal.focusPane?.(target.pane);
    return target;
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
      panes = await withCommands((await terminal.listPanes?.()) ?? []);
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

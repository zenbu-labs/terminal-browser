import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codingAgent } from "pixel-terminals";
import type { Pane, PaneDetails, Terminal } from "pixel-terminals";

const exec = promisify(execFile);

export type TargetTier = "parent" | "agent" | "neighbor";

export interface AgentTarget {
  pane: string;
  tier: TargetTier;
}

export interface AgentPaneContext {
  terminal: Terminal | null;
  parentTty: string | null;
  cwd: string;
  self(): Promise<Pane | null>;
}

async function withCommands(panes: PaneDetails[]): Promise<PaneDetails[]> {
  if (!panes.some((pane) => pane.tty && pane.command == null && pane.agent == null)) return panes;
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

const isAgentPane = (pane: PaneDetails): boolean =>
  pane.agent != null || codingAgent(pane.command) != null;

export class AgentPaneFinder {
  private cached: AgentTarget | null = null;
  private resolving: Promise<AgentTarget | null> | null = null;
  private parent: Promise<Pane | null> | null = null;

  constructor(private readonly ctx: AgentPaneContext) {}

  warm() {
    void this.target();
  }

  async send(text: string): Promise<AgentTarget | null> {
    const terminal = this.ctx.terminal;
    if (!terminal?.sendText) return null;
    let target = await this.target();
    if (!target) return null;
    try {
      await terminal.sendText(target.pane, text);
    } catch {
      this.cached = null;
      target = await this.target();
      if (!target) return null;
      await terminal.sendText(target.pane, text);
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

  private parentPane(panes: PaneDetails[]): Promise<Pane | null> {
    const tty = this.ctx.parentTty;
    if (!tty || !this.ctx.terminal) return Promise.resolve(null);
    const listed = panes.find((pane) => pane.tty === tty);
    if (listed) return Promise.resolve(listed);
    this.parent ??= (
      this.ctx.terminal.getCurrentPane?.({ tty, cwd: this.ctx.cwd }) ?? Promise.resolve(null)
    ).catch(() => null);
    return this.parent;
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
        return { pane: parent.id, tier: "parent" };
      }
    }
    if (!self) return null;
    const neighbours = panes.filter((pane) => pane.id !== self.id && pane.tab === self.tab);
    const agent = neighbours.find(isAgentPane);
    if (agent) return { pane: agent.id, tier: "agent" };
    if (neighbours.length > 0) return { pane: neighbours[0].id, tier: "neighbor" };
    return null;
  }
}

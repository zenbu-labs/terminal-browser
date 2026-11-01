import { Listeners } from "./listeners";

export interface ClosedTab {
  sessionId: string;
  windowId: number;
  index: number;
  url: string;
  title: string;
  favIconUrl: string | undefined;
  closedAt: number;
}

const MAX_CLOSED = 25;

// Tabs closed in this run, newest first, for chrome.sessions.
export class RecentlyClosed {
  readonly changed = new Listeners<[]>();
  private entries: ClosedTab[] = [];
  private seq = 1;

  add(tab: Omit<ClosedTab, "sessionId" | "closedAt">) {
    if (!tab.url || /^(?:about:blank|terminal-browser:\/\/newtab)/.test(tab.url)) return;
    this.entries.unshift({ ...tab, sessionId: String(this.seq++), closedAt: Date.now() });
    this.entries.length = Math.min(this.entries.length, MAX_CLOSED);
    this.changed.emit();
  }

  list(): readonly ClosedTab[] {
    return this.entries;
  }

  take(sessionId?: string): ClosedTab | null {
    const at = sessionId === undefined ? 0 : this.entries.findIndex((entry) => entry.sessionId === sessionId);
    if (at < 0 || at >= this.entries.length) return null;
    const [entry] = this.entries.splice(at, 1);
    this.changed.emit();
    return entry;
  }
}

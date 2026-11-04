export type MutedReason = "user" | "capture" | "extension";

export interface MuteChange {
  muted: boolean;
  reason: MutedReason;
  extensionId?: string;
}

export interface TabExtras {
  reportedUrl: string;
  committed: boolean;
  pendingUrl: string | null;
  faviconCandidates: string[];
  favIconUrl: string | undefined;
  muted: { reason: MutedReason; extensionId?: string } | null;
  requestedMute: MuteChange | null;
  autoDiscardable: boolean;
  discarded: boolean;
  // Set by tabs.update; Chrome reports such navigations as links, not typed.
  navigatingFromExtension: boolean;
}

export class TabStates {
  private readonly entries = new Map<number, TabExtras>();

  get(contentsId: number): TabExtras {
    let entry = this.entries.get(contentsId);
    if (!entry) {
      entry = {
        reportedUrl: "",
        committed: false,
        pendingUrl: null,
        faviconCandidates: [],
        favIconUrl: undefined,
        muted: null,
        requestedMute: null,
        autoDiscardable: true,
        discarded: false,
        navigatingFromExtension: false,
      };
      this.entries.set(contentsId, entry);
    }
    return entry;
  }

  peek(contentsId: number): TabExtras | null {
    return this.entries.get(contentsId) ?? null;
  }

  delete(contentsId: number) {
    this.entries.delete(contentsId);
  }
}

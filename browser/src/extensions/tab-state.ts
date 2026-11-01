export type MutedReason = "user" | "capture" | "extension";

export interface ZoomSettings {
  mode: "automatic" | "manual" | "disabled";
  scope: "per-origin" | "per-tab";
}

export interface MuteChange {
  muted: boolean;
  reason: MutedReason;
  extensionId?: string;
}

// What chrome.tabs reports about a tab beyond what the pane itself tracks.
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
  zoom: ZoomSettings;
  zoomFactor: number;
}

export const DEFAULT_ZOOM: ZoomSettings = { mode: "automatic", scope: "per-origin" };

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
        zoom: DEFAULT_ZOOM,
        zoomFactor: 1,
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

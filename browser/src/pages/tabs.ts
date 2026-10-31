import type { Tab, TabManager } from "../session/tabs";

export interface PageTab {
  tabs: TabManager;
  tab: Tab;
}

const managers = new Set<TabManager>();

export function trackTabs(tabs: TabManager): () => void {
  managers.add(tabs);
  return () => managers.delete(tabs);
}

export function tabForContents(contentsId: number): PageTab | null {
  for (const tabs of managers) {
    const tab = tabs.findByContents(contentsId);
    if (tab) return { tabs, tab };
  }
  return null;
}

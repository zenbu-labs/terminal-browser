import { historyEntry, searchHistory, visitsForUrl } from "shared";
import type { HistoryEntry } from "shared";

import { browsing } from "../../browsing";
import type { ExtensionService } from "../service";

const DAY_MS = 24 * 60 * 60 * 1000;

function historyItem(entry: HistoryEntry): chrome.history.HistoryItem {
  return {
    id: String(entry.id),
    url: entry.url,
    title: entry.title,
    lastVisitTime: entry.lastVisitTime,
    visitCount: entry.visitCount,
    typedCount: entry.typedCount,
  };
}

function urlArgument(details: unknown): string {
  const url = (details as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") throw new Error("Url is invalid.");
  try {
    return new URL(url).href;
  } catch {
    throw new Error("Url is invalid.");
  }
}

export function installHistory(service: ExtensionService) {
  const { router } = service;
  const { history } = browsing();
  const options = { permission: "history" };
  const allowed = (extension: { hasApiPermission(name: string): boolean }) => extension.hasApiPermission("history");

  history.visited.add((entry) => {
    service.broadcast("history.onVisited", (extension) => (allowed(extension) ? [historyItem(entry)] : null));
  });
  history.removed.add((removal) => {
    service.broadcast("history.onVisitRemoved", (extension) => (allowed(extension) ? [removal] : null));
  });

  router.handle(
    "history.search",
    (_caller, query) => {
      const { text, startTime, endTime, maxResults } = (query ?? {}) as chrome.history.HistoryQuery;
      if (typeof text !== "string") throw new Error("Error at parameter 'query': Missing required property 'text'.");
      return searchHistory({
        text,
        startTime: startTime ?? Date.now() - DAY_MS,
        endTime: endTime ?? undefined,
        maxResults: maxResults ?? 100,
      }).map(historyItem);
    },
    options,
  );

  router.handle(
    "history.getVisits",
    (_caller, details) =>
      visitsForUrl(urlArgument(details)).map((visit) => ({
        id: String(visit.urlId),
        visitId: String(visit.id),
        visitTime: visit.visitTime,
        referringVisitId: visit.referringVisitId === null ? "0" : String(visit.referringVisitId),
        transition: visit.transition as chrome.history.TransitionType,
        isLocal: true,
      })),
    options,
  );

  router.handle(
    "history.addUrl",
    (_caller, details) => {
      const url = urlArgument(details);
      const title = (details as { title?: unknown }).title;
      history.add(url, "link", typeof title === "string" ? title : undefined);
    },
    options,
  );

  router.handle(
    "history.deleteUrl",
    (_caller, details) => {
      const url = urlArgument(details);
      if (historyEntry(url)) history.deleteUrl(url);
    },
    options,
  );

  router.handle(
    "history.deleteRange",
    (_caller, range) => {
      const { startTime, endTime } = (range ?? {}) as { startTime?: unknown; endTime?: unknown };
      if (typeof startTime !== "number" || typeof endTime !== "number") {
        throw new Error("Error at parameter 'range': Missing required property 'startTime'.");
      }
      history.deleteRange(startTime, endTime);
    },
    options,
  );

  router.handle("history.deleteAll", () => history.deleteAll(), options);
}

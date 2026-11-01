import { browsing } from "../../browsing";
import type { ClosedTab } from "../../browsing/closed";
import type { LoadedExtension } from "../loaded";
import type { ExtensionService } from "../service";

const MAX_RESULTS = 25;

export function installSessions(service: ExtensionService) {
  const { router } = service;
  const { closed } = browsing();
  const options = { permission: "sessions" };

  closed.changed.add(() => {
    service.broadcast("sessions.onChanged", (extension) => (extension.hasApiPermission("sessions") ? [] : null));
  });

  const closedSession = (extension: LoadedExtension, entry: ClosedTab): chrome.sessions.Session => ({
    lastModified: Math.floor(entry.closedAt / 1000),
    tab: service.scrubTab(extension, {
      sessionId: entry.sessionId,
      index: entry.index,
      windowId: entry.windowId,
      url: entry.url,
      title: entry.title,
      favIconUrl: entry.favIconUrl,
      active: false,
      highlighted: false,
      selected: false,
      pinned: false,
      discarded: false,
      autoDiscardable: true,
      frozen: false,
      groupId: -1,
      incognito: false,
    }),
  });

  router.handle(
    "sessions.getRecentlyClosed",
    (caller, filter) => {
      const max = (filter as chrome.sessions.Filter | undefined)?.maxResults ?? MAX_RESULTS;
      if (max < 0 || max > MAX_RESULTS) throw new Error(`The maxResults value must be between 0 and ${MAX_RESULTS}.`);
      return closed
        .list()
        .slice(0, max)
        .map((entry) => closedSession(caller.extension, entry));
    },
    options,
  );

  router.handle("sessions.getDevices", () => [], options);

  router.handle(
    "sessions.restore",
    async (caller, requested) => {
      const sessionId = requested ?? undefined;
      if (sessionId !== undefined && typeof sessionId !== "string") throw new Error(`Invalid session id: "${sessionId}".`);
      const entry = closed.take(sessionId);
      if (!entry) {
        throw new Error(sessionId === undefined ? "There are no recently closed sessions." : `Invalid session id: "${sessionId}".`);
      }
      const window = service.window(entry.windowId) ?? service.lastFocusedWindow();
      if (!window) throw new Error("No current window.");
      const tabs = window.host.tabs;
      const tab = tabs.create(entry.url, true, { index: Math.min(entry.index, tabs.count) });
      await tabs.whenReady(tab);
      return { lastModified: Math.floor(Date.now() / 1000), tab: service.tabInfo(caller.extension, { window, tab }) };
    },
    options,
  );
}

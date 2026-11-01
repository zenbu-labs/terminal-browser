import { browsing } from "../../browsing";
import type { ExtensionService } from "../service";

export function installBookmarks(service: ExtensionService) {
  const { router } = service;
  const { bookmarks } = browsing();
  const options = { permission: "bookmarks" };
  const broadcast = (event: string, args: unknown[]) =>
    service.broadcast(event, (extension) => (extension.hasApiPermission("bookmarks") ? args : null));

  bookmarks.created.add((id, node) => broadcast("bookmarks.onCreated", [id, node]));
  bookmarks.removed.add((id, info) => broadcast("bookmarks.onRemoved", [id, info]));
  bookmarks.changed.add((id, info) => broadcast("bookmarks.onChanged", [id, info]));
  bookmarks.moved.add((id, info) => broadcast("bookmarks.onMoved", [id, info]));

  router.handle("bookmarks.get", (_caller, ids) => bookmarks.get(ids), options);
  router.handle("bookmarks.getChildren", (_caller, id) => bookmarks.children(id), options);
  router.handle(
    "bookmarks.getRecent",
    (_caller, count) => {
      if (typeof count !== "number" || count < 1) throw new Error("Number of items must be greater than 0.");
      return bookmarks.recent(count);
    },
    options,
  );
  router.handle("bookmarks.getTree", () => bookmarks.tree(), options);
  router.handle("bookmarks.getSubTree", (_caller, id) => [bookmarks.subtree(id)], options);
  router.handle("bookmarks.search", (_caller, query) => bookmarks.search(query), options);
  router.handle(
    "bookmarks.create",
    (_caller, details) => bookmarks.create((details ?? {}) as chrome.bookmarks.CreateDetails),
    options,
  );
  router.handle(
    "bookmarks.move",
    (_caller, id, destination) => bookmarks.move(id, (destination ?? {}) as { parentId?: string; index?: number }),
    options,
  );
  router.handle(
    "bookmarks.update",
    (_caller, id, changes) => bookmarks.update(id, (changes ?? {}) as { title?: string; url?: string }),
    options,
  );
  router.handle("bookmarks.remove", (_caller, id) => bookmarks.remove(id, false), options);
  router.handle("bookmarks.removeTree", (_caller, id) => bookmarks.remove(id, true), options);
}

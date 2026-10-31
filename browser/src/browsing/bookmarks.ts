import {
  BOOKMARK_ROOT_ID,
  BOOKMARKS_BAR_ID,
  OTHER_BOOKMARKS_ID,
  allBookmarks,
  bookmarkChildren,
  createBookmark,
  ensureBookmarkRoots,
  getBookmark,
  hasBookmarkChildren,
  moveBookmark,
  removeBookmark,
  updateBookmark,
} from "shared";
import type { BookmarkRecord } from "shared";

import { Listeners } from "./listeners";

export interface BookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  url?: string;
  title: string;
  dateAdded: number;
  dateGroupModified?: number;
  unmodifiable?: "managed";
  folderType?: "bookmarks-bar" | "other" | "mobile" | "managed";
  syncing: boolean;
  children?: BookmarkNode[];
}

const FIXED = new Set([BOOKMARK_ROOT_ID, BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID]);

function bookmarkId(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Bookmark id is invalid.");
  return Number(value);
}

export class Bookmarks {
  readonly created = new Listeners<[string, BookmarkNode]>();
  readonly removed = new Listeners<[string, { parentId: string; index: number; node: BookmarkNode }]>();
  readonly changed = new Listeners<[string, { title: string; url?: string }]>();
  readonly moved = new Listeners<[string, { parentId: string; index: number; oldParentId: string; oldIndex: number }]>();
  readonly any = new Listeners<[]>();
  private ready = false;

  private init() {
    if (this.ready) return;
    ensureBookmarkRoots();
    this.ready = true;
  }

  node(record: BookmarkRecord, children?: BookmarkNode[]): BookmarkNode {
    const node: BookmarkNode = { id: String(record.id), title: record.title, dateAdded: record.dateAdded, syncing: false };
    if (record.parentId !== null) {
      node.parentId = String(record.parentId);
      node.index = record.index;
    }
    if (record.url !== null) node.url = record.url;
    else if (record.id !== BOOKMARK_ROOT_ID) node.dateGroupModified = record.dateGroupModified ?? record.dateAdded;
    if (record.id === BOOKMARKS_BAR_ID) node.folderType = "bookmarks-bar";
    if (record.id === OTHER_BOOKMARKS_ID) node.folderType = "other";
    if (children) node.children = children;
    return node;
  }

  find(id: unknown): BookmarkRecord {
    this.init();
    const record = getBookmark(bookmarkId(id));
    if (!record) throw new Error("Can't find bookmark for id.");
    return record;
  }

  get(ids: unknown): BookmarkNode[] {
    const list = Array.isArray(ids) ? ids : [ids];
    if (list.length === 0) throw new Error("Bookmark id list is empty.");
    return list.map((id) => this.node(this.find(id)));
  }

  children(id: unknown): BookmarkNode[] {
    const parent = this.find(id);
    return bookmarkChildren(parent.id).map((child) => this.node(child));
  }

  subtree(id: unknown): BookmarkNode {
    const record = this.find(id);
    const all = allBookmarks();
    const build = (current: BookmarkRecord): BookmarkNode =>
      current.url !== null
        ? this.node(current)
        : this.node(
            current,
            all.filter((child) => child.parentId === current.id).sort((a, b) => a.index - b.index).map(build),
          );
    return build(record);
  }

  tree(): BookmarkNode[] {
    return [this.subtree(String(BOOKMARK_ROOT_ID))];
  }

  recent(count: number): BookmarkNode[] {
    this.init();
    return allBookmarks()
      .filter((record) => record.url !== null)
      .sort((a, b) => b.dateAdded - a.dateAdded || b.id - a.id)
      .slice(0, Math.max(0, count))
      .map((record) => this.node(record));
  }

  search(query: unknown): BookmarkNode[] {
    this.init();
    const all = allBookmarks().filter((record) => !FIXED.has(record.id));
    if (typeof query === "string") {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      return all
        .filter((record) => words.every((word) => record.title.toLowerCase().includes(word) || (record.url ?? "").toLowerCase().includes(word)))
        .map((record) => this.node(record));
    }
    const { query: text, url, title } = (query ?? {}) as { query?: string; url?: string; title?: string };
    const words = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .filter((record) => url === undefined || record.url === url)
      .filter((record) => title === undefined || record.title === title)
      .filter((record) => words.every((word) => record.title.toLowerCase().includes(word) || (record.url ?? "").toLowerCase().includes(word)))
      .map((record) => this.node(record));
  }

  create(details: { parentId?: string; index?: number; title?: string; url?: string }): BookmarkNode {
    this.init();
    const parent = this.find(details.parentId ?? String(OTHER_BOOKMARKS_ID));
    if (parent.url !== null) throw new Error("Parameter 'parentId' does not specify a folder.");
    if (parent.id === BOOKMARK_ROOT_ID) throw new Error("Can't modify the root bookmark folders.");
    if (details.url !== undefined) this.checkUrl(details.url);
    const record = createBookmark({
      parentId: parent.id,
      index: details.index,
      title: details.title ?? "",
      url: details.url ?? null,
    });
    const node = this.node(record);
    this.created.emit(node.id, node);
    this.any.emit();
    return node;
  }

  update(id: unknown, change: { title?: string; url?: string }): BookmarkNode {
    const record = this.find(id);
    if (FIXED.has(record.id)) throw new Error("Can't modify the root bookmark folders.");
    if (change.url !== undefined) {
      if (record.url === null) throw new Error("Can't set URL of a bookmark folder.");
      this.checkUrl(change.url);
    }
    const next = updateBookmark(record.id, change)!;
    const info: { title: string; url?: string } = { title: next.title };
    if (next.url !== null) info.url = next.url;
    this.changed.emit(String(record.id), info);
    this.any.emit();
    return this.node(next);
  }

  move(id: unknown, destination: { parentId?: string; index?: number }): BookmarkNode {
    const record = this.find(id);
    if (FIXED.has(record.id)) throw new Error("Can't modify the root bookmark folders.");
    const parent = destination.parentId !== undefined ? this.find(destination.parentId) : this.find(String(record.parentId));
    if (parent.url !== null) throw new Error("Parameter 'parentId' does not specify a folder.");
    if (parent.id === BOOKMARK_ROOT_ID) throw new Error("Can't modify the root bookmark folders.");
    for (let at: BookmarkRecord | null = parent; at; at = at.parentId === null ? null : getBookmark(at.parentId)) {
      if (at.id === record.id) throw new Error("Can't move a folder to itself or its descendant.");
    }
    const next = moveBookmark(record.id, parent.id, destination.index)!;
    this.moved.emit(String(record.id), {
      parentId: String(next.parentId),
      index: next.index,
      oldParentId: String(record.parentId),
      oldIndex: record.index,
    });
    this.any.emit();
    return this.node(next);
  }

  remove(id: unknown, recursive: boolean) {
    const record = this.find(id);
    if (FIXED.has(record.id)) throw new Error("Can't modify the root bookmark folders.");
    if (!recursive && record.url === null && hasBookmarkChildren(record.id)) {
      throw new Error("Can't remove non-empty folder (use recursive to force).");
    }
    const node = record.url === null ? this.subtree(String(record.id)) : this.node(record);
    removeBookmark(record.id);
    this.removed.emit(String(record.id), { parentId: String(record.parentId), index: record.index, node });
    this.any.emit();
  }

  private checkUrl(url: string) {
    try {
      new URL(url);
    } catch {
      throw new Error("Invalid URL.");
    }
  }
}

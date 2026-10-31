import {
  BOOKMARK_ROOT_ID,
  BOOKMARKS_BAR_ID,
  OTHER_BOOKMARKS_ID,
  allBookmarks,
  createBookmark,
  ensureBookmarkRoots,
  getBookmark,
  hasBookmarkChildren,
  removeBookmark,
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
    this.any.emit();
    return this.node(record);
  }

  remove(id: unknown, recursive: boolean) {
    const record = this.find(id);
    if (FIXED.has(record.id)) throw new Error("Can't modify the root bookmark folders.");
    if (!recursive && record.url === null && hasBookmarkChildren(record.id)) {
      throw new Error("Can't remove non-empty folder (use recursive to force).");
    }
    removeBookmark(record.id);
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

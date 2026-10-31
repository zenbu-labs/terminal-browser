import { store } from "./client";

export const BOOKMARK_ROOT_ID = 0;
export const BOOKMARKS_BAR_ID = 1;
export const OTHER_BOOKMARKS_ID = 2;

export interface BookmarkRecord {
  id: number;
  parentId: number | null;
  index: number;
  title: string;
  url: string | null;
  dateAdded: number;
  dateGroupModified: number | null;
}

interface BookmarkSqlRow {
  id: number;
  parent_id: number | null;
  position: number;
  title: string;
  url: string | null;
  date_added: number;
  date_group_modified: number | null;
}

function fromRow(row: BookmarkSqlRow): BookmarkRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    index: row.position,
    title: row.title,
    url: row.url,
    dateAdded: row.date_added,
    dateGroupModified: row.date_group_modified,
  };
}

// Chrome's fixed folders always exist with the same ids, under a root that
// has no row of its own.
export function ensureBookmarkRoots(): void {
  const { sqlite } = store();
  const insert = sqlite.prepare(
    "INSERT OR IGNORE INTO bookmarks (id, parent_id, position, title, url, date_added) VALUES (?, ?, ?, ?, NULL, ?)",
  );
  insert.run(BOOKMARKS_BAR_ID, BOOKMARK_ROOT_ID, 0, "Bookmarks bar", Date.now());
  insert.run(OTHER_BOOKMARKS_ID, BOOKMARK_ROOT_ID, 1, "Other bookmarks", Date.now());
}

export function getBookmark(id: number): BookmarkRecord | null {
  if (id === BOOKMARK_ROOT_ID) {
    return { id, parentId: null, index: 0, title: "", url: null, dateAdded: 0, dateGroupModified: null };
  }
  const row = store().sqlite.prepare("SELECT * FROM bookmarks WHERE id = ?").get(id) as BookmarkSqlRow | undefined;
  return row ? fromRow(row) : null;
}

export function bookmarkChildren(parentId: number): BookmarkRecord[] {
  const rows = store()
    .sqlite.prepare("SELECT * FROM bookmarks WHERE parent_id = ? ORDER BY position, id")
    .all(parentId) as unknown as BookmarkSqlRow[];
  return rows.map(fromRow);
}

export function allBookmarks(): BookmarkRecord[] {
  const rows = store().sqlite.prepare("SELECT * FROM bookmarks ORDER BY parent_id, position, id").all() as unknown as BookmarkSqlRow[];
  return rows.map(fromRow);
}

function childCount(parentId: number): number {
  const row = store().sqlite.prepare("SELECT COUNT(*) AS count FROM bookmarks WHERE parent_id = ?").get(parentId) as {
    count: number;
  };
  return row.count;
}

function touchFolder(parentId: number) {
  store().sqlite.prepare("UPDATE bookmarks SET date_group_modified = ? WHERE id = ?").run(Date.now(), parentId);
}

function clampIndex(parentId: number, index: number | undefined): number {
  const count = childCount(parentId);
  return index === undefined || index < 0 || index > count ? count : index;
}

export function createBookmark(node: { parentId: number; index?: number; title: string; url: string | null }): BookmarkRecord {
  const { sqlite } = store();
  const index = clampIndex(node.parentId, node.index);
  sqlite.prepare("UPDATE bookmarks SET position = position + 1 WHERE parent_id = ? AND position >= ?").run(node.parentId, index);
  const now = Date.now();
  const result = sqlite
    .prepare(
      "INSERT INTO bookmarks (parent_id, position, title, url, date_added, date_group_modified) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(node.parentId, index, node.title, node.url, now, node.url === null ? now : null);
  touchFolder(node.parentId);
  return getBookmark(Number(result.lastInsertRowid))!;
}

export function removeBookmark(id: number): void {
  const current = getBookmark(id);
  if (!current || current.parentId === null) return;
  const { sqlite } = store();
  const doomed = [id];
  for (let i = 0; i < doomed.length; i++) {
    for (const child of bookmarkChildren(doomed[i])) doomed.push(child.id);
  }
  const remove = sqlite.prepare("DELETE FROM bookmarks WHERE id = ?");
  for (const target of doomed) remove.run(target);
  sqlite.prepare("UPDATE bookmarks SET position = position - 1 WHERE parent_id = ? AND position > ?").run(current.parentId, current.index);
  touchFolder(current.parentId);
}

export function hasBookmarkChildren(id: number): boolean {
  return childCount(id) > 0;
}

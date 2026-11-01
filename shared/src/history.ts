import { store } from "./client";

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitCount: number;
  typedCount: number;
  lastVisitTime: number;
}

export interface HistoryVisit {
  id: number;
  urlId: number;
  url: string;
  title: string;
  visitTime: number;
  transition: string;
  referringVisitId: number | null;
}

export interface HistorySearch {
  text?: string;
  startTime?: number;
  endTime?: number;
  maxResults?: number;
}

interface UrlSqlRow {
  id: number;
  url: string;
  title: string;
  visit_count: number;
  typed_count: number;
  last_visit_time: number;
}

interface VisitSqlRow {
  id: number;
  url_id: number;
  url: string;
  title: string;
  visit_time: number;
  transition: string;
  referring_visit_id: number | null;
}

function entryFrom(row: UrlSqlRow): HistoryEntry {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    visitCount: row.visit_count,
    typedCount: row.typed_count,
    lastVisitTime: row.last_visit_time,
  };
}

function visitFrom(row: VisitSqlRow): HistoryVisit {
  return {
    id: row.id,
    urlId: row.url_id,
    url: row.url,
    title: row.title,
    visitTime: row.visit_time,
    transition: row.transition,
    referringVisitId: row.referring_visit_id,
  };
}

export function historyEntry(url: string): HistoryEntry | null {
  const row = store().sqlite.prepare("SELECT * FROM history_urls WHERE url = ?").get(url) as UrlSqlRow | undefined;
  return row ? entryFrom(row) : null;
}

export function addHistoryVisit(visit: {
  url: string;
  title?: string;
  time?: number;
  transition: string;
  referringVisitId?: number | null;
}): { entry: HistoryEntry; visitId: number } {
  const { sqlite } = store();
  const time = visit.time ?? Date.now();
  sqlite
    .prepare(
      `INSERT INTO history_urls (url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(url) DO UPDATE SET visit_count = visit_count + 1, typed_count = typed_count + excluded.typed_count,
         last_visit_time = MAX(last_visit_time, excluded.last_visit_time),
         title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END`,
    )
    .run(visit.url, visit.title ?? "", visit.transition === "typed" ? 1 : 0, time);
  const entry = historyEntry(visit.url)!;
  const result = sqlite
    .prepare("INSERT INTO history_visits (url_id, visit_time, transition, referring_visit_id) VALUES (?, ?, ?, ?)")
    .run(entry.id, time, visit.transition, visit.referringVisitId ?? null);
  return { entry, visitId: Number(result.lastInsertRowid) };
}

export function setHistoryTitle(url: string, title: string): HistoryEntry | null {
  const result = store().sqlite.prepare("UPDATE history_urls SET title = ? WHERE url = ? AND title != ?").run(title, url, title);
  return result.changes > 0 ? historyEntry(url) : null;
}

export function searchHistory(search: HistorySearch): HistoryEntry[] {
  const start = search.startTime ?? 0;
  const end = search.endTime ?? Number.MAX_SAFE_INTEGER;
  const rows = store()
    .sqlite.prepare(
      `SELECT u.* FROM history_urls u WHERE EXISTS (
         SELECT 1 FROM history_visits v WHERE v.url_id = u.id AND v.visit_time >= ? AND v.visit_time < ?)
       ORDER BY u.last_visit_time DESC`,
    )
    .all(start, end) as unknown as UrlSqlRow[];
  const words = (search.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matched = rows
    .map(entryFrom)
    .filter((entry) => words.every((word) => entry.url.toLowerCase().includes(word) || entry.title.toLowerCase().includes(word)));
  const limit = search.maxResults ?? 100;
  return limit > 0 ? matched.slice(0, limit) : matched;
}

export function visitsForUrl(url: string): HistoryVisit[] {
  const rows = store()
    .sqlite.prepare(
      `SELECT v.*, u.url, u.title FROM history_visits v JOIN history_urls u ON u.id = v.url_id
       WHERE u.url = ? ORDER BY v.visit_time`,
    )
    .all(url) as unknown as VisitSqlRow[];
  return rows.map(visitFrom);
}

export function recentVisits(options: { text?: string; before?: number; limit?: number }): HistoryVisit[] {
  const words = (options.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const conditions = ["v.visit_time < ?"];
  const params: (string | number)[] = [options.before ?? Number.MAX_SAFE_INTEGER];
  for (const word of words) {
    conditions.push("(lower(u.url) LIKE ? ESCAPE '\\' OR lower(u.title) LIKE ? ESCAPE '\\')");
    const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  params.push(options.limit ?? 200);
  const rows = store()
    .sqlite.prepare(
      `SELECT v.*, u.url, u.title FROM history_visits v JOIN history_urls u ON u.id = v.url_id
       WHERE ${conditions.join(" AND ")} ORDER BY v.visit_time DESC LIMIT ?`,
    )
    .all(...params) as unknown as VisitSqlRow[];
  return rows.map(visitFrom);
}

export function topHistorySites(limit: number): HistoryEntry[] {
  const rows = store()
    .sqlite.prepare("SELECT * FROM history_urls ORDER BY visit_count DESC, last_visit_time DESC LIMIT ?")
    .all(limit) as unknown as UrlSqlRow[];
  return rows.map(entryFrom);
}

// Removes the matching visits, then drops urls left without any visit.
// Returns the urls that disappeared from history entirely.
function removeVisits(where: string, params: (string | number)[]): string[] {
  const { sqlite } = store();
  const touched = sqlite
    .prepare(`SELECT DISTINCT url_id AS id FROM history_visits WHERE ${where}`)
    .all(...params) as { id: number }[];
  if (touched.length === 0) return [];
  sqlite.prepare(`DELETE FROM history_visits WHERE ${where}`).run(...params);
  const removed: string[] = [];
  for (const { id } of touched) {
    const stats = sqlite
      .prepare("SELECT COUNT(*) AS count, MAX(visit_time) AS last FROM history_visits WHERE url_id = ?")
      .get(id) as { count: number; last: number | null };
    if (stats.count === 0) {
      const row = sqlite.prepare("SELECT url FROM history_urls WHERE id = ?").get(id) as { url: string } | undefined;
      sqlite.prepare("DELETE FROM history_urls WHERE id = ?").run(id);
      if (row) removed.push(row.url);
    } else {
      sqlite.prepare("UPDATE history_urls SET visit_count = ?, last_visit_time = ? WHERE id = ?").run(stats.count, stats.last, id);
    }
  }
  return removed;
}

export function deleteHistoryUrl(url: string): boolean {
  const entry = historyEntry(url);
  if (!entry) return false;
  return removeVisits("url_id = ?", [entry.id]).length > 0;
}

export function deleteHistoryRange(startTime: number, endTime: number): string[] {
  return removeVisits("visit_time >= ? AND visit_time < ?", [startTime, endTime]);
}

export function deleteHistoryUrlInRange(url: string, startTime: number, endTime: number): string[] {
  const entry = historyEntry(url);
  if (!entry) return [];
  return removeVisits("url_id = ? AND visit_time >= ? AND visit_time < ?", [entry.id, startTime, endTime]);
}

export function deleteAllHistory(): void {
  const { sqlite } = store();
  sqlite.exec("DELETE FROM history_visits");
  sqlite.exec("DELETE FROM history_urls");
}

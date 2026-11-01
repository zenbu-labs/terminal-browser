import { store } from "./client";

export type DownloadState = "in_progress" | "interrupted" | "complete";

export interface DownloadRecord {
  id: number;
  url: string;
  finalUrl: string;
  filename: string;
  mime: string;
  startTime: number;
  endTime: number | null;
  state: DownloadState;
  error: string | null;
  paused: boolean;
  totalBytes: number;
  receivedBytes: number;
  byExtensionId: string | null;
}

interface DownloadSqlRow {
  id: number;
  url: string;
  final_url: string;
  filename: string;
  mime: string;
  start_time: number;
  end_time: number | null;
  state: DownloadState;
  error: string | null;
  paused: number;
  total_bytes: number;
  received_bytes: number;
  by_extension_id: string | null;
}

const COLUMNS: Record<Exclude<keyof DownloadRecord, "id">, string> = {
  url: "url",
  finalUrl: "final_url",
  filename: "filename",
  mime: "mime",
  startTime: "start_time",
  endTime: "end_time",
  state: "state",
  error: "error",
  paused: "paused",
  totalBytes: "total_bytes",
  receivedBytes: "received_bytes",
  byExtensionId: "by_extension_id",
};

function fromRow(row: DownloadSqlRow): DownloadRecord {
  return {
    id: row.id,
    url: row.url,
    finalUrl: row.final_url,
    filename: row.filename,
    mime: row.mime,
    startTime: row.start_time,
    endTime: row.end_time,
    state: row.state,
    error: row.error,
    paused: row.paused === 1,
    totalBytes: row.total_bytes,
    receivedBytes: row.received_bytes,
    byExtensionId: row.by_extension_id,
  };
}

function sqlValue(value: unknown): string | number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as string | number | null;
}

export function createDownload(record: Omit<DownloadRecord, "id">): DownloadRecord {
  const keys = Object.keys(COLUMNS) as (keyof typeof COLUMNS)[];
  const result = store()
    .sqlite.prepare(
      `INSERT INTO downloads (${keys.map((key) => COLUMNS[key]).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    )
    .run(...keys.map((key) => sqlValue(record[key])));
  return { ...record, id: Number(result.lastInsertRowid) };
}

export function updateDownload(id: number, change: Partial<Omit<DownloadRecord, "id">>): void {
  const keys = (Object.keys(change) as (keyof typeof COLUMNS)[]).filter((key) => key in COLUMNS);
  if (keys.length === 0) return;
  store()
    .sqlite.prepare(`UPDATE downloads SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((key) => sqlValue(change[key])), id);
}

export function getDownload(id: number): DownloadRecord | null {
  const row = store().sqlite.prepare("SELECT * FROM downloads WHERE id = ?").get(id) as DownloadSqlRow | undefined;
  return row ? fromRow(row) : null;
}

export function listDownloads(): DownloadRecord[] {
  const rows = store().sqlite.prepare("SELECT * FROM downloads ORDER BY start_time DESC, id DESC").all() as unknown as DownloadSqlRow[];
  return rows.map(fromRow);
}

export function deleteDownload(id: number): void {
  store().sqlite.prepare("DELETE FROM downloads WHERE id = ?").run(id);
}

// Downloads still marked in progress belong to a browser that has since quit.
export function interruptStaleDownloads(): void {
  store()
    .sqlite.prepare("UPDATE downloads SET state = 'interrupted', error = 'CRASH', paused = 0 WHERE state = 'in_progress'")
    .run();
}

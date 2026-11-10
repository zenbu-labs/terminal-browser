import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { drizzle } from "drizzle-orm/sqlite-proxy";

import { migrate } from "./migrate";
import { migrations } from "./migrations.gen";
import { DB_FILE, ensureDataDir } from "./paths";
import * as schema from "./schema";

export type Store = ReturnType<typeof openStore>;

export function openStore(file: string = DB_FILE) {
  if (file === DB_FILE) ensureDataDir();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  migrate(sqlite, migrations);
  const db = drizzle(
    async (sql, params, method) => {
      const stmt = sqlite.prepare(sql);
      const values = params as Parameters<typeof stmt.run>;
      if (method === "run") {
        stmt.run(...values);
        return { rows: [] };
      }
      const rows = stmt.all(...values).map((row) => Object.values(row));
      return method === "get" ? { rows: rows[0] ?? [] } : { rows };
    },
    { schema },
  );
  return { sqlite, db };
}

let opened: Store | null = null;

export function store(): Store {
  opened ??= openStore();
  return opened;
}

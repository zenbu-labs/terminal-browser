import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const instances = sqliteTable("instances", {
  key: text("key").primaryKey(),
  pid: integer("pid").notNull(),
  tty: text("tty"),
  socket: text("socket").notNull(),
  cdpPort: integer("cdp_port"),
  url: text("url").notNull().default(""),
  title: text("title").notNull().default(""),
  favicon: text("favicon"),
  loading: integer("loading", { mode: "boolean" }).notNull().default(false),
  canGoBack: integer("can_go_back", { mode: "boolean" }).notNull().default(false),
  canGoForward: integer("can_go_forward", { mode: "boolean" }).notNull().default(false),
  findMatches: text("find_matches", { mode: "json" }).$type<{
    active: number;
    total: number;
  } | null>(),
  zoom: real("zoom").notNull().default(1),
  tabs: text("tabs", { mode: "json" }).$type<unknown>(),
  viewport: text("viewport", { mode: "json" }).$type<{
    width: number;
    height: number;
  } | null>(),
  splitDir: text("split_dir", { enum: ["right", "left", "down", "up"] }),
  parentTty: text("parent_tty"),
  startedAt: integer("started_at").notNull(),
});

export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const sitePermissions = sqliteTable(
  "site_permissions",
  {
    origin: text("origin").notNull(),
    embedder: text("embedder").notNull(),
    kind: text("kind").notNull(),
    allowed: integer("allowed", { mode: "boolean" }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.origin, table.embedder, table.kind] })],
);

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  devtoolsDock: text("devtools_dock", { enum: ["bottom", "right"] })
    .notNull()
    .default("bottom"),
  devtoolsFraction: real("devtools_fraction").notNull().default(0.4),
});

export type InstanceRow = typeof instances.$inferSelect;
export type NewInstanceRow = typeof instances.$inferInsert;
export type SettingsRow = typeof settings.$inferSelect;
export type SitePermissionRow = typeof sitePermissions.$inferSelect;
export type DevtoolsDock = SettingsRow["devtoolsDock"];

export const historyUrls = sqliteTable("history_urls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull().unique(),
  title: text("title").notNull().default(""),
  visitCount: integer("visit_count").notNull().default(0),
  typedCount: integer("typed_count").notNull().default(0),
  lastVisitTime: integer("last_visit_time").notNull(),
});

export const historyVisits = sqliteTable("history_visits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  urlId: integer("url_id").notNull(),
  visitTime: integer("visit_time").notNull(),
  transition: text("transition").notNull(),
  referringVisitId: integer("referring_visit_id"),
}, (table) => [index("history_visits_url").on(table.urlId), index("history_visits_time").on(table.visitTime)]);

export const downloads = sqliteTable("downloads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  finalUrl: text("final_url").notNull(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull().default(""),
  startTime: integer("start_time").notNull(),
  endTime: integer("end_time"),
  state: text("state", { enum: ["in_progress", "interrupted", "complete"] }).notNull(),
  error: text("error"),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  totalBytes: integer("total_bytes").notNull().default(0),
  receivedBytes: integer("received_bytes").notNull().default(0),
});

export const bookmarks = sqliteTable("bookmarks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  parentId: integer("parent_id"),
  position: integer("position").notNull().default(0),
  title: text("title").notNull().default(""),
  url: text("url"),
  dateAdded: integer("date_added").notNull(),
  dateGroupModified: integer("date_group_modified"),
}, (table) => [index("bookmarks_parent").on(table.parentId)]);

export type HistoryUrlRow = typeof historyUrls.$inferSelect;
export type DownloadRow = typeof downloads.$inferSelect;
export type BookmarkRow = typeof bookmarks.$inferSelect;

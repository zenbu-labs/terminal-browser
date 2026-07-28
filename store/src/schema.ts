import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    scale: number;
  } | null>(),
  startedAt: integer("started_at").notNull(),
});

export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

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
export type DevtoolsDock = SettingsRow["devtoolsDock"];

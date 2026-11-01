CREATE TABLE `bookmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_id` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`url` text,
	`date_added` integer NOT NULL,
	`date_group_modified` integer
);
--> statement-breakpoint
CREATE INDEX `bookmarks_parent` ON `bookmarks` (`parent_id`);--> statement-breakpoint
CREATE TABLE `downloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`final_url` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text DEFAULT '' NOT NULL,
	`start_time` integer NOT NULL,
	`end_time` integer,
	`state` text NOT NULL,
	`error` text,
	`paused` integer DEFAULT false NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`received_bytes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `history_urls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`visit_count` integer DEFAULT 0 NOT NULL,
	`typed_count` integer DEFAULT 0 NOT NULL,
	`last_visit_time` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_urls_url_unique` ON `history_urls` (`url`);--> statement-breakpoint
CREATE TABLE `history_visits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url_id` integer NOT NULL,
	`visit_time` integer NOT NULL,
	`transition` text NOT NULL,
	`referring_visit_id` integer
);
--> statement-breakpoint
CREATE INDEX `history_visits_url` ON `history_visits` (`url_id`);--> statement-breakpoint
CREATE INDEX `history_visits_time` ON `history_visits` (`visit_time`);
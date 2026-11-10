CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`devtools_dock` text DEFAULT 'bottom' NOT NULL,
	`devtools_fraction` real DEFAULT 0.4 NOT NULL
);

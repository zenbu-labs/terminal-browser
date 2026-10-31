CREATE TABLE `extension_events` (
	`extension_id` text NOT NULL,
	`event` text NOT NULL,
	PRIMARY KEY(`extension_id`, `event`)
);
--> statement-breakpoint
CREATE TABLE `extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`version` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`disabled_reason` text,
	`pinned` integer DEFAULT false NOT NULL,
	`granted_permissions` text DEFAULT '[]' NOT NULL,
	`granted_origins` text DEFAULT '[]' NOT NULL,
	`shortcuts` text DEFAULT '{}' NOT NULL,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_update_check` integer,
	`open_panel_on_action_click` integer DEFAULT false NOT NULL,
	`user_scripts_allowed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE `downloads` ADD `by_extension_id` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `side_panel_width` real DEFAULT 360 NOT NULL;
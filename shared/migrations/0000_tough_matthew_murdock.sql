CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `instances` (
	`key` text PRIMARY KEY NOT NULL,
	`pid` integer NOT NULL,
	`tty` text,
	`socket` text NOT NULL,
	`cdp_port` integer,
	`url` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`favicon` text,
	`loading` integer DEFAULT false NOT NULL,
	`can_go_back` integer DEFAULT false NOT NULL,
	`can_go_forward` integer DEFAULT false NOT NULL,
	`find_matches` text,
	`zoom` real DEFAULT 1 NOT NULL,
	`tabs` text,
	`viewport` text,
	`started_at` integer NOT NULL
);

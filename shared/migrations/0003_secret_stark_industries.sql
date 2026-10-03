CREATE TABLE `site_permissions` (
	`origin` text NOT NULL,
	`embedder` text NOT NULL,
	`kind` text NOT NULL,
	`allowed` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`origin`, `embedder`, `kind`)
);
